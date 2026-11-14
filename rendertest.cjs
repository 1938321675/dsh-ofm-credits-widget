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
  check('设置面板展开时渠道行照常渲染', countRows(withSettings), 10)

  // 隐藏 OFM 渠道不影响 WorkBuddy 分区——两套上游互不牵连。
  const allHiddenOfm = render({
    [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(allIds),
    [IDX.wbRows]: wbRows(), [IDX.wbOpen]: true,
  })
  check('OFM 渠道全隐藏时 WorkingBuddy 行仍在', countWbRows(allHiddenOfm), 3)
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
  // 100 + 900 + 0 = 1000，走 kilo 原样显示（一万以下不缩写）。
  // 小字只有一个数字，不带「token」这种字样——列的语义靠位置自明。
  check('渠道行显示今日 token', usageTexts.includes('1000'), true)
  check('渠道行不带 token 字样', usageTexts.includes('token'), false)

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
  // 页脚是「几个渠道有余额 / 隐藏了几个」的列表汇总，统计页里不对题。
  check('统计视图不渲染页脚', allText(stats).join(' ').includes('个渠道有余额'), false)
  check('列表视图有页脚', allText(render({ [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set() })).join(' ').includes('个渠道有余额'), true)
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
}

// ── 4d. 主界面的分隔条 ────────────────────────────────────────────────────
{
  const mainSplitterOf = tree => flatten(tree).find(n => n.props !== undefined && n.props['data-main-splitter'] === 'true')
  const mainListOf = tree => flatten(tree).find(n => n.props !== undefined && n.props['data-main-list'] === 'true')

  const list = render({ [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set() })
  check('列表视图有主界面分隔条', mainSplitterOf(list) !== undefined, true)
  check('主界面分隔条用上下拖动光标', mainSplitterOf(list)?.props.style?.cursor, 'row-resize')
  check('没拖过时渠道列表没有固定高度', mainListOf(list)?.props.style?.height, undefined)

  const sized = render({ [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(), [IDX.mainSplit]: 180 })
  // 拖过之后按固定高度参与上下分配：拖动就是在改这块的高度。
  check('拖过之后渠道列表带固定高度', mainListOf(sized)?.props.style?.height, 180)
  // 不被压扁：往上拖时浏览器不得把行挤扁（否则横线不动、内容反而变细）。
  check('渠道列表不参与压缩', mainListOf(sized)?.props.style?.flexShrink, 0)
  // 下限不靠样式（overflow:auto 的 min-content 算出来是 0），
  // 而是拖动时用实测 scrollHeight 夹取，见下方拖动链路用例。
  check('渠道列表超出时自己滚', mainListOf(sized)?.props.style?.overflowY, 'auto')

  // body 在拖过之后变成纵向 flex：上下两块在里面真正分配高度。
  const bodyOf = tree => flatten(tree).find(n => n.props !== undefined
    && n.props.style !== undefined && n.props.style.padding === '4px 0 6px')
  check('没拖过时 body 限制高度', bodyOf(list)?.props.style?.maxHeight, 320)
  check('拖过之后 body 放开高度限制', bodyOf(sized)?.props.style?.maxHeight, undefined)
  check('拖过之后 body 是纵向 flex', bodyOf(sized)?.props.style?.display, 'flex')
  check('拖过之后 body 纵向排列', bodyOf(sized)?.props.style?.flexDirection, 'column')

  // 下半区吃剩余高度，横线才会跟着手走。
  const wbOf = tree => flatten(tree).find(n => n.props !== undefined && n.props['data-ofm-credit-watch-wb'] === 'section')
  check('拖过之后 WorkBuddy 分区吃剩余高度', wbOf(sized)?.props.style?.flex, '1 1 auto')
  check('没拖过时 WorkBuddy 分区随内容', wbOf(list)?.props.style?.flex, undefined)

  // 统计视图与设置面板里，上半区不是列表，分隔条不出现。
  check('统计视图没有主界面分隔条',
    mainSplitterOf(render({ [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(), [IDX.view]: 'stats' })), undefined)
  check('设置面板展开时没有主界面分隔条',
    mainSplitterOf(render({ [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set(), [IDX.configOpen]: true })), undefined)
}

// ── 4e. 拖动分隔条真的会改高度 ────────────────────────────────────────────
// 这里验证的是拖动链路本身：按下 → window 上的 pointermove → 状态变化。
// 之前用元素自己的 pointer capture，重渲染换掉节点后事件就断了，
// 表现为"光标变了但拖不动"，所以听的是 window。
{
  const handlers = {}
  global.window.addEventListener = (type, fn) => { handlers[type] = fn }
  global.window.removeEventListener = (type) => { delete handlers[type] }

  const list = render({ [IDX.rows]: fullRows(), [IDX.hiddenIds]: new Set() })
  const splitter = flatten(list).find(n => n.props !== undefined && n.props['data-main-splitter'] === 'true')
  check('分隔条带按下处理', typeof splitter?.props.onPointerDown, 'function')

  // 造一个够用的 DOM 桩：分隔条的父节点能查到列表，列表有高度。
  const fakeList = { offsetHeight: 120, scrollHeight: 90, parentElement: { clientHeight: 400, offsetHeight: 400 } }
  const fakeParent = { querySelector: () => fakeList }
  const fakeEvent = {
    button: 0, clientY: 100,
    currentTarget: { parentElement: fakeParent },
    preventDefault() {}, stopPropagation() {},
  }

  splitter.props.onPointerDown(fakeEvent)
  check('按下后挂了 window pointermove', typeof handlers.pointermove, 'function')
  check('按下后挂了 window pointerup', typeof handlers.pointerup, 'function')

  // 往下拖 60px：高度应变成 120 + 60 = 180。
  handlers.pointermove({ clientY: 160, preventDefault() {} })
  check('拖动改变渠道列表高度', hooks[IDX.mainSplit], 180)

  // 继续拖到远超上限：夹在可视高度之内。
  handlers.pointermove({ clientY: 99999, preventDefault() {} })
  check('拖动高度被夹进可视区', hooks[IDX.mainSplit], 400 - t.STATS_SPLIT_MIN)

  // 双向都要跟手。基准是按下那一刻的静态值，任何位置都能落在
  // (startHeight + 位移) 上，不会出现「只能变大、拖不回去」。
  handlers.pointermove({ clientY: 90, preventDefault() {} })
  check('往回拖会变小', hooks[IDX.mainSplit], 120 + (90 - 100))
  handlers.pointermove({ clientY: 140, preventDefault() {} })
  check('再往回拖又变大', hooks[IDX.mainSplit], 120 + (140 - 100))

  // 拖到比内容还矮时被下限兜住（内容 90px），不会把行压扁。
  handlers.pointermove({ clientY: 60, preventDefault() {} })
  check('低于内容高度时被兜住', hooks[IDX.mainSplit], 90)

  // 上下两端都夹住：拉到顶不超过可用高度减一个最小块；
  // 拉到底停在下限——下限是内容自然高度（scrollHeight=90），
  // 不是固定 48：钉在 48 会把行压扁，而横线却不动。
  handlers.pointermove({ clientY: 90000, preventDefault() {} })
  check('拉到顶停在上限', hooks[IDX.mainSplit], 400 - t.STATS_SPLIT_MIN)
  handlers.pointermove({ clientY: -90000, preventDefault() {} })
  check('拉到底停在内容高度', hooks[IDX.mainSplit], 90)

  // 松手：监听器要摘掉，且高度落盘。
  handlers.pointerup({})
  check('松手后摘掉 pointermove', handlers.pointermove, undefined)
  check('松手后摘掉 pointerup', handlers.pointerup, undefined)
  check('松手后高度已落盘', global.window.localStorage.getItem(t.MAIN_SPLIT_KEY), '90')

  global.window.localStorage.setItem(t.MAIN_SPLIT_KEY, '')
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

  // 今日积分已经提到独立的「今日」列（与 WorkBuddy 账号行对齐），
  // 不再以「今日 −X」的小字挂在余额下面。
  const withToday = textsOf({ [IDX.rows]: rows, [IDX.today]: { qoder: 320 } })
  check('今日积分显示在对应渠道上', withToday.includes('−320'), true)
  check('没有今日消耗的渠道显示占位点', (withToday.match(/·/g) || []).length >= 1, true)

  const noToday = textsOf({ [IDX.rows]: rows, [IDX.today]: {} })
  check('累计表为空时不显示今日数字', noToday.includes('−320'), false)
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
    check('展开后恢复列表', countRows(expanded), 10)
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
