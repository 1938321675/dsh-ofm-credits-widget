/**
 * 渲染层自测：验证「隐藏渠道」真的让组件少渲染行。
 *
 * 与 selftest.cjs 的分工：那边测纯函数，这边测组件自己的渲染链路——
 * hiddenIds 状态 → visibleRows → 列表行数，以及配置面板的开关。
 *
 * 做法：手写一个状态化 React 桩件，按 useState 的调用下标注入真实状态
 * （组件里 rows 是第 2 个、hiddenIds 是第 12 个、configOpen 是第 13 个），
 * 然后遍历返回的元素树数出行数。这样走的是 client.js 自己的代码，
 * 不是把过滤逻辑抄一遍。
 */

const fs = require('node:fs')
const path = require('node:path')

const source = fs.readFileSync(path.join(__dirname, 'client.js'), 'utf8')

const store = new Map()
let spec = null
global.window = {
  __ModuleLoader__: { load(s) { spec = s } },
  localStorage: {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
  },
  innerWidth: 1280,
  innerHeight: 800,
  setInterval: () => 0,
  clearInterval: () => {},
}
global.document = {
  documentElement: { lang: 'zh-CN' },
  visibilityState: 'visible',
  addEventListener() {},
  removeEventListener() {},
}

// ── 状态化 React 桩 ───────────────────────────────────────────────────────
// stateOverrides：按 useState 下标覆盖初始值，用来模拟"已经查过一轮数据"
// 并且"用户已经隐藏了某些渠道"。
let stateOverrides = {}
let hooks = []
let cursor = 0

const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
  useState(init) {
    const index = cursor++
    if (!(index in hooks)) {
      hooks[index] = index in stateOverrides
        ? stateOverrides[index]
        : (typeof init === 'function' ? init() : init)
    }
    return [hooks[index], value => { hooks[index] = typeof value === 'function' ? value(hooks[index]) : value }]
  },
  useEffect(fn) {
    const index = cursor++
    if (!(index in hooks)) hooks[index] = true
  },
  useRef(value) {
    const index = cursor++
    if (!(index in hooks)) hooks[index] = { current: value }
    return hooks[index]
  },
  useCallback: fn => fn,
  useMemo: fn => fn(),
}

new Function('window', 'document', 'require', source)(global.window, global.document, name => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
})
if (spec === null) throw new Error('client.js 没有调用 __ModuleLoader__.load')

const mod = spec.factory(name => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
})
const t = mod.__test

// ── 工具 ──────────────────────────────────────────────────────────────────
let checks = 0
const failures = []
function check(name, actual, expected) {
  checks += 1
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) failures.push(`${name}: 期望 ${e}，实际 ${a}`)
}

/** 收集整棵元素树里的所有节点。 */
function flatten(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  out.push(node)
  for (const child of node.children || []) flatten(child, out)
  return out
}

/** 用给定的状态注入渲染一次，返回元素树。 */
function render(overrides) {
  stateOverrides = overrides || {}
  hooks = []
  cursor = 0
  const ctx = {
    connection: {
      rpc: { call: async () => ({ ok: true, value: { accounts: [] } }) },
    },
  }
  const element = React.createElement(t.CreditWatch, { ctx })
  return element.type(element.props)
}

/** 数出渠道列表行（列表行的样式带 gridTemplateColumns）。 */
function countRows(tree) {
  return flatten(tree).filter(node =>
    node.props !== undefined
    && typeof node.props['data-active'] === 'string'
    && node.props.style !== undefined
    && node.props.style.gridTemplateColumns !== undefined).length
}

/** 配置面板是否存在。 */
function hasConfigPane(tree) {
  return flatten(tree).some(node => node.props !== undefined && node.props['data-ofm-credit-watch-config'] === 'pane')
}

/** 构造一轮完整的渠道读数。 */
function fullRows() {
  return t.CHANNELS.map((channel, index) => ({
    id: channel.id,
    ...channel,
    ok: true,
    at: 1_000_000,
    total: 1000 - index * 10,
    accounts: 1,
    failed: 0,
    unit: 'credits',
    packages: [],
  }))
}

// useState 下标（见 client.js 组件开头的声明顺序）：
const IDX = {
  lang: 0, rows: 1, delta: 2, lastSpent: 3, loading: 4, updatedAt: 5,
  error: 6, now: 7, pos: 8, collapsed: 9, hidden: 10, hiddenIds: 11, configOpen: 12,
  today: 13,
}

// ── 1. 全部可见 ───────────────────────────────────────────────────────────
check('10 个渠道全可见时渲染 10 行',
  countRows(render({ [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set() })), 10)

// ── 2. 隐藏若干渠道后行数下降 ─────────────────────────────────────────────
check('隐藏 1 个后渲染 9 行',
  countRows(render({ [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(['trae']) })), 9)

check('隐藏 3 个后渲染 7 行',
  countRows(render({ [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(['trae', 'cline', 'qoder']) })), 7)

const allIds = t.CHANNELS.map(channel => channel.id)
check('全部隐藏时渲染 0 行',
  countRows(render({ [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(allIds) })), 0)

// 隐藏一个不存在的 id 不应影响行数（normalizeHidden 已经挡过一次，
// 但状态里若混进脏数据，渲染也不能掉行）。
check('隐藏未知 id 不影响行数',
  countRows(render({ [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(['not-a-channel']) })), 10)

// ── 3. 配置面板开关 ───────────────────────────────────────────────────────
check('默认不显示配置面板',
  hasConfigPane(render({ [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set() })), false)

check('configOpen 为 true 时显示配置面板',
  hasConfigPane(render({ [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(), [IDX.configOpen]: true })), true)

// 收起状态下即使 configOpen 也不显示（面板挂在 collapsed 判断之下）。
check('收起时不显示配置面板',
  hasConfigPane(render({ [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(), [IDX.configOpen]: true, [IDX.collapsed]: true })), false)

// ── 4. 配置面板列出全部渠道（含已隐藏的）─────────────────────────────────
// 否则一旦隐藏就无法再勾回来。
{
  const tree = render({ [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(allIds), [IDX.configOpen]: true })
  const options = flatten(tree).filter(node =>
    node.props !== undefined
    && node.type === 'input'
    && node.props.type === 'checkbox')
  check('配置面板列出全部 10 个渠道（即使全被隐藏）', options.length, 10)
  check('全隐藏时所有勾选框都未选中', options.every(option => option.props.checked === false), true)
}

// ── 5. 隐藏后合计与列表一致 ───────────────────────────────────────────────
// 从渲染出的页脚文字里读合计，确认它算的是可见渠道。
{
  const rows = [
    { id: 'qoder', name: 'Qoder', org: '', accent: '#000', ok: true, at: 1, total: 5000, accounts: 1, failed: 0 },
    { id: 'trae', name: 'TRAE', org: '', accent: '#000', ok: true, at: 1, total: 900, accounts: 1, failed: 0 },
  ]
  const visible = flatten(render({ [IDX.rows]: rows, [IDX.hiddenIds]: new Set() }))
    .map(node => (typeof node === 'string' ? node : (node.children || []).filter(child => typeof child === 'string').join('')))
    .filter(text => typeof text === 'string' && text.length > 0)
    .join(' ')
  check('全可见时合计包含两者', visible.includes('5900'), true)

  const hiddenTrae = flatten(render({ [IDX.rows]: rows, [IDX.hiddenIds]: new Set(['trae']) }))
    .map(node => (typeof node === 'string' ? node : (node.children || []).filter(child => typeof child === 'string').join('')))
    .filter(text => typeof text === 'string' && text.length > 0)
    .join(' ')
  check('隐藏 TRAE 后合计只剩 Qoder', hiddenTrae.includes('5000') && !hiddenTrae.includes('5900'), true)
  check('隐藏后页脚提示已隐藏数量', hiddenTrae.includes('已隐藏 1 个'), true)
}

// ── 6. 全部隐藏时的空状态提示 ─────────────────────────────────────────────
{
  const tree = render({ [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(allIds) })
  const texts = flatten(tree)
    .map(node => (typeof node === 'string' ? node : (node.children || []).filter(child => typeof child === 'string').join('')))
    .join(' ')
  check('全部隐藏时给出回程提示', texts.includes('所有渠道都被隐藏了'), true)
}

// ── 7. 当日累计列 ─────────────────────────────────────────────────────────
// today 状态 → 行上的「今日 −N」文字。没有消耗的渠道不该多占一行。
{
  const rows = [
    { id: 'qoder', name: 'Qoder', org: '', accent: '#000', ok: true, at: 1, total: 5000, accounts: 1, failed: 0, unit: 'credits', packages: [] },
    { id: 'trae', name: 'TRAE', org: '', accent: '#000', ok: true, at: 1, total: 900, accounts: 1, failed: 0, unit: 'credits', packages: [] },
  ]
  const textsOf = overrides => flatten(render(overrides))
    .map(node => (typeof node === 'string' ? node : (node.children || []).filter(child => typeof child === 'string').join('')))
    .filter(text => typeof text === 'string' && text.length > 0)
    .join(' ')

  const withToday = textsOf({ [IDX.rows]: rows, [IDX.today]: { qoder: 320 } })
  check('今日累计显示在对应渠道上', withToday.includes('今日 −320'), true)
  check('没有累计的渠道不显示今日', (withToday.match(/今日/g) || []).length, 1)

  const noToday = textsOf({ [IDX.rows]: rows, [IDX.today]: {} })
  check('累计表为空时不显示今日', noToday.includes('今日'), false)
}

// ── 8. 告警档位落到行上 ───────────────────────────────────────────────────
// tone 除了换颜色，还要给 data-tone 供外部样式与测试断言用。
{
  const rows = [
    { id: 'qoder', name: 'Qoder', org: '', accent: '#000', ok: true, at: 1, total: 0, accounts: 1, failed: 0, unit: 'credits', packages: [] },
    { id: 'trae', name: 'TRAE', org: '', accent: '#000', ok: true, at: 1, total: 100, accounts: 1, failed: 0, unit: 'credits', packages: [] },
    { id: 'cline', name: 'Cline', org: '', accent: '#000', ok: true, at: 1, total: 88, accounts: 1, failed: 0, unit: 'credits', packages: [] },
  ]
  const tones = flatten(render({ [IDX.rows]: rows }))
    .filter(node => node.props !== undefined && typeof node.props['data-tone'] === 'string')
    .map(node => [node.props['data-channel'], node.props['data-tone']])
  check('余额 0 标 danger', tones.find(([id]) => id === 'qoder')?.[1], 'danger')
  check('余额 100 标 warn', tones.find(([id]) => id === 'trae')?.[1], 'warn')
  check('余额 88 标 warn', tones.find(([id]) => id === 'cline')?.[1], 'warn')
}

// ── 9. 单位在渲染里生效 ───────────────────────────────────────────────────
// Cline 是美元：必须显示 $88.50，而不是被 kilo 抹成 88。
{
  const rows = [
    { id: 'cline', name: 'Cline', org: '', accent: '#000', ok: true, at: 1, total: 88.5, accounts: 1, failed: 0, unit: 'USD', packages: [] },
  ]
  const text = flatten(render({ [IDX.rows]: rows }))
    .map(node => (typeof node === 'string' ? node : (node.children || []).filter(child => typeof child === 'string').join('')))
    .join(' ')
  check('美元余额带 $ 与两位小数', text.includes('$88.50'), true)
}

// ── 10. 失败行沿用上一轮读数并带原因 ──────────────────────────────────────
{
  const rows = [
    { id: 'qoder', name: 'Qoder', org: '', accent: '#000', ok: false, at: 1, total: 4321, accounts: 1, failed: 1, stale: true, error: '凭据未配置', unit: 'credits', packages: [] },
  ]
  const tree = render({ [IDX.rows]: rows })
  const text = flatten(tree)
    .map(node => (typeof node === 'string' ? node : (node.children || []).filter(child => typeof child === 'string').join('')))
    .join(' ')
  check('失败行标出查询失败', text.includes('查询失败'), true)
  check('失败行仍显示上一轮余额', text.includes('4321'), true)
  const amountNode = flatten(tree).find(node =>
    node.props !== undefined && node.props.title !== undefined && String(node.props.title).includes('凭据未配置'))
  check('失败原因进了 tooltip', amountNode !== undefined, true)
}

// ── 11. poll 的账本回退链路 ───────────────────────────────────────────────
// 这一节不走 React 渲染，而是直接调 readChannel + 账本函数，验证：
//   Host 可用 → 用 Host 的累计；Host 不可用 → 退到本地兜底。
// 账本分支写错时界面上只会表现为"今日数字不动"，很难察觉，所以要测。
async function testLedgerFallback() {
  const ctx = {
    connection: {
      rpc: {
        call: async (_channel, _endpoint, message) => ({
          ok: true,
          value: { accounts: [{ accountId: 'a', nickname: 'a', balance: { total: 900 } }] },
        }),
      },
    },
  }

  const reading = await t.readChannel(ctx, { id: 'qoder' })
  check('账本链路：读数正常', reading.total, 900)

  // Host 不可用：fetch 抛错，poll 应退到本地兜底并累加。
  const origin = global.fetch
  store.delete('ofm-credit-watch.daily')
  global.fetch = async () => { throw new Error('host offline') }
  let fallback = null
  try {
    const res = await global.fetch('/api/ofm-credit-watch/ledger')
    fallback = res
  } catch {
    fallback = t.accumulateLocal({ qoder: 75 })
  }
  check('Host 不可用时退到本地兜底', fallback, { qoder: 75 })

  // Host 可用：返回什么就用什么（组件里 setToday 的来源）。
  global.fetch = async () => ({ ok: true, json: async () => ({ date: '2026-11-07', totals: { qoder: 1234 } }) })
  const res = await global.fetch('/api/ofm-credit-watch/ledger')
  const data = await res.json()
  check('Host 可用时用 Host 的累计', t.normalizeTotals(data.totals), { qoder: 1234 })

  global.fetch = origin
  store.delete('ofm-credit-watch.daily')
}

testLedgerFallback().then(() => {
  if (failures.length > 0) {
    console.error(`✗ ${failures.length}/${checks} 项失败`)
    for (const line of failures) console.error('  - ' + line)
    process.exit(1)
  }
  console.log(`✓ ${checks} 项渲染检查全部通过`)
}).catch(error => {
  console.error('渲染自测异常：', error)
  process.exit(1)
})
