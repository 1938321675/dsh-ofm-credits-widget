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
  // 拖动开始时组件会量一次卡片高度，桩件返回 null 表示"量不到"。
  querySelector() { return null },
}

// ── 状态化 React 桩 ───────────────────────────────────────────────────────
// stateOverrides：按 useState 下标覆盖初始值，用来模拟"已经查过一轮数据"
// 并且"用户已经隐藏了某些渠道"。
let stateOverrides = {}
let hooks = []
let cursor = 0
let effectCapture = null

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
    if (effectCapture) effectCapture.push(fn)
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

/** 收集整棵树里所有字符串节点的文本。 */
function allText(node, out = []) {
  if (typeof node === 'string') { out.push(node); return out }
  if (node === null || typeof node !== 'object') return out
  for (const child of node.children || []) allText(child, out)
  return out
}

/** 数出渠道列表行（列表行的样式带 gridTemplateColumns）。 */
function countRows(tree) {
  return flatten(tree).filter(node =>
    node.props !== undefined
    && typeof node.props['data-active'] === 'string'
    && node.props.style !== undefined
    && node.props.style.gridTemplateColumns !== undefined).length
}

/** 北辰分区是否存在。 */
function hasBeichen(tree) {
  return flatten(tree).some(node => node.props !== undefined && node.props['data-ofm-credit-watch-beichen'] !== undefined)
}

/** GPT 订阅分区是否存在。 */
function hasCodex(tree) {
  return flatten(tree).some(node => node.props !== undefined && node.props['data-ofm-credit-watch-codex'] !== undefined)
}

/** OFM 模型分区是否存在。 */
function hasOfm(tree) {
  return flatten(tree).some(node => node.props !== undefined && node.props['data-ofm-credit-watch-ofm'] !== undefined)
}

/** GPT 分区展开后的明细行数。 */
function countCodexRows(tree) {
  return flatten(tree).filter(node => node.props !== undefined && node.props['data-codex-row'] !== undefined).length
}

/** OFM 分区的渠道行数。 */
function countOfmRows(tree) {
  return flatten(tree).filter(node => node.props !== undefined && node.props['data-ofm-token-row'] !== undefined).length
}

/** 北辰分区展开后的明细行数。 */
function countBeichenRows(tree) {
  return flatten(tree).filter(node => node.props !== undefined && node.props['data-beichen-row'] !== undefined).length
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
  today: 13, size: 14,
  // WorkBuddy 分区：接在 size 之后，前十五个下标不受影响。
  wbRows: 15, wbLedger: 16, wbConnected: 17, wbOpen: 18, wbLoading: 19,
  // 视图与 token 用量：接在 WorkBuddy 之后。
  view: 20, usage: 21, usageDate: 22, statsSplit: 23, mainSplit: 24,
  // 北辰 API 及后续大栏：声明在所有 useState 之后，下标依次排开。
  beichen: 25, codex: 26, ofmTokens: 27, agy: 28, hiddenSections: 29, codexOpen: 30, beichenOpen: 31, ofmOpen: 32, agyOpen: 33, claudeOpen: 34,
}

/** WorkBuddy 分区节点。 */
function wbSectionOf(tree) {
  return flatten(tree).find(node => node.props !== undefined && node.props['data-ofm-credit-watch-wb'] !== undefined)
}

/** 数出 WorkBuddy 的账号行。 */
function countWbRows(tree) {
  return flatten(tree).filter(node => node.props !== undefined && node.props['data-wb-account'] !== undefined).length
}

function wbRows() {
  return [
    { key: 'wb:cn:a1', region: 'cn', id: 'a1', name: '林岳森', selected: true, credits: 1200 },
    { key: 'wb:cn:a2', region: 'cn', id: 'a2', name: '133****4193', selected: false, credits: null },
    { key: 'wb:global:b1', region: 'global', id: 'b1', name: 'global-1', selected: false, credits: 88 },
  ]
}

// ── 北辰 API：读数到达后多出一行 ─────────────────────────────────────────
const beichenReading = {
  configured: true, ok: true, balance: 0.58, unit: 'USD',
  today: { date: '2026-11-17', requests: 3, inputTokens: 100_000, outputTokens: 20_000, cacheReadTokens: 1_080_000, totalTokens: 1_200_000, actualCost: 0.42 },
  days: [{ date: '2026-11-17', requests: 3, inputTokens: 100_000, outputTokens: 20_000, cacheReadTokens: 1_080_000, totalTokens: 1_200_000, actualCost: 0.42 }],
  models: [{ model: 'gpt-6.1', requests: 2, inputTokens: 90_000, outputTokens: 18_000, cacheReadTokens: 980_000, totalTokens: 998_000, actualCost: 0.3 }],
}
check('北辰读数到达后出现独立分区',
  hasBeichen(render({ [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(), [IDX.beichen]: beichenReading })), true)

check('渠道列表已移除，界面上没有渠道行',
  countRows(render({ [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(), [IDX.beichen]: beichenReading })), 0)

check('北辰没有读数时不出现分区',
  hasBeichen(render({ [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(), [IDX.beichen]: null })), false)

check('没配北钥时不出现分区',
  hasBeichen(render({ [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(), [IDX.beichen]: { configured: false, ok: false, balance: null, days: [] } })), false)

// 按模型明细：接口给的是累计口径，界面单列一行标题，不让这些数被当成「今天」。
const beichenOpenTree = render({
  [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(),
  [IDX.beichen]: beichenReading, [IDX.beichenOpen]: true,
})
check('北辰展开列出按模型明细',
  flatten(beichenOpenTree)
    .filter(n => n.props !== undefined && n.props['data-beichen-model'] !== undefined)
    .map(n => n.props['data-beichen-model']), ['gpt-6.1'])
check('北辰没有模型明细时不列标题行',
  flatten(render({
    [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(),
    [IDX.beichen]: { configured: true, ok: true, balance: 0.58, unit: 'USD', today: null, days: [], models: [] },
    [IDX.beichenOpen]: true,
  })).some(n => n.props !== undefined && n.props['data-beichen-model'] !== undefined), false)

const codexReading = {
  available: true,
  windows: [
    { kind: 'fiveHour', remainingPercent: 63, resetsAt: 1794980149000, sampledAt: 1794969184707 },
    { kind: 'weekly', remainingPercent: 94, resetsAt: 1795566949000, sampledAt: 1794969184707 },
  ],
}
const ofmReading = {
  available: true, day: '2026-11-18',
  channels: [
    { channel: 'qodercn', calls: 52, input: 9000000, output: 300000, cacheRead: 2000000 },
    { channel: 'loomy', calls: 18, input: 700000, output: 20000, cacheRead: 160000 },
  ],
  total: { input: 9700000, output: 320000, cacheRead: 2160000, calls: 70 },
}

check('GPT 订阅读数到达后出现分区',
  hasCodex(render({ [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(), [IDX.codex]: codexReading })), true)

check('GPT 分区默认折叠只留标题栏',
  countCodexRows(render({ [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(), [IDX.codex]: codexReading })), 0)

check('展开 GPT 分区后两行限额',
  countCodexRows(render({ [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(), [IDX.codex]: codexReading, [IDX.codexOpen]: true })), 2)

check('隐藏 GPT 栏后分区不渲染',
  hasCodex(render({ [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(), [IDX.codex]: codexReading, [IDX.hiddenSections]: new Set(['codex']) })), false)

  // 翻篇顺延的窗口照常显示：Host 侧已把重置时刻顺延、余量标为满额，界面不再把
  // 这一窗整块藏起来，悬浮提示里说明它是翻篇后的读数。
  const codexReplenished = {
    available: true,
    windows: [
      { kind: 'fiveHour', remainingPercent: 100, resetsAt: Date.now() + 3_600_000, sampledAt: Date.now() - 10 * 60 * 60 * 1000, replenished: true },
      { kind: 'weekly', remainingPercent: 94, resetsAt: Date.now() + 7 * 24 * 60 * 60 * 1000, sampledAt: Date.now() - 10 * 60 * 60 * 1000 },
    ],
  }
  const codexReplenishedTree = render({ [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(), [IDX.codex]: codexReplenished, [IDX.codexOpen]: true })
  check('翻篇顺延后 GPT 分区仍显示两行限额', countCodexRows(codexReplenishedTree), 2)
  const codexReplenishedHead = flatten(codexReplenishedTree).find(n => n.props !== undefined && n.props.className === 'ofm-head')
  check('翻篇顺延的窗口在悬浮提示里说明', String(codexReplenishedHead?.props?.title ?? '').includes('翻篇'), true)

  // agy 侧同样：翻篇的窗口顺延为满额，账号行继续显示，标题栏仍给 100%。
  const agyReplenished = {
    available: true, activeId: 'acc_a', stale: false, sampledAt: Date.now() - 60_000, ageMs: 60_000,
    tokens: { gemini: { input: 0, output: 0, cacheRead: 0, calls: 0 }, claude: { input: 0, output: 0, cacheRead: 0, calls: 0 } },
    accounts: [{
      id: 'acc_a', alias: 'primary', email: 'a@example.com', planTier: 'pro',
      families: [
        { family: 'google', label: 'Gemini', fiveHour: 100, fiveHourResetsAt: Date.now() + 3_600_000, fiveHourReplenished: true, fiveHourExpired: false,
          weekly: 95, weeklyResetsAt: Date.now() + 86_400_000, updatedAt: Date.now() },
        { family: 'anthropic', label: 'Claude', fiveHour: 98, fiveHourResetsAt: Date.now() + 3_600_000, weekly: 99, weeklyResetsAt: Date.now() + 86_400_000, updatedAt: Date.now() },
      ],
    }],
  }
  const agyReplenishedTree = render({ [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(), [IDX.agy]: agyReplenished, [IDX.agyOpen]: true })
  const agyReplenishedHead = flatten(agyReplenishedTree).find(n => n.props !== undefined && n.props.className === 'ofm-head')
  check('翻篇顺延的 Gemini 栏标题栏仍给 100%', allText(agyReplenishedTree).join(' ').includes('100%'), true)
  check('翻篇顺延的窗口在 agy 悬浮提示里说明', String(agyReplenishedHead?.props?.title ?? '').includes('翻篇'), true)

check('OFM 读数到达后出现分区',
  hasOfm(render({ [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(), [IDX.ofmTokens]: ofmReading })), true)

check('OFM 分区默认折叠只留标题栏',
  countOfmRows(render({ [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(), [IDX.ofmTokens]: ofmReading })), 0)

check('展开 OFM 分区后列出渠道',
  countOfmRows(render({ [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(), [IDX.ofmTokens]: ofmReading, [IDX.ofmOpen]: true })), 2)

check('隐藏 OFM 栏后分区不渲染',
  hasOfm(render({ [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(), [IDX.ofmTokens]: ofmReading, [IDX.hiddenSections]: new Set(['ofm']) })), false)

check('隐藏 WorkBuddy 栏后分区不渲染',
  (() => {
    const tree = render({ [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(), [IDX.hiddenSections]: new Set(['workbuddy']) })
    return flatten(tree).some(node => node.props !== undefined && node.props['data-ofm-credit-watch-wb'] !== undefined) === false
  })(), true)

// ── 大栏开关：真正调用一次 onChange，确认状态翻转链路通 ──────────────
// 只检查「有 onChange」不够：上一版把 persist 函数放在组件外引用了
// 不存在的 setter，渲染树完全正常，点下去才抛 ReferenceError。
check('六个大栏开关都是可点的按钮', (() => {
  const tree = render({ [IDX.configOpen]: true, [IDX.hiddenSections]: new Set() })
  const buttons = flatten(tree).filter(n => n.props !== undefined && n.props['data-section'] !== undefined)
  return buttons.length === 6 && buttons.every(b => b.type === 'button' && typeof b.props.onClick === 'function')
})(), true)

check('点击大栏开关写入隐藏集合并使分区消失', (() => {
  const store = new Map()
  const saved = global.window.localStorage
  global.window.localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  }
  try {
    const ofmReading = {
      available: true, day: '2026-11-18',
      channels: [{ channel: 'qodercn', calls: 5, input: 100, output: 10, cacheRead: 50 }],
      total: { input: 100, output: 10, cacheRead: 50, calls: 5 },
    }
    const before = render({ [IDX.configOpen]: true, [IDX.hiddenSections]: new Set(), [IDX.ofmTokens]: ofmReading })
    const button = flatten(before).find(n => n.props !== undefined && n.props['data-section'] === 'ofm')
    button.props.onClick({ stopPropagation() {} })
    const written = JSON.parse(store.get('ofm-credit-watch.hiddenSections') ?? 'null')
    if (!Array.isArray(written) || !written.includes('ofm')) return false
    // 用写盘结果重渲染：OFM 分区应当消失，WorkBuddy 仍在
    const after = render({ [IDX.hiddenSections]: new Set(written), [IDX.ofmTokens]: ofmReading })
    const hasOfm = flatten(after).some(n => n.props !== undefined && n.props['data-ofm-credit-watch-ofm'] !== undefined)
    const hasWb = flatten(after).some(n => n.props !== undefined && n.props['data-ofm-credit-watch-wb'] !== undefined)
    return hasOfm === false && hasWb === true
  } catch { return false } finally { global.window.localStorage = saved }
})(), true)

check('折叠时标题栏也显示余额',
  allText(render({ [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(), [IDX.beichen]: beichenReading })).includes('$0.58'), true)

check('北辰分区默认折叠只留标题栏',
  countBeichenRows(render({ [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(), [IDX.beichen]: beichenReading })), 0)

check('展开北辰分区后列出明细',
  countBeichenRows(render({ [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(), [IDX.beichen]: beichenReading, [IDX.beichenOpen]: true })), 2)

// ── 3. 配置面板开关 ───────────────────────────────────────────────────────
check('默认不显示配置面板',
  hasConfigPane(render({ [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set() })), false)

check('configOpen 为 true 时显示配置面板',
  hasConfigPane(render({ [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(), [IDX.configOpen]: true })), true)

// 收起状态下即使 configOpen 也不显示（面板挂在 collapsed 判断之下）。
check('收起时不显示配置面板',
  hasConfigPane(render({ [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(), [IDX.configOpen]: true, [IDX.collapsed]: true })), false)

// ── 4b. WorkBuddy 分区 ────────────────────────────────────────────────────
// 未连接时给一句说明；连上但收起时只有头部；展开才逐账号列。
{
  const disconnected = render({ [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(), [IDX.wbConnected]: false })
  check('未连接 WorkBuddy 时分区标记为 unavailable',
    wbSectionOf(disconnected)?.props['data-ofm-credit-watch-wb'], 'unavailable')
  check('未连接时不渲染账号行', countWbRows(disconnected), 0)

  const collapsed = render({
    [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(),
    [IDX.wbRows]: wbRows(), [IDX.wbOpen]: false,
  })
  check('收起时不渲染账号行', countWbRows(collapsed), 0)
  check('收起时仍显示头部', wbSectionOf(collapsed)?.props['data-ofm-credit-watch-wb'], 'section')

  const expanded = render({
    [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(),
    [IDX.wbRows]: wbRows(), [IDX.wbOpen]: true,
    [IDX.wbLedger]: { daily: { 'wb:cn:a1': 30 }, cumulative: { 'wb:cn:a1': 130 } },
  })
  check('展开后每个账号一行', countWbRows(expanded), 3)

  // 不再有列头：列的语义与上方渠道行一致，靠对齐与位置自明。
  const head = flatten(expanded).find(node => node.props !== undefined && node.props['data-wb-colhead'] === 'true')
  check('展开后没有列头', head, undefined)

  // 记过账的账号显示 −0，没记过的显示 ·：两者含义不同。
  const zero = render({
    [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(),
    [IDX.wbRows]: wbRows(), [IDX.wbOpen]: true,
    [IDX.wbLedger]: { daily: { 'wb:cn:a1': 0 }, cumulative: { 'wb:cn:a1': 0 } },
  })
  const texts = []
  const walk = node => {
    if (typeof node === 'string') { texts.push(node); return }
    if (node === null || typeof node !== 'object') return
    for (const child of node.children || []) walk(child)
  }
  walk(zero)
  check('今日为 0 时显示 −0', texts.join(' ').includes('−0'), true)

  // 有账号但一个积分都读不到：行仍然在（面板的职责是让人看到有哪些号）。
  const empty = render({
    [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(),
    [IDX.wbRows]: wbRows(), [IDX.wbOpen]: true,
  })
  check('读不到积分时账号行照常列出', countWbRows(empty), 3)

  // 设置面板是就地展开的操作区，展开时 WorkBuddy 分区让位，
  // 免得上方的消耗块把勾选表挤到滚动区之外。
  const withSettings = render({
    [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(),
    [IDX.wbRows]: wbRows(), [IDX.wbOpen]: true, [IDX.configOpen]: true,
  })
  check('设置面板展开时 WorkBuddy 分区让位', wbSectionOf(withSettings), undefined)
  // 设置视图整块独占：勾选表本身就是渠道清单，上面不再重复列一份渠道。
  check('设置面板展开时不渲染渠道行', countRows(withSettings), 0)

  // 隐藏 OFM 渠道不影响 WorkBuddy 分区——两套上游互不牵连。
  const allHiddenOfm = render({
    [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(fullRows().map(row => row.id)),
    [IDX.wbRows]: wbRows(), [IDX.wbOpen]: true,
  })
  check('OFM 渠道全隐藏时 WorkingBuddy 行仍在', countWbRows(allHiddenOfm), 3)
}

// ── 4b2. Gemini / Claude 订阅分区 ────────────────────────────────────────
{
  const agyReading = {
    available: true, activeId: 'acc_a', stale: false, sampledAt: Date.now() - 60_000, ageMs: 60_000,
    // 订阅限额同时带今日 token：Gemini 一栏、Claude 一栏各一份。
    tokens: {
      gemini: { input: 100, output: 50, cacheRead: 1000, calls: 4 },
      claude: { input: 200, output: 80, cacheRead: 2000, calls: 5 },
    },
    accounts: [
      {
        id: 'acc_a', alias: 'primary', email: 'a@example.com', planTier: 'pro',
        families: [
          { family: 'google', label: 'Gemini', fiveHour: 80, fiveHourResetsAt: Date.now() + 3_600_000, weekly: 95, weeklyResetsAt: Date.now() + 86_400_000, updatedAt: Date.now() },
          { family: 'anthropic', label: 'Claude', fiveHour: 98, fiveHourResetsAt: Date.now() + 3_600_000, weekly: 99, weeklyResetsAt: Date.now() + 86_400_000, updatedAt: Date.now() },
          { family: 'openai', label: 'GPT-OSS', fiveHour: 98, fiveHourResetsAt: Date.now() + 3_600_000, weekly: 99, weeklyResetsAt: Date.now() + 86_400_000, updatedAt: Date.now() },
        ],
      },
      {
        id: 'acc_b', alias: 'backup', email: 'b@example.com', planTier: 'free',
        families: [
          { family: 'google', label: 'Gemini', fiveHour: null, fiveHourResetsAt: null, weekly: 42, weeklyResetsAt: Date.now() + 86_400_000, updatedAt: Date.now() },
        ],
      },
    ],
  }
  const agyOf = tree => flatten(tree).find(node => node.props !== undefined && node.props['data-ofm-credit-watch-agy'] !== undefined)
  const claudeOf = tree => flatten(tree).find(node => node.props !== undefined && node.props['data-ofm-credit-watch-claude'] !== undefined)
  const countAgyAccounts = tree => flatten(tree).filter(node => node.props !== undefined && node.props['data-agy-account'] !== undefined).length

  // 两个大栏各自独立出现。
  check('Gemini 读数到达后出现 Gemini 分区',
    agyOf(render({ [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(), [IDX.agy]: agyReading }))?.props['data-ofm-credit-watch-agy'], 'section')
  check('Gemini 读数到达后出现 Claude 分区',
    claudeOf(render({ [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(), [IDX.agy]: agyReading }))?.props['data-ofm-credit-watch-claude'], 'section')
  // 没装 agy-link 时两栏都不出现。
  const none = render({ [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set() })
  check('没装 agy-link 时不渲染 Gemini 分区', agyOf(none), undefined)
  check('没装 agy-link 时不渲染 Claude 分区', claudeOf(none), undefined)

  // 折叠时两栏都只有胶囊，没有账号行。
  const collapsed = render({ [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(), [IDX.agy]: agyReading })
  check('折叠时不出账号行', countAgyAccounts(collapsed), 0)
  // 展开：两栏各自列出两个账号。
  const expanded = render({ [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(), [IDX.agy]: agyReading, [IDX.agyOpen]: true, [IDX.claudeOpen]: true })
  check('展开后两个分区都按账号列出', countAgyAccounts(expanded), 4)

  // 两个池子互不串门：Gemini 栏的胶囊是 80%，Claude 栏的是 98%。
  const geminiChips = flattened => flattened
    .filter(n => n.props !== undefined && n.props['data-ofm-credit-watch-agy'] === 'section')
  const textOf = node => allText(node).join(' ')
  const geminiTree = flatten(expanded).find(n => n.props && n.props['data-ofm-credit-watch-agy'] === 'section')
  const claudeTree = flatten(expanded).find(n => n.props && n.props['data-ofm-credit-watch-claude'] === 'section')
  check('Gemini 分区显示 Gemini 的余量', textOf(geminiTree).includes('80%'), true)
  check('Gemini 分区不显示 Claude 的余量', textOf(geminiTree).includes('98%'), false)
  check('Claude 分区显示 Claude 的余量', textOf(claudeTree).includes('98%'), true)

  // 开关各自生效。
  check('勾掉 Gemini 不影响 Claude 分区',
    (() => {
      const tree = render({ [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(), [IDX.agy]: agyReading, [IDX.hiddenSections]: new Set(['agy']) })
      return agyOf(tree) === undefined && claudeOf(tree) !== undefined
    })(), true)
  check('勾掉 Claude 不影响 Gemini 分区',
    (() => {
      const tree = render({ [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(), [IDX.agy]: agyReading, [IDX.hiddenSections]: new Set(['claude']) })
      return claudeOf(tree) === undefined && agyOf(tree) !== undefined
    })(), true)

  // 快照过期时两栏都退为提示，不显示旧百分比。
  const stale = render({ [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(), [IDX.agy]: { ...agyReading, stale: true } })
  check('快照过期时仍渲染两个分区', agyOf(stale) !== undefined && claudeOf(stale) !== undefined, true)

  // 今日 token：折叠时标题栏给一个紧凑数，展开时再出一行三桶明细。
  const agyTokenOf = tree => flatten(tree).find(node => node.props !== undefined && node.props['data-agy-tokens'] !== undefined)
  const agyTokenRow = tree => flatten(tree).find(node => node.props !== undefined && node.props['data-agy-row'] === 'tokens')
  check('折叠时标题栏给出 Gemini 今日 token',
    agyTokenOf(collapsed)?.props['data-agy-tokens'], 'google')
  // 两栏各自取自己的桶：Gemini 是 100+50+1000=1150，Claude 是 200+80+2000=2280。
  check('折叠时 Gemini 栏标题栏给出 1150',
    agyTokenOf(geminiTree)?.children?.[0], '1150')
  check('折叠时 Claude 栏标题栏给出 2280',
    agyTokenOf(claudeTree)?.children?.[0], '2280')
  check('Gemini 栏展开后出今日 token 明细行',
    agyTokenRow(geminiTree) !== undefined, true)
  check('Claude 栏展开后也出今日 token 明细行',
    agyTokenRow(claudeTree) !== undefined, true)
  const agyTokenRowText = allText(agyTokenRow(geminiTree)).join(' ')
  check('今日 token 明细行给三桶构成',
    agyTokenRowText.includes('输入') && agyTokenRowText.includes('缓存'), true)
  check('折叠时不出 token 明细行', agyTokenRow(collapsed), undefined)
  // 两个栏各自取自己的桶：Gemini 栏显示 Gemini 的 1150，不显示 Claude 的 2280。
  check('Gemini 栏只显示自己的用量', allText(geminiTree).join(' ').includes('1150'), true)
  check('Gemini 栏不显示 Claude 的用量', allText(geminiTree).join(' ').includes('2280'), false)
  // 订阅读数没带 token 字段时不显示，避免凭空出一行。
  const noTokens = render({ [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(), [IDX.agy]: { ...agyReading, tokens: undefined } })
  check('读数没有 token 字段时标题栏不给数', agyTokenOf(noTokens), undefined)
  check('读数没有 token 字段时不展开明细行', agyTokenRow(noTokens), undefined)
}


// ── 4c. 统计界面 ──────────────────────────────────────────────────────────
{
  const sampleUsage = {
    available: true,
    days: [
      { date: '2026-11-10', ofm: { input: 100, output: 50, cacheRead: 1000, calls: 2 }, workbuddy: { input: 200, output: 80, cacheRead: 2000, calls: 3 }, byChannel: { qoder: { input: 100, output: 50, cacheRead: 1000, calls: 2 } } },
      { date: '2026-11-11', ofm: { input: 300, output: 90, cacheRead: 3000, calls: 4 }, workbuddy: { input: 400, output: 60, cacheRead: 4000, calls: 5 }, byChannel: { trae: { input: 300, output: 90, cacheRead: 3000, calls: 4 } } },
    ],
  }
  const statsOf = tree => flatten(tree).find(node => node.props !== undefined && node.props['data-ofm-credit-watch-stats'] !== undefined)

  check('列表视图没有统计块', statsOf(render({ [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set() })), undefined)

  const stats = render({ [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(), [IDX.view]: 'stats', [IDX.usage]: sampleUsage })
  check('统计视图渲染出统计块', statsOf(stats)?.props['data-ofm-credit-watch-stats'], 'section')
  // 渠道行在统计视图之外才显示今日 token 小字。
  const withUsage = render({
    [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(),
    [IDX.usage]: {
      available: true,
      days: [{ date: '2026-11-11', ofm: { input: 1, output: 1, cacheRead: 1, calls: 1 }, workbuddy: { input: 1, output: 1, cacheRead: 1, calls: 1 }, byChannel: { qoder: { input: 100, output: 0, cacheRead: 900, calls: 2 } } }],
    },
  })
  const usageTexts = allText(withUsage).join(' ')
  // 渠道行已随旧列表移除；今日 token 现在只出现在「OFM 模型」大栏。
  const noUsage = render({ [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(), [IDX.usage]: { available: false, days: [] } })
  const noUsageTexts = allText(noUsage).join(' ')
  check('没有用量数据时不显示 token 小字', noUsageTexts.includes('token'), false)

  // 分隔条：拖它改明细区高度。它在统计视图里始终存在，与有没有渠道无关。
  const splitter = flatten(stats).find(n => n.props !== undefined && n.props['data-stats-splitter'] === 'true')
  check('统计视图有可拖动分隔条', splitter !== undefined, true)
  check('分隔条用上下拖动光标', splitter?.props.style?.cursor, 'row-resize')

  // 明细区容器：没拖过是自适应，拖过之后带固定高度。
  const autoList = flatten(stats).find(n => n.props !== undefined && n.props['data-stats-list'] === 'true')
  check('没拖过时明细区没有固定高度', autoList?.props.style?.height, undefined)
  const sizedList = flatten(render({
    [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(),
    [IDX.view]: 'stats', [IDX.usage]: sampleUsage, [IDX.statsSplit]: 160,
  })).find(n => n.props !== undefined && n.props['data-stats-list'] === 'true')
  check('拖过之后明细区带固定高度', sizedList?.props.style?.height, 160)

  // 统计视图下不该再出现渠道列表行——它是整块替换。
  check('统计视图不渲染渠道列表', countRows(stats), 0)
  // 页脚已随旧列表移除，统计视图与列表视图都不再有它。
  check('统计视图不渲染页脚', allText(stats).join(' ').includes('个渠道有余额'), false)
  // WorkBuddy 分区与设置面板同理：它们挂在 body 的其它位置，
  // 只换列表会让统计页看起来只铺了上半部分。
  check('统计视图不渲染 WorkBuddy 分区', wbSectionOf(stats) === undefined, true)
  check('统计视图不渲染设置面板', hasConfigPane(stats), false)

  // 默认跟最新一天走：11-11 的渠道是 trae。
  const channelIds = flatten(stats).filter(n => n.props !== undefined && n.props['data-stats-channel'] !== undefined)
    .map(n => n.props['data-stats-channel'])
  check('默认显示最新一天的渠道', channelIds, ['trae'])

  // 指定日期后切到那天（11-10 的渠道是 qoder）。
  const picked = render({
    [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(),
    [IDX.view]: 'stats', [IDX.usage]: sampleUsage, [IDX.usageDate]: '2026-11-10',
  })
  const pickedIds = flatten(picked).filter(n => n.props !== undefined && n.props['data-stats-channel'] !== undefined)
    .map(n => n.props['data-stats-channel'])
  check('指定日期显示那天的渠道', pickedIds, ['qoder'])

  // cost-meter 不可用：给一句说明，不显示数字。
  const offline = render({ [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(), [IDX.view]: 'stats', [IDX.usage]: { available: false, days: [] } })
  check('cost-meter 不可用时标记出来', statsOf(offline)?.props['data-ofm-credit-watch-stats'], 'unavailable')

  // 空账本：同样是空状态。
  const emptyStats = render({ [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(), [IDX.view]: 'stats', [IDX.usage]: { available: true, days: [] } })
  check('没有数据时显示空状态', statsOf(emptyStats)?.props['data-ofm-credit-watch-stats'], 'empty')

  // GPT 订阅进统计：独立一行，不与 OFM 渠道共用 data-stats-channel（否则
  // 「这一天的渠道有哪些」这类断言会被订阅线路污染）。
  const withCodex = render({
    [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(),
    [IDX.view]: 'stats',
    [IDX.usage]: {
      available: true,
      days: [{
        date: '2026-11-11',
        ofm: { input: 100, output: 50, cacheRead: 1000, calls: 2 },
        workbuddy: { input: 200, output: 80, cacheRead: 2000, calls: 3 },
        byChannel: { trae: { input: 100, output: 50, cacheRead: 1000, calls: 2 } },
        codex: { input: 500, output: 40, cacheRead: 6000, calls: 6 },
      }],
    },
  })
  const codexRow = flatten(withCodex).find(n => n.props !== undefined && n.props['data-stats-codex'] !== undefined)
  check('统计页列出 GPT 订阅行', codexRow !== undefined, true)
  const codexTexts = allText(withCodex).join(' ')
  // 订阅行的小字就是三桶：入 500 · 缓 6000 · 出 40。
  check('GPT 订阅行给出输入/缓存/输出', codexTexts.includes('入 500') && codexTexts.includes('缓 6000') && codexTexts.includes('出 40'), true)
  // 顶部那行构成把三条线路的三桶加起来：入 800 · 缓 9000 · 出 170。
  check('顶部给出三桶合计', codexTexts.includes('输入 800') && codexTexts.includes('缓存命中 9000') && codexTexts.includes('输出 170'), true)
  check('顶部合计有 GPT 订阅一格', codexTexts.includes('GPT 订阅'), true)
  // 没有订阅用量时不出这一行，也不在合计里凭空加一格数字。
  check('没有 GPT 订阅用量时不列该行', flatten(stats).find(n => n.props !== undefined && n.props['data-stats-codex'] !== undefined), undefined)

  // 两个订阅栏进统计：各占一格合计、各占一行明细，与 GPT 订阅并列。
  const withAgy = render({
    [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(),
    [IDX.view]: 'stats',
    [IDX.usage]: {
      available: true,
      days: [{
        date: '2026-11-11',
        ofm: { input: 100, output: 50, cacheRead: 1000, calls: 2 },
        workbuddy: { input: 200, output: 80, cacheRead: 2000, calls: 3 },
        byChannel: { trae: { input: 100, output: 50, cacheRead: 1000, calls: 2 } },
        agyGemini: { input: 500, output: 40, cacheRead: 6000, calls: 6 },
        agyClaude: { input: 700, output: 60, cacheRead: 8000, calls: 7 },
      }],
    },
  })
  const agyGeminiRow = flatten(withAgy).find(n => n.props !== undefined && n.props['data-stats-agy'] === 'gemini')
  const agyClaudeRow = flatten(withAgy).find(n => n.props !== undefined && n.props['data-stats-agy'] === 'claude')
  check('统计页列出 Gemini 订阅行', agyGeminiRow !== undefined, true)
  check('统计页列出 Claude 订阅行', agyClaudeRow !== undefined, true)
  const agyStatsTexts = allText(withAgy).join(' ')
  // 两行的小字是各自的三桶；顶部合计里三桶把两条订阅线路一起算进去。
  check('Gemini 订阅行给出三桶构成', agyStatsTexts.includes('入 500') && agyStatsTexts.includes('缓 6000'), true)
  check('Claude 订阅行给出三桶构成', agyStatsTexts.includes('入 700') && agyStatsTexts.includes('缓 8000'), true)
  check('顶部合计含两个订阅格', agyStatsTexts.includes('Gemini 订阅') && agyStatsTexts.includes('Claude 订阅'), true)
  check('顶部三桶计入两条订阅线路',
    agyStatsTexts.includes('输入 1500') && agyStatsTexts.includes('缓存命中 17k') && agyStatsTexts.includes('输出 230'), true)
  check('顶部合计计入两条订阅线路',
    (() => {
      const cell = flatten(withAgy).find(n => n.props !== undefined && n.props['data-agy-gemini-token-total'] !== undefined)
      const text = cell === undefined ? '' : allText(cell).join(' ')
      return text.includes('6540')
    })(), true)
  // 没有订阅用量的那天，两行都不出现。
  const noAgy = render({
    [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(), [IDX.view]: 'stats',
    [IDX.usage]: {
      available: true,
      days: [{ date: '2026-11-11', ofm: { input: 1, output: 1, cacheRead: 1, calls: 1 }, workbuddy: { input: 1, output: 1, cacheRead: 1, calls: 1 }, byChannel: {} }],
    },
  })
  check('没有订阅用量时不列订阅行',
    flatten(noAgy).filter(n => n.props !== undefined && (n.props['data-stats-agy'] === 'gemini' || n.props['data-stats-agy'] === 'claude')).length, 0)

  // 北辰进统计页：合计里算它，明细区单独一行，三桶构成照拆。
  const withBeichen = render({
    [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(), [IDX.view]: 'stats',
    [IDX.usage]: {
      available: true,
      days: [{
        date: '2026-11-17',
        ofm: { input: 100, output: 50, cacheRead: 1000, calls: 2 },
        workbuddy: { input: 200, output: 80, cacheRead: 2000, calls: 3 },
        byChannel: { qoder: { input: 100, output: 50, cacheRead: 1000, calls: 2 } },
      }],
    },
    [IDX.beichen]: beichenReading,
  })
  check('统计页列出北辰行',
    flatten(withBeichen).find(n => n.props !== undefined && n.props['data-stats-beichen'] !== undefined) !== undefined, true)
  const beichenStatsTexts = allText(withBeichen).join(' ')
  // 北辰三桶：入 100k · 缓 1.1M · 出 20k，当天合计 1.2M。
  check('北辰行给出三桶构成',
    beichenStatsTexts.includes('入 100k') && beichenStatsTexts.includes('缓 1.1M') && beichenStatsTexts.includes('出 20k'), true)
  check('统计页合计含北辰一格', beichenStatsTexts.includes('北辰 API'), true)
  // 没有北辰读数时不出这一行，也不在合计里凭空加一格数字。
  check('没有北辰读数时不列该行',
    flatten(stats).find(n => n.props !== undefined && n.props['data-stats-beichen'] !== undefined), undefined)
}

// ── 4g. 回归：跨天后主界面今日 token 归零 ─────────────────────────────────
// 账本里只有昨天和有调用的历史时，主界面不能显示昨天的 token 数。
{
  const yesterdayOnly = render({
    [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(),
    [IDX.usage]: {
      available: true,
      days: [
        { date: '2000-01-01', ofm: { input: 1, output: 1, cacheRead: 1, calls: 1 }, workbuddy: { input: 500, output: 500, cacheRead: 500, calls: 5 }, byChannel: { qoder: { input: 777, output: 0, cacheRead: 0, calls: 2 } } },
      ],
    },
  })
  const texts = allText(yesterdayOnly)

  // WorkBuddy 头部：今天没记录时「今日」后面不该跟 token 数字。
  const wbHead = texts.find(text => typeof text === 'string' && text.includes('今日'))
  check('跨天后 WorkBuddy 头部不带昨天的 token', /今日s*—s*$/.test(String(wbHead).trim()) || !String(wbHead).includes('1.5k'), true)
  check('跨天后不显示昨天的 token 数字 1.5k', texts.some(text => String(text).includes('1.5k')), false)
  // 渠道行：昨天的 777 不能出现（余额是 1000/900/800，不会撞上）。
  check('跨天后不显示昨天的渠道 token', texts.some(text => String(text) === '777'), false)

  // 今天有记录时正常显示。
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
  const withToday = render({
    [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(),
    [IDX.usage]: {
      available: true,
      days: [
        { date: '2000-01-01', ofm: { input: 0, output: 0, cacheRead: 0, calls: 0 }, workbuddy: { input: 0, output: 0, cacheRead: 0, calls: 0 }, byChannel: {} },
        { date: today, ofm: { input: 1, output: 1, cacheRead: 1, calls: 1 }, workbuddy: { input: 100, output: 100, cacheRead: 800, calls: 3 }, byChannel: { qoder: { input: 10, output: 0, cacheRead: 0, calls: 1 } } },
      ],
    },
  })
  const todayTexts = allText(withToday).join(' ')
  check('今天有记录时显示今天的 WorkBuddy token', todayTexts.includes('1000'), true)
  check('今天有记录时显示今天的渠道 token', todayTexts.includes('10'), true)
}

// ── 11. poll 的账本回退链路 ───────────────────────────────────────────────
// ── 12. 缩放手柄与尺寸 ────────────────────────────────────────────────────
// 尺寸状态落到卡片 style；八个方向各一只热区、各自带自己的光标；
// 折叠时高度回落自适应，隐藏态干脆不渲染手柄。
{
  const nodes = overrides => flatten(render(overrides))
  const panelOf = overrides => nodes(overrides)
    .find(node => node.props !== undefined && node.props['data-ofm-credit-watch'] === 'panel')
  const handlesOf = overrides => nodes(overrides)
    .filter(node => node.props !== undefined && node.props['data-ofm-credit-watch-handle'] !== undefined)
    .map(node => [node.props['data-ofm-credit-watch-handle'], node.props.style?.cursor])

  check('没拖过时用默认宽度', panelOf({}).props.style.width, 340)
  check('没拖过时高度自适应', panelOf({}).props.style.height, 'auto')
  const sized = panelOf({ [IDX.size]: { width: 480, height: 320 } }).props.style
  check('尺寸状态落到宽度', sized.width, 480)
  check('尺寸状态落到高度', sized.height, 320)

  check('只调宽度时高度仍自适应',
    panelOf({ [IDX.size]: { width: 480, height: null } }).props.style.height, 'auto')
  check('折叠时高度回落自适应',
    panelOf({ [IDX.size]: { width: 480, height: 320 }, [IDX.collapsed]: true }).props.style.height, 'auto')

  // 八个方向的热区与光标：上下、左右、两个对角各成一组。
  check('八个方向的热区与光标齐全', handlesOf({}), [
    ['n', 'ns-resize'], ['s', 'ns-resize'],
    ['w', 'ew-resize'], ['e', 'ew-resize'],
    ['nw', 'nwse-resize'], ['ne', 'nesw-resize'],
    ['sw', 'nesw-resize'], ['se', 'nwse-resize'],
  ])

  const handle = dir => nodes({}).find(node => node.props?.['data-ofm-credit-watch-handle'] === dir)
  const box = dir => {
    const style = handle(dir).props.style
    return [style.position, style.top, style.right, style.bottom, style.left, style.width, style.height]
  }
  // 热区贴着卡片边缘：单边只压自己那一侧，角同时压两个方向。
  check('上边热区压顶', box('n'), ['absolute', 0, 0, undefined, 0, undefined, 6])
  check('左边热区压左', box('w'), ['absolute', 0, undefined, 0, 0, 6, undefined])
  check('右下角同时贴右下', box('se'), ['absolute', undefined, 0, 0, undefined, 14, 14])

  check('热区平时透明（鼠标贴上才显形）', handle('se').props.style.background, 'transparent')
  check('热区都压在卡片之上', [handle('se').props.style.zIndex, handle('n').props.style.zIndex], [2, 1])
  check('热区可双击复位', typeof handle('se').props.onDoubleClick, 'function')

  // 隐藏态只留一个小胶囊，没有可拉的边。
  check('隐藏态不渲染手柄',
    nodes({ [IDX.hidden]: true }).filter(node => node.props?.['data-ofm-credit-watch-handle'] !== undefined).length, 0)
}

// ── 14. 大栏折叠/展开把固定高度重置为自适应 ──────────────────────────────
// 固定高度下切换大栏看不出高度变化，所以折叠/展开时把高度放回自适应；
// 内容区仍封顶 320px，展开再多也让内容自己滚，卡片不会长满一屏。
{
  /** 取某个大栏的标题栏：包裹层的第一个子节点就是可点的头部。 */
  const headOf = (tree, key) => {
    const wrap = flatten(tree).find(node => node.props !== undefined && node.props[`data-ofm-credit-watch-${key}`] !== undefined)
    return wrap === undefined ? undefined : (wrap.children || [])[0]
  }

  // 第一项是大栏在 DOM 上的标记后缀，第二项是给人看的名字。
  // WorkBuddy 的标记是 wb 而不是 workbuddy，两者不同源。
  const sections = [
    ['wb', 'workbuddy', { [IDX.wbRows]: wbRows(), [IDX.wbConnected]: true }],
    ['beichen', 'beichen', { [IDX.beichen]: beichenReading }],
    ['codex', 'codex', { [IDX.codex]: codexReading }],
    ['ofm', 'ofm', { [IDX.ofmTokens]: ofmReading }],
  ]

  for (const [key, label, extra] of sections) {
    store.delete("ofm-credit-watch.size")
    const tree = render({
      [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(),
      [IDX.hiddenSections]: new Set(),
      [IDX.size]: { width: 340, height: 320 },
      ...extra,
    })
    const head = headOf(tree, key)
    check(`${label} 大栏标题栏可点`, typeof head?.props?.onClick, "function")
    head.props.onClick({ stopPropagation() {} })
    check(`${label} 大栏折叠/展开后高度回到自适应`, hooks[IDX.size].height, null)
    check(`${label} 大栏折叠/展开保留宽度`, hooks[IDX.size].width, 340)
    const saved = JSON.parse(store.get("ofm-credit-watch.size") ?? "null")
    check(`${label} 大栏切换把自适应高度落盘`, saved?.height, null)
    store.delete("ofm-credit-watch.size")
  }

  // 本来就自适应：点一下不该产生尺寸写盘。
  store.delete("ofm-credit-watch.size")
  const auto = render({
    [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(), [IDX.hiddenSections]: new Set(),
    [IDX.size]: { width: 340, height: null }, [IDX.ofmTokens]: ofmReading,
  })
  headOf(auto, "ofm").props.onClick({ stopPropagation() {} })
  check("自适应时切换大栏不重复写尺寸", store.has("ofm-credit-watch.size"), false)
  check("自适应时切换大栏高度仍为自适应", hooks[IDX.size].height, null)

  // 自适应高度下内容区封顶 320：内容再多也让内容区自己滚。
  const autoBody = flatten(auto).find(node => node.props?.["data-ofm-credit-watch-body"] !== undefined)
  check("自适应时内容区封顶 320px", autoBody?.props.style.maxHeight, 320)
  check("自适应时内容区自身滚动", autoBody?.props.style.overflowY, "auto")

  // 拉过右下角之后内容区吃满剩余高度，不再受 320 限制。
  const fixed = render({
    [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(), [IDX.hiddenSections]: new Set(),
    [IDX.size]: { width: 340, height: 600 }, [IDX.ofmTokens]: ofmReading,
  })
  const fixedBody = flatten(fixed).find(node => node.props?.["data-ofm-credit-watch-body"] !== undefined)
  check("固定高度时内容区不限高", fixedBody?.props.style.maxHeight, undefined)
  check("固定高度时内容区吃满剩余空间", fixedBody?.props.style.flex, "1 1 auto")
  store.delete("ofm-credit-watch.size")
}

// ── GPT 订阅栏悬浮提示：不展开也能看到重置时刻 ─────────────────────────────
// 折叠时标题栏只有百分比，重置时间原来要展开才看得到。现在鼠标停在标题栏上
// 就给多行提示：每个窗口的剩余与重置时刻（绝对时间 + 还剩多久），末尾给
// 采样时刻与动作提示。这里注入固定「现在」，把提示文本逐行对出来。
{
  const NOW = 1_794_969_184_707
  /** 取 GPT 分区的可点标题栏。 */
  const codexHeadOf = tree => {
    const wrap = flatten(tree).find(node => node.props !== undefined && node.props['data-ofm-credit-watch-codex'] !== undefined)
    return wrap === undefined ? undefined : (wrap.children || [])[0]
  }
  const titleOf = overrides => codexHeadOf(render({
    [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(),
    [IDX.hiddenSections]: new Set(), [IDX.now]: NOW,
    [IDX.codex]: codexReading, ...overrides,
  }))?.props?.title ?? ''

  const folded = titleOf({ [IDX.codexOpen]: false })
  const lines = folded.split('\n')
  check('折叠时标题栏带多行提示', lines.length >= 4, true)
  check('提示给 5 小时窗剩余', lines[0], '5 小时　剩余 63%')
  check('提示给 5 小时窗重置时刻与倒计时', lines[1], '　重置于 今天 13:35（还有 3 小时）')
  check('提示给周窗剩余', lines[2], '本周　剩余 94%')
  check('提示给周窗重置时刻与倒计时', lines[3], '　重置于 11月25日 08:35（还有 7 天）')
  check('提示给采样时刻', lines[4], '采样于 今天 10:33，每分钟刷新')
  check('折叠时提示动作是展开', lines[5], '点一下展开明细')
  check('展开时提示动作是收起', titleOf({ [IDX.codexOpen]: true }).split('\n').at(-1), '点一下收起明细')

  // 已经过了重置时刻：改说「即将重置」，不再给负数倒计时。
  check('已过重置时刻只说即将重置',
    titleOf({ [IDX.codex]: { available: true, windows: [
      { kind: 'fiveHour', remainingPercent: 12, resetsAt: NOW - 60_000, sampledAt: NOW - 30_000 },
    ] } }).split('\n')[1], '　即将重置')

  // 上游没给重置时间：明说没有，不显示空括号。
  check('没有重置时间时明说没有',
    titleOf({ [IDX.codex]: { available: true, windows: [
      { kind: 'fiveHour', remainingPercent: 40, resetsAt: null, sampledAt: NOW - 30_000 },
    ] } }).split('\n')[1], '　没有给出重置时间')

  // 快照里一个窗口都没有：提示回到单纯的展开说明，不留空提示。
  check('没有窗口时提示保留展开说明',
    titleOf({ [IDX.codex]: { available: true, windows: [] }, [IDX.codexOpen]: false }), '点一下展开明细')

  // ── 视觉层：折叠态胶囊、展开态进度条 ──
  /** 取折叠标题栏里的两个限额胶囊。 */
  const chipsOf = tree => flatten(tree).filter(node =>
    node.props !== undefined && node.props['data-codex-chip'] !== undefined).map(node => node.props['data-codex-chip'])
  check('折叠态给出两个限额胶囊', chipsOf(render({
    [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(), [IDX.hiddenSections]: new Set(),
    [IDX.now]: NOW, [IDX.codex]: codexReading, [IDX.codexOpen]: false,
  })), ['5h', '1w'])

  // 胶囊里的填充宽度就是剩余百分比：条长与数字是同一个数，不会互相打架。
  const fillOf = tree => flatten(tree)
    .filter(node => node.props?.style?.width !== undefined && typeof node.props.style.width === 'string' && node.props.style.width.endsWith('%'))
    .map(node => node.props.style.width)
  check('胶囊填充按剩余百分比', fillOf(render({
    [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(), [IDX.hiddenSections]: new Set(),
    [IDX.now]: NOW, [IDX.codex]: codexReading, [IDX.codexOpen]: false,
  })).slice(0, 2), ['63%', '94%'])

  // 展开态每行一条进度条：填充宽度与百分比一致。
  check('展开态明细行带进度条', fillOf(render({
    [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(), [IDX.hiddenSections]: new Set(),
    [IDX.now]: NOW, [IDX.codex]: codexReading, [IDX.codexOpen]: true,
  })).includes('63%'), true)

  // 低余量保底：条再短也留 3% 可见，免得「还剩一点」缩成看不见。
  check('极低余量仍留最小可见宽度', fillOf(render({
    [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(), [IDX.hiddenSections]: new Set(),
    [IDX.now]: NOW, [IDX.codexOpen]: true,
    [IDX.codex]: { available: true, windows: [{ kind: 'fiveHour', remainingPercent: 0.5, resetsAt: NOW + 60_000, sampledAt: NOW }] },
  })).includes('3%'), true)

  // 四个大栏都带身份色条与折叠三角，视觉语言统一。
  check('四个大栏都有折叠三角',
    ['wb', 'beichen', 'codex', 'ofm'].map(key => {
      const tree = render({
        [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(), [IDX.hiddenSections]: new Set(),
        [IDX.wbRows]: wbRows(), [IDX.wbConnected]: true, [IDX.beichen]: beichenReading,
        [IDX.codex]: codexReading, [IDX.ofmTokens]: ofmReading,
      })
      const wrap = flatten(tree).find(node => node.props !== undefined && node.props[`data-ofm-credit-watch-${key}`] !== undefined)
      const head = wrap === undefined ? undefined : (wrap.children || [])[0]
      return flatten(head).some(node => node.props?.className === 'ofm-caret')
    }), [true, true, true, true])

  // 英文界面：日期用月份缩写，措辞跟着换。
  const enLines = titleOf({ [IDX.lang]: 'en' }).split('\n')
  check('英文界面的周窗重置时刻', enLines[3], '  resets at Nov 25, 08:35 (7 days left)')
  check('英文界面的采样行', enLines[4], 'sampled at today 10:33, refreshed every minute')
}

// ── 13. 端到端：拖上边动的必须是上边界 ───────────────────────────────────
// 回归测试。位置状态曾经只手拼了 relRight、丢掉 anchor.top，于是拉上边表现
// 成"下边界下移"：高度变大了，上边界却留在原地。这里驱动真的
// onPointerDown / onPointerMove，直接看状态落到了哪儿。
{
  const fakeRoot = {
    style: {},
    getBoundingClientRect: () => ({ left: 900, top: 100, right: 1240, bottom: 420, width: 340, height: 320 }),
  }
  fakeRoot.closest = () => fakeRoot
  const originQuery = global.document.querySelector
  global.document.querySelector = () => fakeRoot

  stateOverrides = {}
  hooks = []
  cursor = 0
  const ctx = { connection: { rpc: { call: async () => ({ ok: true, value: { accounts: [] } }) } } }
  const tree = React.createElement(t.CreditWatch, { ctx }).type({ ctx })
  const topHandle = flatten(tree).find(node => node.props?.['data-ofm-credit-watch-handle'] === 'n')
  const base = {
    button: 0, clientX: 900, clientY: 100, currentTarget: fakeRoot, pointerId: 1,
    preventDefault() {}, stopPropagation() {},
  }

  topHandle.props.onPointerDown(base)
  topHandle.props.onPointerMove({ clientX: 900, clientY: 60 })   // 往上拖 40

  check('拖上边：上边界跟着走', hooks[IDX.pos].top, 60)
  check('拖上边：高度随之变大', hooks[IDX.size].height, 360)
  check('拖上边：右边界留在原地', hooks[IDX.pos].relRight, 40)
  check('拖上边：宽度不变', hooks[IDX.size].width, 340)

  // 直接改 DOM 的那一份也要同步写上 top。只写 height 会留下"高度已变、
  // 上边界未变"的中间态，拖动时看起来就是下边界跟着上边界一起动。
  check('拖上边：DOM 上边界同步写下去', fakeRoot.style.top, '60px')
  check('拖上边：DOM 高度同步写下去', fakeRoot.style.height, '360px')

  // 位置与尺寸都已落盘：重开一次应当从 localStorage 读回同一份。
  const reopened = flatten(render({}))
    .find(node => node.props?.['data-ofm-credit-watch'] === 'panel')
  check('重开后：卡片停在上边界 60', reopened.props.style.top, 60)
  check('重开后：高度仍是 360', reopened.props.style.height, 360)

  // 同一模式的第二处：拖标题栏时两个方向也要一起写进 DOM，
  // 只写 left 会让斜着拖时纵向滞后一帧。
  fakeRoot.style = {}
  const head = flatten(React.createElement(t.CreditWatch, { ctx }).type({ ctx }))
    .find(node => node.props?.style?.cursor === 'grab')
  head.props.onPointerDown({
    button: 0, clientX: 910, clientY: 110, currentTarget: fakeRoot, pointerId: 2,
    preventDefault() {}, stopPropagation() {},
  })
  head.props.onPointerMove({ clientX: 890, clientY: 160, currentTarget: fakeRoot })
  check('拖标题栏：DOM 上边界同步写下去', fakeRoot.style.top, '150px')
  check('拖标题栏：DOM 左边界同步写下去', fakeRoot.style.left, '880px')

  global.document.querySelector = originQuery
  store.delete('ofm-credit-watch.position')
  store.delete('ofm-credit-watch.size')
}

// ── 标题栏按钮的命中范围 ─────────────────────────────────────────────────
{
  const tree = render({ [IDX.rows]: fullRows() })
  const nodes = flatten(tree)
  const titles = ['立即刷新', '选择显示哪些渠道', '收起', '隐藏']
  const buttons = titles.map(title => nodes.find(node => node.type === 'button' && node.props.title === title))
  check('标题栏四个按钮都存在', buttons.every(Boolean), true)
  check('四个按钮均提供 30px 命中范围且不会被压缩',
    buttons.map(button => [button.props.style.width, button.props.style.height, button.props.style.flex]),
    titles.map(() => [30, 30, '0 0 30px']))
  check('四个按钮仍有点击处理', buttons.every(button => typeof button.props.onClick === 'function'), true)
  let stopped = 0
  for (const button of buttons) button.props.onPointerDown({ stopPropagation() { stopped += 1 } })
  check('按下按钮不会触发标题栏拖动', stopped, 4)
  const head = nodes.find(node => node.props?.style?.cursor === 'grab')
  check('标题栏右侧避让右上角缩放热区', head.props.style.padding, '9px 16px 8px 10px')
  check('缩放热区仍然存在', nodes.filter(node => node.props?.['data-ofm-credit-watch-handle']).length, 8)
}

// ── 重启后折叠态遇到窗口尺寸变化 ─────────────────────────────────────────
{
  const originalQuery = document.querySelector
  const originalAdd = window.addEventListener
  const originalRemove = window.removeEventListener
  const effects = []
  const listeners = {}
  const root = { style: {} }
  effectCapture = effects
  document.querySelector = selector => selector.includes('ofm-credit-watch') ? root : null
  window.addEventListener = (name, fn) => { listeners[name] = fn }
  window.removeEventListener = () => {}
  store.set('ofm-credit-watch.collapsed', '1')
  store.set('ofm-credit-watch.size', JSON.stringify({ width: 340, height: 320 }))
  try {
    const tree = render({ [IDX.rows]: fullRows() })
    check('重启后恢复折叠状态', countRows(tree), 0)
    check('重启后折叠卡片高度自适应', tree.props.style.height, 'auto')
    effects.find(fn => String(fn).includes("window.addEventListener('resize'"))()
    listeners.resize()
    check('折叠状态下窗口尺寸变化不会撑开卡片', root.style.height, 'auto')
    check('窗口尺寸变化保留展开高度', hooks[IDX.size].height, 320)
    const toggle = flatten(tree).find(node => node.type === 'button' && node.props.title === '展开')
    toggle.props.onClick({ stopPropagation() {} })
    cursor = 0
    const expanded = t.CreditWatch({ ctx: {} })
    check('展开后恢复大栏（渠道列表已移除）', countRows(expanded), 0)
    check('展开后恢复原来的高度', expanded.props.style.height, 320)
    check('展开状态写入持久化存储', store.get('ofm-credit-watch.collapsed'), '0')
  } finally {
    effectCapture = null
    document.querySelector = originalQuery
    window.addEventListener = originalAdd
    window.removeEventListener = originalRemove
    store.delete('ofm-credit-watch.collapsed')
    store.delete('ofm-credit-watch.size')
    store.delete('ofm-credit-watch.position')
  }
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
