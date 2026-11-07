/**
 * 离线自测：验证 client.js 里不依赖 DOM 的纯逻辑。
 *
 * 用最小的 ModuleLoader / React 桩件把 client.js 载入，然后直接驱动
 * readChannel（用假的 channel-pack RPC 应答）、kilo / span 格式化，以及
 * 「本轮减上一轮」的消耗归一规则。这些是插件最容易出错、也最难在界面上
 * 一眼看出来的部分，所以单拎出来在 Node 里跑。
 */

const fs = require('node:fs')
const path = require('node:path')

const source = fs.readFileSync(path.join(__dirname, 'client.js'), 'utf8')

// ── 桩件 ──────────────────────────────────────────────────────────────────
let registered = null
global.window = {
  __ModuleLoader__: {
    load(spec) {
      registered = spec
    },
  },
  localStorage: {
    _data: new Map(),
    getItem(key) { return this._data.has(key) ? this._data.get(key) : null },
    setItem(key, value) { this._data.set(key, String(value)) },
  },
  innerWidth: 1280,
  innerHeight: 800,
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: id => clearTimeout(id),
}

/** React 桩：只为让模块顶层与组件定义能通过求值。 */
const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: value => [typeof value === 'function' ? value() : value, () => {}],
  useEffect: () => {},
  useRef: value => ({ current: value }),
  useCallback: fn => fn,
  useMemo: fn => fn(),
}
const requireStub = name => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
}

// ── 载入 ──────────────────────────────────────────────────────────────────
new Function('window', 'require', source)(global.window, requireStub)
if (registered === null) throw new Error('client.js 没有调用 __ModuleLoader__.load')

const mod = registered.factory(requireStub)
const t = mod.__test

// ── 断言工具 ──────────────────────────────────────────────────────────────
let checks = 0
const failures = []
function check(name, actual, expected) {
  checks += 1
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) failures.push(`${name}: 期望 ${e}，实际 ${a}`)
}
function checkTrue(name, value) {
  checks += 1
  if (!value) failures.push(`${name}: 期望真值，实际 ${JSON.stringify(value)}`)
}

// ── 1. 格式化 ─────────────────────────────────────────────────────────────
check('kilo(0)', t.kilo(0), '0')
check('kilo(7.5)', t.kilo(7.5), '7.5')
check('kilo(1200)', t.kilo(1200), '1200')
// 一万以下保留精确整数：差几十点就能判断够不够再跑一轮对话，缩写会掩盖掉。
check('kilo(3300)', t.kilo(3300), '3300')
// 一万以上才缩写，且不留无意义的 ".0"。
check('kilo(13000)', t.kilo(13000), '13k')
check('kilo(45000)', t.kilo(45000), '45k')
check('kilo(1200000)', t.kilo(1200000), '1.2M')
check('kilo(NaN)', t.kilo(NaN), '—')
check('kilo(null)', t.kilo(null), '—')
check('span(1000)', t.span(1000), '')
check('span(42000)', t.span(42000), '42 秒')
check('span(180000)', t.span(180000), '3 分钟')
check('fill', t.fill('{a} 个账号 / {b}', { a: 2, b: 'x' }), '2 个账号 / x')
check('fill 不吞未知占位符', t.fill('{a}-{nope}', { a: 1 }), '1-{nope}')

// ── 2. readChannel 归一 ───────────────────────────────────────────────────
// 用假的 ctx 驱动真正的 channelRpc → readChannel 链路。
function ctxWith(responses) {
  return {
    connection: {
      rpc: {
        // 实测签名（4 个实参）：('/api', 'channel-pack', message, signal)
        call: async (_channel, _endpoint, message) => {
          const provider = message.payload.provider
          const handler = responses[provider]
          if (handler === undefined) throw new Error('no stub for ' + provider)
          return handler(message)
        },
      },
    },
  }
}

async function testReadChannel() {
  // 两个账号都有余额：应求和。
  const okCtx = ctxWith({
    qoder: () => ({
      ok: true,
      value: {
        accounts: [
          { accountId: 'a', nickname: 'a', balance: { total: 100 } },
          { accountId: 'b', nickname: 'b', balance: { total: 50 } },
        ],
      },
    }),
    // 一个账号有余额、一个账号查询失败：total 只算已知的，failed 记 1。
    trae: () => ({
      ok: true,
      value: {
        accounts: [
          { accountId: 'a', nickname: 'a', balance: { total: 200 } },
          { accountId: 'b', nickname: 'b', balance: null, error: '余额查询失败' },
        ],
      },
    }),
    // 没有账号接入。
    cline: () => ({ ok: true, value: { accounts: [] } }),
    // RPC 层报错。
    zcode: () => ({ ok: false, error: { code: 'upstream', message: '网关暂不可达' } }),
  })

  const qoder = await t.readChannel(okCtx, { id: 'qoder' })
  check('qoder total', qoder.total, 150)
  check('qoder accounts', qoder.accounts, 2)
  check('qoder failed', qoder.failed, 0)

  const trae = await t.readChannel(okCtx, { id: 'trae' })
  check('trae 只算已知余额', trae.total, 200)
  check('trae failed 计数', trae.failed, 1)

  const cline = await t.readChannel(okCtx, { id: 'cline' })
  check('cline 无账号时 total 为 null', cline.total, null)
  check('cline accounts', cline.accounts, 0)

  let threw = false
  try { await t.readChannel(okCtx, { id: 'zcode' }) } catch { threw = true }
  checkTrue('zcode RPC 失败应抛出', threw)

  // 余额真的是 0 时应为 0 而不是 null（区分「没数据」与「花光了」）。
  const zeroCtx = ctxWith({ gemini: () => ({ ok: true, value: { accounts: [{ accountId: 'a', balance: { total: 0 } }] } }) })
  const gemini = await t.readChannel(zeroCtx, { id: 'gemini' })
  check('gemini 余额 0 保留为 0', gemini.total, 0)
}

// ── 2e. readChannel 附带单位与积分包明细 ──────────────────────────────────
async function testReadChannelDetail() {
  const ctx = ctxWith({
    // 明细里带 unit="USD"：应被识别成美元，而不是当成积分。
    cline: () => ({
      ok: true,
      value: {
        accounts: [{
          accountId: 'a', nickname: '主号',
          balance: {
            total: 12.5,
            packages: [{ name: 'Cline 账户余额', remaining: 12.5, total: 12.5, unit: 'USD', expiredTime: '2026-12-01T00:00:00Z' }],
          },
        }],
      },
    }),
    // 明细里没有能识别的 unit：按渠道默认（zcode → token）。
    zcode: () => ({
      ok: true,
      value: {
        accounts: [{
          accountId: 'a', nickname: '主号',
          balance: { total: 400000, packages: [{ name: '额度桶', remaining: 400000, total: 500000, unit: '渠道' }] },
        }],
      },
    }),
    // 多账号 + 明细里的空串过期时间：保留空串，不编造。
    qoder: () => ({
      ok: true,
      value: {
        accounts: [
          { accountId: 'a', nickname: '号一', balance: { total: 100, packages: [{ name: '套餐额度', remaining: 100, total: 100, unit: '积分', expiredTime: '' }] } },
          { accountId: 'b', nickname: '号二', balance: { total: 50, packages: [{ name: '资源包', remaining: 50, total: 80, unit: '积分', cycleEndTime: '2026-11-30' }] } },
        ],
      },
    }),
    // 明细里的 remaining 是脏数据：跳过该包，但总额照算。
    trae: () => ({
      ok: true,
      value: {
        accounts: [{ accountId: 'a', nickname: 'a', balance: { total: 900, packages: [{ name: '坏包', remaining: '不是数字' }] } }],
      },
    }),
  })

  const cline = await t.readChannel(ctx, { id: 'cline' })
  check('cline 单位取明细的 USD', cline.unit, 'USD')
  check('cline 积分包数量', cline.packages.length, 1)
  check('cline 积分包名', cline.packages[0].name, 'Cline 账户余额')
  check('cline 积分包过期截成日期', cline.packages[0].expireAt, '2026-12-01')

  const zcode = await t.readChannel(ctx, { id: 'zcode' })
  check('zcode 认不出明细单位时按渠道默认 token', zcode.unit, 'token')
  check('zcode 积分包 total 保留', zcode.packages[0].total, 500000)

  const qoder = await t.readChannel(ctx, { id: 'qoder' })
  check('qoder 两账号求和', qoder.total, 150)
  check('qoder 两个包都收进来', qoder.packages.length, 2)
  check('qoder 空过期时间保留空串', qoder.packages[0].expireAt, '')
  check('qoder 回退 cycleEndTime', qoder.packages[1].expireAt, '2026-11-30')
  check('qoder 包带账号归属', qoder.packages.map(p => p.account), ['号一', '号二'])

  const trae = await t.readChannel(ctx, { id: 'trae' })
  check('trae 跳过 remaining 非数字的包', trae.packages.length, 0)
  check('trae 总额不受坏包影响', trae.total, 900)
}

// ── 2f. tooltip 组成 ──────────────────────────────────────────────────────
// tooltip 是纯字符串，最容易在重构时悄悄坏掉，所以直接断言内容。
async function testTooltip() {
  const row = {
    ok: true, accounts: 2, unit: 'credits',
    packages: [
      { account: '号一', name: '套餐额度', remaining: 100, total: 100, unit: 'credits', expireAt: '' },
      { account: '号一', name: '资源包', remaining: 50, total: 80, unit: 'credits', expireAt: '2026-11-30' },
      { account: '号二', name: '空包', remaining: 0, total: 80, unit: 'credits', expireAt: '' },
    ],
  }
  const text = t.tooltipOf(row)
  checkTrue('tooltip 报账号数', text.includes('2 个账号'))
  checkTrue('tooltip 列出有余额的包', text.includes('套餐额度 100/100'))
  checkTrue('tooltip 带过期日期', text.includes('2026-11-30 过期'))
  checkTrue('tooltip 跳过余额为 0 的包', !text.includes('空包'))
  // 号二的包余额为 0，整组被跳过，连账号名都不占地方（合理：没钱就不占行）。
  checkTrue('tooltip 只列有余额的账号', text.includes('号一') && !text.includes('号二'))

  // 单账号且无明细：不该输出空行或多余内容。
  check('单账号无明细时 tooltip 为空', t.tooltipOf({ ok: true, accounts: 1, packages: [] }), '')
  // 失败行把错误原因带出来。
  check('失败行 tooltip 带原因',
    t.tooltipOf({ ok: false, accounts: 1, packages: [], error: '凭据未配置' }), '凭据未配置')
}

// ── 2b. 单位识别与格式化 ──────────────────────────────────────────────────
// channel-pack 各渠道写的 unit 标签不统一（"积分"、空串、"%"……），
// 认不出的必须归到 credits，而不是让界面显示成 undefined。
check('unitOf USD', t.unitOf('USD'), 'USD')
check('unitOf 美元', t.unitOf('美元'), 'USD')
check('unitOf token', t.unitOf('token'), 'token')
check('unitOf token 复数', t.unitOf('tokens'), 'token')
check('unitOf 百分比', t.unitOf('%'), '%')
check('unitOf 中文积分', t.unitOf('积分'), 'credits')
check('unitOf 空串', t.unitOf(''), 'credits')
check('unitOf undefined', t.unitOf(undefined), 'credits')
check('unitOf 渠道(未知)', t.unitOf('渠道'), 'credits')

check('formatAmount USD 保两位', t.formatAmount(3.47, 'USD'), '$3.47')
check('formatAmount USD 补零', t.formatAmount(3, 'USD'), '$3.00')
check('formatAmount USD 大额不缩写', t.formatAmount(1250.5, 'USD'), '$1250.50')
check('formatAmount 百分比', t.formatAmount(72.6, '%'), '73%')
check('formatAmount token 走缩写', t.formatAmount(120000, 'token'), '120k')
check('formatAmount 积分走 kilo', t.formatAmount(3300, 'credits'), '3300')
check('formatAmount NaN', t.formatAmount(NaN, 'credits'), '—')

// ── 2c. 告警档位 ──────────────────────────────────────────────────────────
// 阈值按单位分档：一万 token 只够一轮长对话，$0.5 与 500 积分才是各自的警戒线。
check('tone 0 危险', t.toneOf(0, 'credits'), 'danger')
check('tone 负数危险', t.toneOf(-5, 'credits'), 'danger')
check('tone 499 积分告警', t.toneOf(499, 'credits'), 'warn')
check('tone 500 积分正常', t.toneOf(500, 'credits'), 'ok')
check('tone 99k token 告警', t.toneOf(99_000, 'token'), 'warn')
check('tone 100k token 正常', t.toneOf(100_000, 'token'), 'ok')
check('tone 0.4 USD 告警', t.toneOf(0.4, 'USD'), 'warn')
check('tone 0.5 USD 正常', t.toneOf(0.5, 'USD'), 'ok')
check('tone 10% 告警', t.toneOf(10, '%'), 'warn')
check('tone 25% 正常', t.toneOf(25, '%'), 'ok')
check('tone 无数据 muted', t.toneOf(null, 'credits'), 'muted')
check('tone NaN muted', t.toneOf(NaN, 'credits'), 'muted')

// ── 2d. 过期时间提取 ──────────────────────────────────────────────────────
// channel-pack 只保证字段存在，空串代表"上游没给"，不能编造日期。
check('expireOf expiredTime', t.expireOf({ expiredTime: '2026-12-01T00:00:00Z' }), '2026-12-01')
check('expireOf 回退 cycleEndTime', t.expireOf({ expiredTime: '', cycleEndTime: '2026-11-20' }), '2026-11-20')
check('expireOf 全空返回空串', t.expireOf({ expiredTime: '', cycleEndTime: '' }), '')
check('expireOf 缺字段返回空串', t.expireOf({}), '')
check('expireOf null', t.expireOf(null), '')

// ── 3. 消耗差值规则 ───────────────────────────────────────────────────────
// 复刻组件里的判定：只有上一轮也报出数字、且本轮更低时才算消耗。
function spendOf(before, after) {
  if (before === undefined || after === undefined) return null
  if (!Number.isFinite(before) || !Number.isFinite(after)) return null
  if (after >= before) return null
  return before - after
}
check('正常消耗', spendOf(3000, 2870), 130)
check('领积分回升不算消耗', spendOf(2870, 3100), null)
check('余额不变不算消耗', spendOf(2870, 2870), null)
check('首轮没有基准', spendOf(undefined, 2870), null)
check('本轮失败沿用旧值不算消耗', spendOf(2870, null), null)
check('余额归零仍算消耗', spendOf(50, 0), 50)

// ── 4. 排序：活跃优先 ─────────────────────────────────────────────────────
// 复刻 ordered 的 rank + 比较规则。
const IDLE = 5 * 60_000
function order(rows, lastSpent, now) {
  const rank = row => {
    const at = lastSpent[row.id]
    if (!Number.isFinite(at)) return Number.POSITIVE_INFINITY
    const age = now - at
    return age <= IDLE ? age : Number.POSITIVE_INFINITY
  }
  return [...rows].sort((l, r) => {
    const ra = rank(l)
    const rb = rank(r)
    if (ra !== rb) return ra - rb
    const ta = Number.isFinite(l.total) ? l.total : -1
    const tb = Number.isFinite(r.total) ? r.total : -1
    if (ta !== tb) return tb - ta
    return l.name.localeCompare(r.name)
  }).map(r => r.id)
}

const now = 10_000_000
const rows = [
  { id: 'qoder', name: 'Qoder', total: 5000 },
  { id: 'trae', name: 'TRAE', total: 900 },
  { id: 'cline', name: 'Cline', total: 100 },
  { id: 'zcode', name: 'ZCode', total: null },
]
check('最近消耗的置顶', order(rows, { trae: now - 30_000, qoder: now - 200_000 }, now),
  ['trae', 'qoder', 'cline', 'zcode'])
check('都不活跃时按余额降序', order(rows, {}, now), ['qoder', 'trae', 'cline', 'zcode'])
check('超出活跃窗口后回到余额排序', order(rows, { cline: now - 10 * 60_000, qoder: now - 60_000 }, now),
  ['qoder', 'trae', 'cline', 'zcode'])

// ── 5. 渠道目录与 OFM 对齐 ────────────────────────────────────────────────
check('渠道数量', t.CHANNELS.length, 10)
check('渠道 id', t.CHANNELS.map(c => c.id),
  ['lobsterai', 'qoder', 'qodercn', 'trae', 'cline', 'loomy', 'raccoon', 'minimax', 'zcode', 'gemini'])
checkTrue('中英文案键一致', (() => {
  const zh = Object.keys(t.DICT.zh).sort()
  const en = Object.keys(t.DICT.en).sort()
  return JSON.stringify(zh) === JSON.stringify(en)
})())

// ── 6. 隐藏渠道集合 ───────────────────────────────────────────────────────
// 存储里可能残留任意垃圾：非数组、非字符串项、OFM 已删除的 id。
check('normalizeHidden 非数组 → 空', [...t.normalizeHidden('oops')], [])
check('normalizeHidden null → 空', [...t.normalizeHidden(null)], [])
check('normalizeHidden undefined → 空', [...t.normalizeHidden(undefined)], [])
check('normalizeHidden 丢掉非字符串项', [...t.normalizeHidden(['trae', 42, null, {}])], ['trae'])
check('normalizeHidden 丢掉未知渠道（OFM 删过的）', [...t.normalizeHidden(['trae', 'gone-channel'])], ['trae'])
check('normalizeHidden 去重', [...t.normalizeHidden(['trae', 'trae', 'cline'])], ['trae', 'cline'])

// 切换：新增、移除，且不改原集合。
const base = new Set(['trae'])
check('toggle 新增', [...t.toggleHidden(base, 'cline')].sort(), ['cline', 'trae'])
check('toggle 不改原集合', [...base], ['trae'])
check('toggle 移除', [...t.toggleHidden(base, 'trae')], [])
check('toggle 只移除目标', [...t.toggleHidden(new Set(['trae', 'cline']), 'trae')], ['cline'])
// 允许隐藏到空：用户可能就想让窗口让位。
check('toggle 可隐藏到空', [...t.toggleHidden(new Set(['gemini']), 'gemini')], [])

// ── 7. 合计与计数跟随可见性 ───────────────────────────────────────────────
// 复刻组件的 visibleRows → total 链路：隐藏的渠道不能计入合计，
// 否则页脚数字和列表对不上。
function totalsFor(list, hidden) {
  const visible = list.filter(row => !hidden.has(row.id))
  let sum = 0
  let seen = false
  for (const row of visible) {
    if (Number.isFinite(row.total)) { sum += row.total; seen = true }
  }
  return {
    total: seen ? sum : null,
    channels: visible.filter(row => Number.isFinite(row.total)).length,
    hiddenCount: list.length - visible.length,
  }
}
const sample = [
  { id: 'qoder', total: 5000 },
  { id: 'trae', total: 900 },
  { id: 'cline', total: null },
]
check('全可见时合计', totalsFor(sample, new Set()), { total: 5900, channels: 2, hiddenCount: 0 })
check('隐藏一个后合计下降', totalsFor(sample, new Set(['trae'])), { total: 5000, channels: 1, hiddenCount: 1 })
check('隐藏无余额的渠道不影响合计', totalsFor(sample, new Set(['cline'])), { total: 5900, channels: 2, hiddenCount: 1 })
check('全部隐藏时合计为 null', totalsFor(sample, new Set(['qoder', 'trae', 'cline'])),
  { total: null, channels: 0, hiddenCount: 3 })

// ── 8. 位置：相对右下角 ───────────────────────────────────────────────────
// 存右边距而不是绝对 left：窗口缩窄时绝对 left 会把卡片顶出屏幕。
// 宽度断言跟随插件常量，改宽度时不必改测试。
const W = 340
check('leftOf 正常解算', t.leftOf({ relRight: 16, top: 0 }, 1280, W), 1280 - W - 16)
check('leftOf 窗口刚好放下一张卡', t.leftOf({ relRight: 0, top: 0 }, W, W), 0)
check('leftOf 窗口比卡片还窄时贴左', t.leftOf({ relRight: 16, top: 0 }, 250, W), 0)
check('leftOf 视口宽度缺失时用默认值', t.leftOf({ relRight: 16, top: 0 }, undefined, W), 1280 - W - 16)
check('leftOf 面板宽度缺失时用默认值', t.leftOf({ relRight: 16, top: 0 }, 1280, 0), 1280 - W - 16)

// 旧版本存的是 {left, top}：升级后必须迁移成相对右边，否则卡片跳位置。
{
  global.window.innerWidth = 1280
  global.window.localStorage.setItem('ofm-credit-watch.position', JSON.stringify({ left: 900, top: 120 }))
  const migrated = t.loadPos()
  check('旧绝对位置迁移成右边距', migrated, { relRight: 1280 - 900 - W, top: 120 })

  global.window.localStorage.setItem('ofm-credit-watch.position', JSON.stringify({ relRight: 40, top: 60 }))
  check('新格式直接读取', t.loadPos(), { relRight: 40, top: 60 })

  global.window.localStorage.setItem('ofm-credit-watch.position', '不是 JSON')
  check('坏位置回落到默认值', t.loadPos(), { relRight: 16, top: 88 })

  global.window.localStorage.setItem('ofm-credit-watch.position', JSON.stringify({ left: -500, top: -20 }))
  const clamped = t.loadPos()
  checkTrue('迁移后不会被夹成负数', clamped.relRight >= 0 && clamped.top >= 0)
  global.window.localStorage.setItem('ofm-credit-watch.position', 'null')
}

// ── 9. 账本表的归一与本地兜底 ─────────────────────────────────────────────
check('normalizeTotals 过滤非数字', t.normalizeTotals({ a: 1, b: 'x', c: null, d: NaN }), { a: 1 })
check('normalizeTotals 空对象', t.normalizeTotals({}), {})
check('normalizeTotals null', t.normalizeTotals(null), {})
check('normalizeTotals 保留两位', t.normalizeTotals({ a: 1.23456 }), { a: 1.23 })

// 本地兜底只累加正消耗，且跨天自动重开。
{
  global.window.localStorage._data.delete('ofm-credit-watch.daily')
  const first = t.accumulateLocal({ qoder: 100, trae: 0, cline: -5 })
  check('本地兜底累加正消耗', first, { qoder: 100 })
  const second = t.accumulateLocal({ qoder: 25 })
  check('本地兜底继续累加', second.qoder, 125)

  // 把账本改成昨天：读的时候必须当作今天还没记过。
  const stale = { date: '2000-01-01', totals: { qoder: 9999 } }
  global.window.localStorage.setItem('ofm-credit-watch.daily', JSON.stringify(stale))
  check('跨天的本地账本被丢弃', t.loadLocalDaily().totals, {})
  check('跨天后 localDate 是今天', t.localDate(), t.loadLocalDaily().date)
  global.window.localStorage._data.delete('ofm-credit-watch.daily')
}

// ── 收口 ──────────────────────────────────────────────────────────────────
testReadChannel()
  .then(testReadChannelDetail)
  .then(testTooltip)
  .then(() => {
  if (failures.length > 0) {
    console.error(`✗ ${failures.length}/${checks} 项失败`)
    for (const line of failures) console.error('  - ' + line)
    process.exit(1)
  }
  console.log(`✓ ${checks} 项检查全部通过`)
}).catch(error => {
  console.error('自测异常：', error)
  process.exit(1)
})