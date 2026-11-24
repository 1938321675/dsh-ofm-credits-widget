/**
 * dsh-ofm-credit-watch —— 浏览器半身。
 *
 * 一个可自由拖动的悬浮窗，挂在 DSH 的 `shell.overlay`（整框悬浮层）上，
 * 每分钟向 Our Free Model（OFM）已注册的 channel-pack 端点查一次
 * `credits.balances`，把 EAC router 各渠道的剩余积分汇总成一行，并给出
 * 本轮相对上一轮的消耗差值。最近有消耗的渠道排在最前面。
 *
 * ## 为什么直接走 channel-pack 的 RPC 通道
 *
 * OFM 的积分查询不存在于它自己的 `/api/our-free-model/*` 里，而是由它
 * vendor 进来的 channel-pack 通过 `connection.fetch.register('/api/channel-pack')`
 * 注册的。那条通道要求浏览器侧的同一个 `connection` 服务来签请求，因此这里
 * 复刻的正是 OFM 自己的 `useChannelRpc`：`connection.rpc.call(conn.rpc, '/api', 'channel-pack', { method, payload }, signal)`。
 * 这样凭据、缓存、失败分类都由 channel-pack 负责，我们不复制它们的业务逻辑，
 * OFM 升级时也不会静默坏掉。
 *
 * ## 时间观
 *
 * 浏览器里每轮采一次快照：快照差给出「本分钟消耗」，快照本身报给 Host
 * 累加成「当日消耗」。两件事的基准不同——前者是内存里的上一轮，后者由
 * Host 落盘，跨浏览器、跨重载都延续（见 index.js 的账本说明）。
 *
 * 渠道「最近有消耗」的时间戳保存在内存里，只有出现正的消耗差值时才更新，
 * 因此排序稳定——不会因为轮询抖动而跳来跳去。
 *
 * 手写 ModuleLoader bundle：不打包、不依赖 react 之外的模块，颜色全部走
 * `--dsw-alias-*` 主题变量，明暗主题自动跟随。
 */

window.__ModuleLoader__.load({
  id: 'dsh-ofm-credit-watch',
  factory(require) {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, useState, useEffect, useRef, useCallback, useMemo } = React

    // ─── 渠道目录 ────────────────────────────────────────────────────────────
    // 与 OFM 的 EAC router 页一致的十个账号渠道：id 就是 channel-pack 的
    // provider id，name/org 用于标题，accent 只用于左侧色条。
    const CHANNELS = [
      { id: 'lobsterai', name: 'LobsterAI', org: '有道', accent: '#FF6A00' },
      { id: 'qoder', name: 'Qoder', org: '阿里系', accent: '#615CED' },
      { id: 'qodercn', name: 'Qoder 中国版', org: '阿里系', accent: '#7A6CF0' },
      { id: 'trae', name: 'TRAE', org: '字节', accent: '#00BFA6' },
      { id: 'cline', name: 'Cline', org: 'Cline', accent: '#5B5BD6' },
      { id: 'loomy', name: 'Loomy', org: '讯飞', accent: '#2F6BFF' },
      { id: 'raccoon', name: 'Raccoon', org: '商汤', accent: '#00A6A6' },
      { id: 'minimax', name: 'MiniMax Code', org: 'MiniMax', accent: '#E4007F' },
      { id: 'zcode', name: 'ZCode', org: '智谱', accent: '#3B6EF6' },
      { id: 'gemini', name: 'Gemini', org: 'Google Code Assist', accent: '#4285F4' },
    ]

    /** 轮询间隔：一分钟。 */
    const POLL_MS = 60_000
    /** 单次 RPC 超时：某渠道有多个账号时要逐个打上游，给足时间。 */
    const RPC_TIMEOUT_MS = 90_000
    /** 位置持久化键。 */
    const POS_KEY = 'ofm-credit-watch.position'
    /** WorkBuddy 分区展开状态持久化键。 */
    const WB_OPEN_KEY = 'ofm-credit-watch.wbOpen'
    /** 北辰 API 分区的折叠状态持久化键。 */
    const BEICHEN_OPEN_KEY = 'ofm-credit-watch.beichenOpen'
    /** GPT 订阅分区的折叠状态持久化键。 */
    const CODEX_OPEN_KEY = 'ofm-credit-watch.codexOpen'
    /** OFM 模型分区的折叠状态持久化键。 */
    const OFM_OPEN_KEY = 'ofm-credit-watch.ofmOpen'
    /** 折叠状态持久化键。 */
    const COLLAPSE_KEY = 'ofm-credit-watch.collapsed'
    /** 被用户隐藏的渠道 id 列表持久化键。存「隐藏」而不是「显示」：
     *  新版本 OFM 若新增渠道，它会默认显示出来，而不是悄悄消失。 */
    const HIDDEN_KEY = 'ofm-credit-watch.hiddenChannels'
    /** Host 不可用时，当日累计的本地兜底账本键。 */
    const LOCAL_DAILY_KEY = 'ofm-credit-watch.daily'
    /** 可隐藏大栏的持久化键：北辰 / GPT 订阅 / OFM 模型 / WorkBuddy。 */
    const HIDDEN_SECTIONS_KEY = 'ofm-credit-watch.hiddenSections'
    /** Host 账本路由。 */
    const LEDGER_URL = '/api/ofm-credit-watch/ledger'
    /** token 用量路由（数据来自 cost-meter 的日聚合账本）。 */
    const USAGE_URL = '/api/ofm-credit-watch/usage'
    /** 北辰 API 的余额与按日用量：Host 侧解析 Key 并向网关取数。 */
    const BEICHEN_URL = '/api/ofm-credit-watch/beichen'
    /** GPT 订阅限额：读订阅插件落盘的预测快照。 */
    const CODEX_URL = '/api/ofm-credit-watch/codex'
    /** OFM 免费模型的今日 token：读 cost-meter 账本。 */
    const OFM_TOKENS_URL = '/api/ofm-credit-watch/ofm-tokens'
    /** 当前视图（列表 / 统计）持久化键。 */
    const VIEW_KEY = 'ofm-credit-watch.view'
    /** 统计界面一屏放几天。 */
    const STATS_DAYS = 7
    /** 统计界面「渠道明细」区高度持久化键；null 表示随内容自适应。 */
    const STATS_SPLIT_KEY = 'ofm-credit-watch.statsSplit'
    /** 明细区最少留几行的高度，再小就没有滚动条的意义了。 */
    const STATS_SPLIT_MIN = 48
    /** 主界面「渠道列表 / WorkBuddy 分区」的分隔高度持久化键。 */
    const MAIN_SPLIT_KEY = 'ofm-credit-watch.mainSplit'
    /** 「都在安静」的判定窗口：超过它就当作不活跃。 */
    const IDLE_WINDOW_MS = 5 * 60_000
    /** 卡片默认宽度：位置换算、拖动夹取、手柄复位共用一个常量。 */
    const PANEL_WIDTH = 340
    /** 尺寸持久化键。高度为 null 表示「随内容自适应」。 */
    const SIZE_KEY = 'ofm-credit-watch.size'
    /** 尺寸下限：比这更窄，名称列的省略号就没意义了；比这更矮只剩标题栏。 */
    const MIN_WIDTH = 240
    const MIN_HEIGHT = 120
    /** 卡片与视口边缘留的缝：拉到最大也要给手柄留出抓回来的余地。 */
    const SIZE_MARGIN = 16
    /** 右下角拖拽角与右侧边缘手柄的命中尺寸。 */
    const HANDLE_CORNER = 14
    const HANDLE_EDGE = 6
    /** 八个缩放方向：四条边 + 四个角。顺序即渲染顺序，边在前、角在后（角压边）。 */
    const HANDLES = ['n', 's', 'w', 'e', 'nw', 'ne', 'sw', 'se']
    /** 每个方向的光标：对角分 nwse / nesw 两种，与 Windows 窗口一致。 */
    const CURSOR_BY_DIR = {
      n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
      nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
    }
    /** 每条热区压在哪几条边上：单边只压自己那一侧，角同时压两个方向。 */
    const HANDLE_BOX = {
      n: { top: 0, left: 0, right: 0, height: HANDLE_EDGE },
      s: { bottom: 0, left: 0, right: 0, height: HANDLE_EDGE },
      w: { left: 0, top: 0, bottom: 0, width: HANDLE_EDGE },
      e: { right: 0, top: 0, bottom: 0, width: HANDLE_EDGE },
      nw: { top: 0, left: 0, width: HANDLE_CORNER, height: HANDLE_CORNER },
      ne: { top: 0, right: 0, width: HANDLE_CORNER, height: HANDLE_CORNER },
      sw: { bottom: 0, left: 0, width: HANDLE_CORNER, height: HANDLE_CORNER },
      se: { bottom: 0, right: 0, width: HANDLE_CORNER, height: HANDLE_CORNER },
    }
    /** 热区被鼠标贴上时刷上的提示色；平时是 transparent。 */
    const HINT_BG = 'color-mix(in srgb, var(--dsw-alias-brand-primary, #4b7bec) 30%, transparent)'

    /**
     * 渠道的默认计量单位。
     *
     * channel-pack 的 package 里带 `unit` 字段（"积分"/"USD"/"token"/"%"），
     * 但偶尔会缺省（例如只报总额不报明细的渠道）。缺省时按渠道回退：
     * Cline 的余额是美元、ZCode 的额度桶是 token、Gemini 的配额是百分比。
     */
    const UNIT_BY_PROVIDER = { cline: 'USD', zcode: 'token', gemini: '%' }

    /** 单轮同时打几个渠道的上游：十家一起发容易同时抖动，也更容易被限流。 */
    const MAX_CONCURRENCY = 4
    /** 被隐藏的渠道降频到这个间隔：看不见的渠道不必每分钟占用一次上游往返。 */
    const HIDDEN_POLL_MS = 5 * 60_000
    /** 失败行沿用旧读数的最长时间；超过它宁可显示"没有数据"，也不展示过期数字。 */
    const STALE_ROW_MS = 30 * 60_000

    /**
     * 有并发上限的 map。
     *
     * 结果保序：返回数组与输入一一对应，调用方仍按 CHANNELS 的顺序取值。
     * 单项抛错由 `task` 自己收敛，这里不做 catch——与 Promise.all 的语义一致。
     */
    async function mapLimit(items, limit, task) {
      const results = new Array(items.length)
      let cursor = 0
      const worker = async () => {
        for (;;) {
          const index = cursor
          cursor += 1
          if (index >= items.length) return
          results[index] = await task(items[index], index)
        }
      }
      const width = Math.max(1, Math.min(limit, items.length))
      await Promise.all(Array.from({ length: width }, worker))
      return results
    }

    /**
     * 这一轮要不要查这个渠道。
     *
     * 隐藏只影响显示，但没显示的渠道没必要每分钟都往上打一次：降频到
     * HIDDEN_POLL_MS，勾回来的时候最多等一个间隔就有新数字。从未查过的
     * 渠道永远查——否则刚隐藏的渠道会一直停在"没有数据"。
     */
    function shouldPollChannel(hidden, lastAt, at) {
      if (!hidden) return true
      if (!Number.isFinite(lastAt)) return true
      return at - lastAt >= HIDDEN_POLL_MS
    }

    /**
     * 失败时这一行怎么显示。
     *
     * 上游抖动一次就清空数字会让悬浮窗闪烁，所以沿用上一轮读数；但沿用
     * 必须有期限——半小时读不到，那个数字已经不能代表"现在还剩多少"，
     * 这时改成没有数据，并保留失败标记让人知道是查不到而不是花光了。
     */
    function failureRow(before, at) {
      const lastOkAt = Number.isFinite(before?.lastOkAt) ? before.lastOkAt : 0
      const fresh = lastOkAt > 0 && at - lastOkAt <= STALE_ROW_MS
      return {
        total: fresh && Number.isFinite(before?.total) ? before.total : null,
        accounts: before?.accounts ?? 0,
        unit: before?.unit ?? 'credits',
        packages: before?.packages ?? [],
        lastOkAt,
        stale: !fresh,
      }
    }

    // ─── 文案 ────────────────────────────────────────────────────────────────
    const DICT = {
      zh: {
        title: '费用监控',
        subtitle: '费用与限额',
        refresh: '立即刷新',
        refreshing: '刷新中…',
        never: '尚未查询',
        ago: '{when}前更新',
        now: '刚刚更新',
        idle: '无消耗',
        usedMinute: '本分钟',
        today: '今日',
        spentAgo: '{when}前有消耗',
        spentJustNow: '刚刚有消耗',
        noAccounts: '未接入账号',
        noData: '未返回余额',
        failed: '查询失败',
        retryOnNext: '将在下一分钟自动重试',
        collapse: '收起',
        expand: '展开',
        close: '隐藏',
        show: '积分',
        dragHint: '拖动标题栏可移动',
        resizeCorner: '拖动可改宽高，双击复位',
        resizeEdge: '拖动只改宽度，双击复位',
        total: '合计',
        accounts: '{count} 个账号',
        summary: '{channels} 个渠道有余额 · {total}',
        errorOne: '{name} 查询失败',
        emptyHint: 'OFM 没有返回任何渠道余额。确认 Our Free Model 的 EAC router 已登录账号。',
        settings: '选择显示哪些渠道',
        settingsHint: '取消勾选的渠道不再显示，悬浮窗会变矮。设置只影响本机这个窗口。',
        settingsDone: '完成',
        hideAll: '全部隐藏',
        showAll: '全部显示',
        allHidden: '所有渠道都被隐藏了。点 ⚙ 重新勾选。',
        hiddenCount: '已隐藏 {count} 个',
        hideThis: '隐藏这个渠道',
        unitCredits: '积分',
        unitToken: 'token',
        expireOn: '{date} 过期',
        packageLine: '{name} {remaining}/{total}',
        wbTitle: 'WorkBuddy 账号',
        wbColAccount: '账号',
        wbColBalance: '余额',
        stats: 'token 统计',
        statsBack: '返回列表',
        statsTitle: '每日 token 用量',
        beichenName: '北辰 API',
        beichenSub: '中转网关',
        beichenNoData: '今日暂无调用',
        beichenBalance: '剩余余额',
        beichenTokens: '今日 Token',
        beichenCache: '缓存读取',
        codexName: 'GPT 订阅',
        codexFiveHour: '5 小时',
        codexWeekly: '本周',
        codexRemaining: '剩余 {value}',
        codexResets: '{when}重置',
        codexResetSoon: '即将重置',
        codexUnavailable: '未连接 GPT 订阅',
        codexTipReset: '　重置于 {when}（还有 {left}）',
        codexTipResetNow: '　即将重置',
        codexTipNoReset: '　没有给出重置时间',
        codexTipSampled: '采样于 {when}，每分钟刷新',
        codexTipExpand: '点一下展开明细',
        codexTipCollapse: '点一下收起明细',
        codexWhenToday: '今天 {time}',
        codexWhenTomorrow: '明天 {time}',
        codexWhenDate: '{month}月{day}日 {time}',
        codexChipFiveHour: '5h',
        codexChipWeekly: '1w',
        codexStale: '快照已过期，等订阅插件刷新',
        codexTipStale: '　快照停在上次采样，等订阅插件刷新后再看',
        codexTokensToday: '今日 token',
        codexTokensBreakdown: '输入 {input} · 输出 {output} · 缓存 {cache}',
        codexTipTokens: '　今日 {total} token（入 {input} / 出 {output} / 缓存 {cache}）',
        ofmName: 'OFM 模型',
        ofmTokensEmpty: '今天还没有调用',
        ofmCalls: '{count} 次调用',
        sectionBeichen: '北辰 API 栏',
        sectionCodex: 'GPT 订阅栏',
        sectionOfm: 'OFM 模型栏',
        sectionWb: 'WorkBuddy 栏',
        sectionsHint: '大栏显示',
        statsUnavailable: '未连接 cost-meter',
        statsEmpty: '这一天没有调用记录',
        statsToday: '今日',
        statsTotal: '合计',
        statsOfm: 'OFM 渠道',
        statsWb: 'WorkBuddy',
        statsCodex: 'GPT 订阅',
        statsBeichen: '北辰 API',
        beichenModels: '按模型（累计）',
        statsBuckets: '输入 {input} · 缓存命中 {cache} · 输出 {output}',
        statsBreakdown: '入 {input} · 缓 {cache} · 出 {output}',
        statsCalls: '{count} 次调用',
        statsPrev: '前一天',
        statsNext: '后一天',
        statsNoData: '暂无数据',
        wbAccumulated: '累计积分',
        statsSplitHint: '上下拖动改变明细区高度，双击复位',
        mainSplitHint: '上下拖动改变渠道列表高度，双击复位',
        wbToday: '今日',
        wbTotal: '累计',
        wbUnavailable: '未连接 WorkBuddy',
        wbNoAccounts: '没有账号',
        wbNoCredits: '未返回积分',
        wbExpand: '展开账号消耗',
        wbCollapse: '收起账号消耗',
        wbRegionCn: '国内版',
        wbRegionGlobal: '国际版',
      },
      en: {
        title: 'Cost Monitor',
        subtitle: 'costs and quotas',
        refresh: 'Refresh now',
        refreshing: 'Refreshing…',
        never: 'Not queried yet',
        ago: 'updated {when} ago',
        now: 'updated just now',
        idle: 'idle',
        usedMinute: 'this min',
        today: 'today',
        spentAgo: 'spent {when} ago',
        spentJustNow: 'spent just now',
        noAccounts: 'no account',
        noData: 'no balance returned',
        failed: 'query failed',
        retryOnNext: 'retries automatically next minute',
        collapse: 'Collapse',
        expand: 'Expand',
        close: 'Hide',
        show: 'Credits',
        dragHint: 'Drag the title bar to move',
        resizeCorner: 'Drag to resize, double-click to reset',
        resizeEdge: 'Drag to change the width only, double-click to reset',
        total: 'Total',
        accounts: '{count} accounts',
        summary: '{channels} channels with balance · {total}',
        errorOne: '{name} query failed',
        emptyHint: 'OFM returned no channel balance. Check that Our Free Model has a channel account signed in.',
        settings: 'Choose visible channels',
        settingsHint: 'Unchecked channels are hidden, which makes the panel shorter. This only affects this window on this machine.',
        settingsDone: 'Done',
        hideAll: 'Hide all',
        showAll: 'Show all',
        allHidden: 'Every channel is hidden. Click ⚙ to pick some again.',
        hiddenCount: '{count} hidden',
        hideThis: 'Hide this channel',
        unitCredits: 'credits',
        unitToken: 'tokens',
        expireOn: 'expires {date}',
        packageLine: '{name} {remaining}/{total}',
        wbTitle: 'WorkBuddy accounts',
        wbColAccount: 'account',
        wbColBalance: 'left',
        stats: 'Token stats',
        statsBack: 'Back to list',
        statsTitle: 'Daily token usage',
        beichenName: 'Beichen API',
        beichenSub: 'relay gateway',
        beichenNoData: 'No calls today',
        beichenBalance: 'Balance left',
        beichenTokens: 'Tokens today',
        beichenCache: 'cache read',
        codexName: 'GPT subscription',
        codexFiveHour: '5-hour',
        codexWeekly: 'This week',
        codexRemaining: '{value} left',
        codexResets: 'resets {when}',
        codexResetSoon: 'resets soon',
        codexUnavailable: 'GPT subscription not connected',
        codexTipReset: '  resets at {when} ({left} left)',
        codexTipResetNow: '  resets soon',
        codexTipNoReset: '  no reset time given',
        codexTipSampled: 'sampled at {when}, refreshed every minute',
        codexTipExpand: 'click to expand details',
        codexTipCollapse: 'click to collapse details',
        codexWhenToday: 'today {time}',
        codexWhenTomorrow: 'tomorrow {time}',
        codexWhenDate: '{month} {day}, {time}',
        codexChipFiveHour: '5h',
        codexChipWeekly: '1w',
        codexStale: 'snapshot expired, waiting for refresh',
        codexTipStale: '  snapshot is from the last sample, waiting for the subscription plugin',
        codexTokensToday: 'Tokens today',
        codexTokensBreakdown: 'in {input} · out {output} · cache {cache}',
        codexTipTokens: '  {total} tokens today (in {input} / out {output} / cache {cache})',
        ofmName: 'OFM models',
        ofmTokensEmpty: 'No calls today',
        ofmCalls: '{count} calls',
        sectionBeichen: 'Beichen API section',
        sectionCodex: 'GPT subscription section',
        sectionOfm: 'OFM models section',
        sectionWb: 'WorkBuddy section',
        sectionsHint: 'Sections',
        statsUnavailable: 'cost-meter not connected',
        statsEmpty: 'No calls on this day',
        statsToday: 'today',
        statsTotal: 'total',
        statsOfm: 'OFM channels',
        statsWb: 'WorkBuddy',
        statsCodex: 'GPT subscription',
        statsBeichen: 'Beichen API',
        beichenModels: 'by model (total)',
        statsBuckets: 'in {input} · cache hit {cache} · out {output}',
        statsBreakdown: 'in {input} · cache {cache} · out {output}',
        statsCalls: '{count} calls',
        statsPrev: 'Previous day',
        statsNext: 'Next day',
        statsNoData: 'no data',
        wbAccumulated: 'total credits',
        statsSplitHint: 'Drag up or down to resize, double-click to reset',
        mainSplitHint: 'Drag to resize the channel list, double-click to reset',
        wbToday: 'today',
        wbTotal: 'total',
        wbUnavailable: 'WorkBuddy not connected',
        wbNoAccounts: 'no account',
        wbNoCredits: 'no credits returned',
        wbExpand: 'Show per-account spend',
        wbCollapse: 'Hide per-account spend',
        wbRegionCn: 'CN',
        wbRegionGlobal: 'Global',
      },
    }

    /** 极简插值：只替换 `{name}` 形式的占位符。 */
    function fill(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (whole, key) =>
        Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole)
    }

    // ─── 单位 ────────────────────────────────────────────────────────────────
    /**
     * 把上游五花八门的 unit 收敛成四种本插件认识的单位。
     *
     * channel-pack 各渠道写的中文标签不统一（"积分"、"渠道"、空串都有），
     * 认不出的统一归到 credits——反正它们都是"多少个点数"。
     */
    function unitOf(raw) {
      if (typeof raw !== 'string') return 'credits'
      const text = raw.trim().toLowerCase()
      if (text === 'usd' || text === '$' || text === '美元') return 'USD'
      if (text === 'token' || text === 'tokens') return 'token'
      if (text === '%') return '%'
      return 'credits'
    }

    // ─── 数值格式化 ──────────────────────────────────────────────────────────
    /**
     * 把积分数压缩成好读的形式：999 以下原样，之后按 k / M 缩写。
     * 上游各渠道的量级差很多（Qoder 是几百，TRAE 是几万），固定两位小数会让
     * 几百的数字看起来比几万还长。
     */
    function kilo(value) {
      if (!Number.isFinite(value)) return '—'
      const abs = Math.abs(value)
      // 去掉无意义的 ".0"：3.0k 写成 3k，但 3.3k 保留一位。
      const trim = text => text.replace(/\.0$/, '')
      // 一万以下保留精确整数：积分余额差 10 点就是 10 点，缩写会看不出来；
      // 一万以上才用 k / M，因为那时量级本身就是主要信息。
      if (abs >= 1e6) return `${trim((value / 1e6).toFixed(abs >= 1e7 ? 0 : 1))}M`
      if (abs >= 1e4) return `${trim((value / 1e3).toFixed(abs >= 1e5 ? 0 : 1))}k`
      if (abs >= 10) return value.toFixed(0)
      if (abs >= 1) return value.toFixed(1)
      if (abs === 0) return '0'
      return value.toFixed(2)
    }

    /**
     * 按单位格式化一个余额。
     *
     * 美元必须保留两位：Cline 的余额常常是 3.47 这种，`kilo` 会把它抹成
     * 3.5。百分比同理，去掉小数没有意义。其余（积分、token）走 `kilo`。
     */
    function formatAmount(value, unit) {
      if (!Number.isFinite(value)) return '—'
      if (unit === 'USD') return `$${value.toFixed(2)}`
      if (unit === '%') return `${value.toFixed(0)}%`
      return kilo(value)
    }

    /** 消耗差值：始终带符号，0 显示为 0。 */
    function signedKilo(value) {
      if (!Number.isFinite(value) || value === 0) return '0'
      return `−${kilo(Math.abs(value))}`
    }

    /**
     * 余额的告警档位。
     *
     * 阈值按单位分开定：一万 token 只够一轮长对话，500 积分对 Qoder 是
     * 一小时，$0.5 对 Cline 也差不多——同一个数字在不同单位下含义不同，
     * 不能共用一个阈值。
     */
    function toneOf(value, unit) {
      if (!Number.isFinite(value)) return 'muted'
      const warn = unit === 'token' ? 100_000 : unit === 'USD' ? 0.5 : unit === '%' ? 20 : 500
      if (value <= 0) return 'danger'
      if (value < warn) return 'warn'
      return 'ok'
    }

    /**
     * 把毫秒差写成「刚刚 / 42 秒 / 3 分钟 / 2 小时」这类短语。
     *
     * 第二个参数给 'en' 时用英文单复数：倒计时会嵌进英文句子里，中英混排的
     * 「(7 天 left)」读起来是断的。不传就跟原来一样是中文。
     */
    function span(ms, locale) {
      if (!Number.isFinite(ms) || ms < 0) return ''
      const en = locale === 'en'
      const unit = (count, one, many) => `${count} ${count === 1 ? one : many}`
      const sec = Math.round(ms / 1000)
      if (sec < 5) return ''
      if (sec < 60) return en ? unit(sec, 'second', 'seconds') : `${sec} 秒`
      const min = Math.round(sec / 60)
      if (min < 60) return en ? unit(min, 'minute', 'minutes') : `${min} 分钟`
      const hour = Math.round(min / 60)
      if (hour < 24) return en ? unit(hour, 'hour', 'hours') : `${hour} 小时`
      return en ? unit(Math.round(hour / 24), 'day', 'days') : `${Math.round(hour / 24)} 天`
    }

    /** 英文月份缩写：悬浮提示里的绝对时间跟随界面语言。 */
    const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

    // ─── 注入的样式表 ────────────────────────────────────────────────────────
    /**
     * 纯 inline style 表达不了 :hover 与过渡，这里注入一份极小的样式表补齐。
     *
     * 只做三件事：行悬停的弱高亮、大栏之间的一条分隔线、折叠三角的旋转。
     * 颜色一律走主题变量，明暗主题自动跟随；宿主不提供 DOM 操作时安静跳过，
     * 退回没有悬停反馈的纯 inline 表现。
     */
    const STYLE_ID = 'dsh-ofm-credit-watch-style'
    let styleInjected = false
    function ensureStyles() {
      if (styleInjected) return
      styleInjected = true
      try {
        if (!document.createElement || !document.head) return
        if (document.getElementById?.(STYLE_ID)) return
        const el = document.createElement('style')
        el.id = STYLE_ID
        el.textContent = [
          '[data-ofm-credit-watch="panel"] .ofm-row{transition:background-color .12s ease}',
          '[data-ofm-credit-watch="panel"] .ofm-row:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4b7bec) 8%,transparent)}',
          '[data-ofm-credit-watch="panel"] .ofm-head{border-radius:8px;transition:background-color .12s ease}',
          '[data-ofm-credit-watch="panel"] .ofm-head:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4b7bec) 6%,transparent)}',
          '[data-ofm-credit-watch="panel"] .ofm-caret{display:inline-block;transition:transform .12s ease;transform-origin:50% 50%}',
          '[data-ofm-credit-watch="panel"] .ofm-section+.ofm-section{margin-top:5px;padding-top:5px;border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.32))}',
        ].join('\n')
        document.head.appendChild(el)
      } catch { /* 宿主不给 DOM 操作：当作已注入，不影响渲染 */ }
    }


    const round2 = value => Math.round(value * 100) / 100

    // ─── 隐藏渠道集合 ────────────────────────────────────────────────────────
    /**
     * 把存储里的原始值收敛成一个干净的 id 集合。
     *
     * 只保留 CHANNELS 里真实存在的 id：OFM 删掉某个渠道后，存储里残留的 id
     * 不该继续影响计数，更不该因为 id 复现而意外隐藏一个"新的"渠道。
     * 坏掉的值（非数组、非字符串项）一律当作"没有隐藏任何东西"。
     */
    function normalizeHidden(raw) {
      const known = new Set(CHANNELS.map(channel => channel.id))
      if (!Array.isArray(raw)) return new Set()
      const out = new Set()
      for (const item of raw) {
        if (typeof item === 'string' && known.has(item)) out.add(item)
      }
      return out
    }

    /** 从 localStorage 读隐藏集合；存储不可用或内容损坏时返回空集合。 */
    /** 大栏隐藏集合：只认四个合法键，其余丢弃。 */
    const HIDDEN_SECTION_KEYS = ['beichen', 'codex', 'ofm', 'workbuddy']
    function normalizeHiddenSections(raw) {
      const out = new Set()
      if (Array.isArray(raw)) {
        for (const item of raw) if (HIDDEN_SECTION_KEYS.includes(item)) out.add(item)
      }
      return out
    }
    function loadHiddenSections() {
      try {
        return normalizeHiddenSections(JSON.parse(window.localStorage?.getItem(HIDDEN_SECTIONS_KEY) ?? 'null'))
      } catch { return new Set() }
    }

    function loadHidden() {
      try {
        return normalizeHidden(JSON.parse(window.localStorage?.getItem(HIDDEN_KEY) ?? 'null'))
      } catch { return new Set() }
    }

    /**
     * 切换一个渠道的可见性，返回新的集合（不改原集合）。
     *
     * 允许隐藏到"一个都不剩"——用户可能就是想让窗口暂时让位；组件里再用
     * 提示引导他回来，比强行保留最后一项更尊重意图。
     */
    function toggleHidden(hidden, id) {
      const next = new Set(hidden)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    }

    // ─── 位置：相对右下角 ────────────────────────────────────────────────────
    /**
     * 读位置。存的是「距右边多少像素」+「距顶部多少像素」。
     *
     * 不存绝对 left：宿主窗口一缩窄，绝对 left 就把卡片顶到屏幕外；存右边距
     * 则天然贴边。顶部仍用绝对值——垂直方向用户往往希望它固定在那里，
     * 而窗口变矮时也不该被挤走。
     *
     * 旧版本存的是 `{left, top}`：顺手迁移一次，别让人升级后卡片跳位置。
     */
    function loadPos() {
      try {
        const raw = JSON.parse(window.localStorage?.getItem(POS_KEY) ?? 'null')
        if (raw && Number.isFinite(raw.relRight) && Number.isFinite(raw.top)) {
          return { relRight: Math.max(0, raw.relRight), top: Math.max(0, raw.top) }
        }
        if (raw && Number.isFinite(raw.left) && Number.isFinite(raw.top)) {
          const width = typeof window.innerWidth === 'number' ? window.innerWidth : 1280
          return {
            relRight: Math.max(0, width - raw.left - PANEL_WIDTH),
            top: Math.max(0, raw.top),
          }
        }
      } catch { /* 存储不可用 */ }
      // 默认贴右上角：这个位置不挡输入框，也是旧版本的默认。
      return { relRight: 16, top: 88 }
    }

    /** 把相对位置解算成实际 left，并夹在视口内。 */
    function leftOf(pos, viewportWidth, panelWidth) {
      const width = Number.isFinite(viewportWidth) ? viewportWidth : 1280
      const panel = Number.isFinite(panelWidth) && panelWidth > 0 ? panelWidth : PANEL_WIDTH
      return Math.max(0, Math.min(width - panel - pos.relRight, width - panel))
    }

    // ─── 尺寸：卡片可拉伸，宽度不再是常量 ────────────────────────────────────
    /**
     * 把尺寸夹进可用范围。
     *
     * `limits` 由调用方按当时的视口与卡片顶部算出：高度上限必须减掉 top，
     * 否则卡片被拉到屏幕底部之外时，右下角手柄自己先出了屏幕，就再也抓不回来。
     * `height` 为 null 表示「高度随内容自适应」，原样穿透。
     */
    function clampSize(size, limits) {
      const maxWidth = Math.max(MIN_WIDTH, Math.round(limits?.maxWidth ?? 1280))
      const maxHeight = Math.max(MIN_HEIGHT, Math.round(limits?.maxHeight ?? 800))
      const rawWidth = Number(size?.width)
      const width = Math.round(Math.min(
        Math.max(Number.isFinite(rawWidth) ? rawWidth : PANEL_WIDTH, MIN_WIDTH), maxWidth))
      if (size?.height === null || size?.height === undefined) return { width, height: null }
      const rawHeight = Number(size.height)
      const height = Math.round(Math.min(
        Math.max(Number.isFinite(rawHeight) ? rawHeight : MIN_HEIGHT, MIN_HEIGHT), maxHeight))
      return { width, height }
    }

    /**
     * 宽度变化后重算「距右边多少」，把左边界钉在原地。
     *
     * 位置存的是相对右边的距离，宽度一变、原来的 relRight 就会把卡片整体推走。
     * 拖动时以左边界为锚重算一次，卡片才是「向右长」而不是「平移」。
     */
    function relRightFor(left, width, viewportWidth) {
      const vw = Number.isFinite(viewportWidth) ? viewportWidth : 1280
      return Math.max(0, Math.round(vw - left - width))
    }

    /** 按视口与卡片顶部算出尺寸上限。 */
    function sizeLimits(top) {
      const vw = typeof window.innerWidth === 'number' ? window.innerWidth : 1280
      const vh = typeof window.innerHeight === 'number' ? window.innerHeight : 800
      const anchor = Number.isFinite(top) ? Math.max(0, top) : 0
      return { maxWidth: vw - SIZE_MARGIN, maxHeight: vh - anchor - SIZE_MARGIN }
    }

    /** 读尺寸。没存过就是默认宽度 + 高度自适应——升级后外观与旧版一致。 */
    function loadSize() {
      try {
        const raw = JSON.parse(window.localStorage?.getItem(SIZE_KEY) ?? 'null')
        if (raw !== null && typeof raw === 'object') return clampSize(raw, sizeLimits())
      } catch { /* 存储不可用 */ }
      return { width: PANEL_WIDTH, height: null }
    }

    /** 写尺寸。 */
    function saveSize(size) {
      try { window.localStorage?.setItem(SIZE_KEY, JSON.stringify(size)) } catch { /* 存储不可用 */ }
    }

    /**
     * 统计界面明细区的高度。
     *
     * `null` 表示随内容自适应——与卡片高度本身同一套语义：没手动拖过就
     * 让内容决定，拖过之后才固定下来。
     */
    function loadStatsSplit() {
      return readSplit(STATS_SPLIT_KEY)
    }

    function saveStatsSplit(height) {
      try { window.localStorage?.setItem(STATS_SPLIT_KEY, String(height)) } catch { /* 存储不可用 */ }
    }

    /** 主界面上下两块的分隔高度；语义与卡片尺寸一致，null 表示随内容。 */
    function loadMainSplit() {
      return readSplit(MAIN_SPLIT_KEY)
    }

    /**
     * 读一个分隔高度。
     *
     * 读到之后按当前视口夹一次：存值可能来自更大的窗口，也可能是旧版本留下的
     * 异常值。不夹的话列表会高过整张卡片，下半区被挤到看不见的地方——
     * 看起来就像「WorkBuddy 分区消失了」。
     */
    function readSplit(key) {
      try {
        const raw = Number(window.localStorage?.getItem(key))
        if (!Number.isFinite(raw) || raw < STATS_SPLIT_MIN) return null
        const vh = typeof window.innerHeight === 'number' ? window.innerHeight : 800
        return clampStatsSplit(raw, vh * 0.6)
      } catch { return null }
    }

    function saveMainSplit(height) {
      try { window.localStorage?.setItem(MAIN_SPLIT_KEY, String(height)) } catch { /* 存储不可用 */ }
    }

    /** 把明细区高度夹进可用范围；上限由调用方按卡片实际高度给。 */
    function clampStatsSplit(height, maxHeight) {
      if (!Number.isFinite(height)) return null
      const max = Math.max(STATS_SPLIT_MIN, Math.round(maxHeight))
      return Math.round(Math.min(Math.max(STATS_SPLIT_MIN, height), max))
    }

    /**
     * 按下后拖了 (dx, dy)，算出卡片的新几何。
     *
     * `rect` 是按下那一刻的四条边界，`dir` 是方向串（'n'/'s'/'w'/'e' 的组合，
     * 如 'se'、'nw'、'e'）。方向里含哪条边就动哪条，没含的保持不动——这就是
     * Windows 窗口的对边固定语义。八个方向共用这一套，不写八份特例。
     *
     * 返回值里两处值得留意：
     * - `relRight` 是「右边界距视口右边多少」，位置就存这个量。拖左边时右边界
     *   不动，它自然不变，所以卡片不会跳；
     * - `vertical` 表示这次拖动碰没碰高度，调用方据此决定要不要把「高度自适应」
     *   换成固定值。
     */
    function resizeFromDrag(rect, dir, dx, dy, limits) {
      const vw = typeof window.innerWidth === 'number' ? window.innerWidth : 1280
      const maxRight = Math.max(rect.left + MIN_WIDTH, Math.round(limits?.maxRight ?? 1e6))
      const maxBottom = Math.max(rect.top + MIN_HEIGHT, Math.round(limits?.maxBottom ?? 1e6))
      let { left, top, right, bottom } = rect
      if (dir.includes('e')) right = Math.min(Math.max(rect.right + dx, rect.left + MIN_WIDTH), maxRight)
      if (dir.includes('w')) left = Math.min(Math.max(rect.left + dx, 0), rect.right - MIN_WIDTH)
      if (dir.includes('s')) bottom = Math.min(Math.max(rect.bottom + dy, rect.top + MIN_HEIGHT), maxBottom)
      if (dir.includes('n')) top = Math.min(Math.max(rect.top + dy, 0), rect.bottom - MIN_HEIGHT)
      return {
        left: Math.round(left),
        top: Math.round(top),
        width: Math.round(right - left),
        height: Math.round(bottom - top),
        relRight: Math.max(0, Math.round(vw - right)),
        vertical: dir.includes('n') || dir.includes('s'),
      }
    }

    // ─── 当日累计账本 ────────────────────────────────────────────────────────
    /** 北京时间下的 YYYY-MM-DD：「今天」必须与用户日历一致，与进程时区无关。 */
    function localDate() {
      try {
        return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
      } catch {
        return new Date().toISOString().slice(0, 10)
      }
    }

    /** 读本地兜底账本；跨天就当作今天还没记过。 */
    function loadLocalDaily() {
      const date = localDate()
      try {
        const raw = JSON.parse(window.localStorage?.getItem(LOCAL_DAILY_KEY) ?? 'null')
        if (raw && raw.date === date && raw.totals && typeof raw.totals === 'object') {
          return { date, totals: normalizeTotals(raw.totals) }
        }
      } catch { /* 存储不可用 */ }
      return { date, totals: {} }
    }

    function saveLocalDaily(data) {
      try { window.localStorage?.setItem(LOCAL_DAILY_KEY, JSON.stringify(data)) } catch { /* 存储不可用 */ }
    }

    /** 把任意形状的累计表收敛成 `{ provider: number }`。 */
    function normalizeTotals(raw) {
      const out = {}
      if (raw && typeof raw === 'object') {
        for (const [provider, value] of Object.entries(raw)) {
          if (Number.isFinite(value)) out[provider] = round2(value)
        }
      }
      return out
    }

    /**
     * 本地兜底：把本轮消耗累加到 localStorage 的当日账本。
     *
     * 只在 Host 路由不可用时启用（例如插件被单独装在没跑 OFM 的宿主上）。
     * 它的基准是内存里的上一轮，所以换浏览器、重载页面都会从 0 重新开始——
     * 这是能接受的降级，不是正确性的替代。
     */
    function accumulateLocal(deltas) {
      const daily = loadLocalDaily()
      for (const [provider, amount] of Object.entries(deltas)) {
        if (Number.isFinite(amount) && amount > 0) {
          daily.totals[provider] = round2((daily.totals[provider] || 0) + amount)
        }
      }
      saveLocalDaily(daily)
      return daily.totals
    }

    // ─── 通道：复刻 OFM 自己的 useChannelRpc ─────────────────────────────────
    /**
     * 从客户端 ctx 里读出 connection 服务。OFM 的写法是「先试 ctx.connection，
     * 再试 ctx.get('connection')」，两条路都存在过（服务可能还没发布，也可能
     * 以 getter 形式暴露），所以这里保持一致。
     */
    function readTransport(ctx) {
      let connection
      try { connection = ctx?.connection } catch { /* 服务尚未提供 */ }
      if (connection === undefined || connection === null) {
        try { connection = ctx?.get?.('connection') } catch { /* 服务尚未提供 */ }
      }
      try {
        const call = connection?.rpc?.call
        return typeof call === 'function' ? { connection, call } : null
      } catch { return null }
    }

    /**
     * 一次 channel-pack RPC。
     *
     * 通道签名与 OFM 完全一致：`call.call(connection.rpc, '/api', 'channel-pack',
     * { method, payload }, signal)`，返回 `{ ok: true, value }` 或
     * `{ ok: false, error }`。channel-pack 侧对每个渠道返回的是
     * `{ accounts: [{ accountId, nickname, balance: { total, packages }, error }] }`。
     */
    async function channelRpc(ctx, method, payload, timeoutMs = RPC_TIMEOUT_MS) {
      const transport = readTransport(ctx)
      if (transport === null) throw new Error('no-connection')
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const result = await transport.call.call(transport.connection.rpc, '/api', 'channel-pack',
          { method, payload }, controller.signal)
        if (result?.ok === true) return result.value
        if (result?.ok === false) throw new Error(result.error?.message ?? result.error?.code ?? 'rpc-failed')
        return result
      } finally {
        clearTimeout(timer)
      }
    }

    /**
     * 从 channel-pack 的 package 里取过期时间。
     *
     * 它只保证 `expiredTime` 与 `cycleEndTime` 两个字段是字符串，实际有的是
     * 空串（表示不过期或上游没给）。取到就截成日期，取不到就留空——tooltip
     * 里对应位置显示什么由调用方决定，这里不编造。
     */
    function expireOf(pkg) {
      for (const key of ['expiredTime', 'cycleEndTime']) {
        const raw = pkg?.[key]
        if (typeof raw === 'string' && raw.trim() !== '') return raw.trim().slice(0, 10)
      }
      return ''
    }

    /**
     * 查一个渠道的余额，归一成 `{ total, accounts, known, failed, unit, packages }`。
     *
     * `total` 是各账号 `balance.total` 之和；一个账号都没报出数字时它是
     * `null`（区别于真的 0），这样界面能分清「没有余额数据」和「余额为 0」。
     */
    async function readChannel(ctx, channel) {
      const value = await channelRpc(ctx, 'credits.balances', { provider: channel.id })
      const accounts = Array.isArray(value?.accounts) ? value.accounts : []
      let total = null
      let known = 0
      let failed = 0
      const packages = []

      for (const row of accounts) {
        const amount = row?.balance?.total
        if (Number.isFinite(amount)) {
          total = (total ?? 0) + amount
          known += 1
        } else {
          failed += 1
        }
        // 余额包明细：同一账号下可能有套餐 / 资源包 / 专用包多个。
        const list = Array.isArray(row?.balance?.packages) ? row.balance.packages : []
        for (const pkg of list) {
          const remaining = Number(pkg?.remaining)
          if (!Number.isFinite(remaining)) continue
          packages.push({
            account: typeof row?.nickname === 'string' ? row.nickname : String(row?.accountId ?? ''),
            name: typeof pkg?.name === 'string' && pkg.name !== '' ? pkg.name : '额度',
            remaining: round2(remaining),
            total: Number.isFinite(Number(pkg?.total)) ? round2(Number(pkg.total)) : round2(remaining),
            unit: unitOf(pkg?.unit),
            expireAt: expireOf(pkg),
          })
        }
      }

      // 单位：明细里第一个能认出来的为准，认不出按渠道默认。
      const fromPackages = packages.find(pkg => pkg.unit !== 'credits')
      const unit = fromPackages?.unit ?? UNIT_BY_PROVIDER[channel.id] ?? 'credits'

      return { total, accounts: accounts.length, known, failed, unit, packages }
    }

    // ─── 账本请求 ────────────────────────────────────────────────────────────
    /** 拉当前账本（挂载时用一次，拿到当天已经累计的部分）。 */
    async function fetchLedger() {
      const res = await fetch(LEDGER_URL, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      return normalizeTotals(data?.totals)
    }

    /**
     * 报一轮读数，拿回 Host 算好的当日累计。
     *
     * 差值必须由 Host 算：同时开两个窗口时，先到的请求推进基准、后到的
     * 自然得到 0，天然幂等；若两边各算各的，同一笔消耗会被记两遍。
     */
    async function postLedger(readings) {
      const res = await fetch(LEDGER_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ readings }),
        cache: 'no-store',
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      return normalizeTotals(data?.totals)
    }

    // ─── WorkBuddy 账号积分 ──────────────────────────────────────────────────

    /**
     * WorkBuddy 的采样节奏与 OFM 渠道分开。
     *
     * 它的成本结构不同：每个账号一次上游读取，账号越多越贵。五分钟一轮
     * 足够看清"今天花了多少"，而每分钟一轮会把这个面板变成上游的主要
     * 压力来源。
     */
    const WB_POLL_MS = 5 * 60_000
    /** 北辰 API 的轮询间隔：一分钟，正好踩在 Host 侧 60 秒缓存边界上。 */
    const BEICHEN_POLL_MS = 60_000

    /** 国内版与国际版是两条并行上游，各自一份账号列表。 */
    const WB_REGIONS = ['cn', 'global']

    /** WorkBuddy 插件提供的只读路由；插件没装或停用时它会 404。 */
    function wbCreditsUrl(region) {
      return `/plugins/dsh-connect-workbuddy/account-credits?region=${region}`
    }

    /** 账本里一个账号的键：带区域，两个区域同号也不会串账。 */
    function wbLedgerKey(region, accountId) {
      return `wb:${region}:${accountId}`
    }

    /**
     * 读一个区域的全部账号及其积分。
     *
     * 返回 `null` 表示这个区域不可用（插件没装、路由 404、网络异常）——
     * 与"有账号但都读不到积分"区分开，前者整块显示未连接，后者逐行显示
     * 没有数据。账号的 `credits` 缺失就是读不到（插件刻意不给 0），
     * 这里保持同样的语义。
     */
    async function fetchWorkBuddyRegion(region) {
      const res = await fetch(wbCreditsUrl(region), { cache: 'no-store' })
      if (!res.ok) return null
      const data = await res.json()
      const list = Array.isArray(data?.accounts) ? data.accounts : []
      return list.map(account => ({
        key: wbLedgerKey(region, String(account?.id ?? '')),
        region,
        id: String(account?.id ?? ''),
        name: typeof account?.accountName === 'string' && account.accountName !== ''
          ? account.accountName
          : String(account?.id ?? ''),
        selected: account?.selected === true,
        credits: Number.isFinite(account?.credits) ? account.credits : null,
      }))
    }

    /** 拉 WorkBuddy 账本（今日 + 累计）。Host 没有这条路由时调用方会退到只显示余额。 */
    async function fetchWorkBuddyLedger() {
      const res = await fetch(`${LEDGER_URL.replace(/\/ledger$/, '')}/wb`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return normalizeWorkBuddy(await res.json())
    }

    /** 报一轮 WorkBuddy 读数，拿回 Host 算好的今日与累计。 */
    async function postWorkBuddyLedger(readings) {
      const res = await fetch(`${LEDGER_URL.replace(/\/ledger$/, '')}/wb`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ readings }),
        cache: 'no-store',
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return normalizeWorkBuddy(await res.json())
    }

    /**
     * 把若干个可能的消耗值加起来。
     *
     * 全都没有数字时返回 null，而不是 0——「没记到账」与「今天一分没花」
     * 是两件事，界面上要能分开显示。
     */
    function sumSpend(values) {
      let sum = 0
      let seen = false
      for (const value of values) {
        if (Number.isFinite(value)) { sum += value; seen = true }
      }
      return seen ? Math.round(sum * 100) / 100 : null
    }

    /** 把账本响应收敛成两张只含数字的表。 */
    function normalizeWorkBuddy(raw) {
      return {
        daily: normalizeTotals(raw?.daily),
        cumulative: normalizeTotals(raw?.cumulative),
      }
    }

    // ─── token 用量 ─────────────────────────────────────────────────────────

    /**
     * 一天的总 token 数。
     *
     * 与 cost-meter 面板的口径一致：输入 + 缓存读 + 输出合成一个数。
     * 缓存读通常占大头（一次长对话能到输入输出的十几倍），把它单列出来
     * 会让「今天用了多少」这个问题反而没有答案。
     */
    function totalTokens(row) {
      if (row === null || row === undefined) return null
      const sum = (row.input || 0) + (row.cacheRead || 0) + (row.output || 0)
      return sum > 0 || row.calls > 0 ? sum : null
    }

    /** token 用量的紧凑写法：76.4M / 391K / 1200。 */
    function formatTokens(value) {
      if (!Number.isFinite(value)) return '—'
      return kilo(value)
    }

    /**
     * 拉北辰 API 的余额与按日用量。
     *
     * 不走 channel-pack：北辰是中转网关，余额得由 Host 侧用 API Key 去问，
     * 而且那条接口只回当天，多天趋势是 Host 自己逐日攒下来的。失败时抛出去，
     * 调用方保留上一轮读数。
     */
    async function fetchBeichen() {
      const res = await fetch(BEICHEN_URL, { cache: 'no-store' })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return await res.json()
    }

    /** 拉 GPT 订阅限额快照。订阅插件没装或还没驱动过时 available 为 false。 */
    async function fetchCodex() {
      const res = await fetch(CODEX_URL, { cache: 'no-store' })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return await res.json()
    }

    /** 拉 OFM 免费模型的今日 token 用量。cost-meter 没装时 available 为 false。 */
    async function fetchOfmTokens() {
      const res = await fetch(OFM_TOKENS_URL, { cache: 'no-store' })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return await res.json()
    }

    /** 拉 cost-meter 的按天用量。返回 { available, days }。 */
    async function fetchUsage() {
      const res = await fetch(USAGE_URL, { cache: 'no-store' })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const data = await res.json()
      return {
        available: data?.available === true,
        days: Array.isArray(data?.days) ? data.days : [],
      }
    }

    /**
     * 取某一天的用量记录。
     *
     * 主界面显示的是「今天花了多少」，所以必须按今天的日期精确取，不能取
     * 「账本里最后一条」——跨天之后今天还没有调用时，最后一条是昨天的，
     * 那样数字会一直挂着昨天的不清零。
     *
     * 找不到（今天还没产生调用）时返回 null，由调用方显示占位，而不是拿
     * 昨天的数顶上。
     */
    function usageOfDate(days, date) {
      if (!Array.isArray(days)) return null
      for (const day of days) {
        if (day !== null && day !== undefined && day.date === date) return day
      }
      return null
    }

    /** 在一组按日期升序的日子里取某天的下标；找不到返回 -1。 */
    function indexOfDate(days, date) {
      for (let i = 0; i < days.length; i += 1) {
        if (days[i]?.date === date) return i
      }
      return -1
    }

    /** tooltip：账号 + 各积分包构成。 */
    function tooltipOf(row) {
      const lines = []
      if (row.accounts > 1) lines.push(fill('{count} 个账号', { count: row.accounts }))
      // 按账号分组，方便对上"哪个号还剩多少"。余额为 0 的包不占地方。
      const groups = new Map()
      for (const pkg of row.packages ?? []) {
        if (!(pkg.remaining > 0)) continue
        if (!groups.has(pkg.account)) groups.set(pkg.account, [])
        groups.get(pkg.account).push(pkg)
      }
      let printed = 0
      for (const [account, list] of groups) {
        if (printed >= 12) break
        if (account !== '') { lines.push(account); printed += 1 }
        for (const pkg of list) {
          if (printed >= 12) break
          const amount = `${formatAmount(pkg.remaining, pkg.unit)}/${formatAmount(pkg.total, pkg.unit)}`
          const expire = pkg.expireAt === '' ? '' : ` · ${fill('{date} 过期', { date: pkg.expireAt })}`
          lines.push(`${pkg.name} ${amount}${expire}`)
          printed += 1
        }
      }
      if (row.ok === false && row.error) lines.push(row.error)
      return lines.join('\n')
    }

    // ─── 组件 ────────────────────────────────────────────────────────────────
    /**
     * 悬浮窗主体。
     *
     * 状态分为四层：
     *   - `rows`    本轮各渠道读数（剩余、账号数、失败数、单位、余额包）；
     *   - `delta`   本轮减上一轮的消耗（只在余额下降时为正）；
     *   - `today`   当日累计消耗（Host 算，Host 不可用时本地兜底）；
     *   - `lastSpent` 每个渠道最近一次出现正消耗的时间戳，用来给排序定序。
     */
    function CreditWatch(props) {
      const { ctx } = props
      const [lang] = useState(() => {
        try {
          const tag = String(document.documentElement?.lang ?? navigator.language ?? '')
          return tag.toLowerCase().startsWith('zh') ? 'zh' : 'en'
        } catch { return 'zh' }
      })
      const t = useCallback((key, values) => {
        const table = DICT[lang] ?? DICT.zh
        return fill(table[key] ?? DICT.zh[key] ?? key, values ?? {})
      }, [lang])

      const [rows, setRows] = useState([])
      const [delta, setDelta] = useState({})
      const [lastSpent, setLastSpent] = useState({})
      const [loading, setLoading] = useState(false)
      const [updatedAt, setUpdatedAt] = useState(0)
      const [error, setError] = useState('')
      const [now, setNow] = useState(() => Date.now())

      // 位置与折叠状态：读一次 localStorage，读不到用默认值（右上角）。
      const [pos, setPos] = useState(loadPos)
      const [collapsed, setCollapsed] = useState(() => {
        try { return window.localStorage?.getItem(COLLAPSE_KEY) === '1' } catch { return false }
      })
      const [hidden, setHidden] = useState(false)
      // 被用户隐藏的渠道；只影响渲染，不影响轮询——取消勾选后再勾回来，
      // 数字是现成的，不用等下一分钟。
      const [hiddenIds, setHiddenIds] = useState(loadHidden)
      // 配置面板是否展开（就地展开，不弹窗）。
      const [configOpen, setConfigOpen] = useState(false)
      // 当日累计消耗（provider → 数量）。
      const [today, setToday] = useState(() => loadLocalDaily().totals)
      // 卡片尺寸。height 为 null 表示高度随内容自适应：只有拖过右下角才会
      // 固定下来，因此老用户升级后看到的卡片与原来一样高。
      const [size, setSize] = useState(loadSize)

      // WorkBuddy 账号：各行读数、账本（今日/累计）、是否展开、是否连得上。
      // 与 OFM 渠道完全独立——它有自己的节拍与账本，WorkBuddy 没装时
      // 不影响 OFM 那半边的任何行为。
      const [wbRows, setWbRows] = useState([])
      const [wbLedger, setWbLedger] = useState({ daily: {}, cumulative: {} })
      const [wbConnected, setWbConnected] = useState(true)
      // 默认展开：没存过就列出账号——这块分区的意义就是「每个账号今天花了多少」，
      // 折叠着等于没显示。只有用户主动收起过（存了 '0'）才保持折叠。
      const [wbOpen, setWbOpen] = useState(() => {
        try { return window.localStorage?.getItem(WB_OPEN_KEY) !== '0' } catch { return true }
      })
      // WorkBuddy 自己的刷新态：与渠道的 loading 分开，两者互不等待，
      // 标题栏的转圈图标把两个合成一个显示。
      const [wbLoading, setWbLoading] = useState(false)

      // 视图：列表 / 统计。整张卡片切换，不额外开窗——悬浮层里再叠一层
      // 窗口，层级与拖动都要各管一套，收益抵不上复杂度。
      const [view, setView] = useState(() => {
        try { return window.localStorage?.getItem(VIEW_KEY) === 'stats' ? 'stats' : 'list' } catch { return 'list' }
      })
      // cost-meter 的按天用量。available 为 false 表示那份账本读不到。
      const [usage, setUsage] = useState({ available: true, days: [] })
      // 统计界面当前选中的日期；空串表示"还没选，跟最新一天走"。
      const [usageDate, setUsageDate] = useState('')
      // 统计界面「渠道明细」区的高度：null 表示随内容自适应，拖过分隔条后固定。
      const [statsSplit, setStatsSplit] = useState(loadStatsSplit)
      // 主界面「渠道列表」区的高度：同上，拖过中间的横条后固定。
      const [mainSplit, setMainSplit] = useState(loadMainSplit)
      // 北辰 API 的余额与按日用量；null 表示还没取到过（首轮之前）。
      // 声明放在所有 useState 之后：离线渲染测试按声明顺序取下标注入状态，
      // 插在中间会把后面每一个状态都挤错位。
      const [beichen, setBeichen] = useState(null)
      // GPT 订阅限额快照与 OFM 模型今日 token：同样接在末尾，原因同上。
      const [codex, setCodex] = useState(null)
      const [ofmTokens, setOfmTokens] = useState(null)
      // 大栏隐藏集合：北辰 / GPT 订阅 / OFM 模型 / WorkBuddy 可在设置面板勾掉。
      const [hiddenSections, setHiddenSections] = useState(() => loadHiddenSections())
      // 写入与翻转必须在组件内：引用本组件的 state setter。放模块层会拿到
      // 未定义的 setter，点击时抛 ReferenceError，React 把异常吞掉后表现为
      // 「勾选框点不动」。
      const persistHiddenSections = useCallback(next => {
        setHiddenSections(next)
        try { window.localStorage?.setItem(HIDDEN_SECTIONS_KEY, JSON.stringify([...next])) } catch { /* 存储不可用 */ }
      }, [])
      const toggleHiddenSections = useCallback((set, key) => {
        const next = new Set(set)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
      }, [])
      // GPT 分区自己的折叠状态：默认收起，与北辰一致。
      const [codexOpen, setCodexOpen] = useState(() => {
        try { return window.localStorage?.getItem(CODEX_OPEN_KEY) === '1' } catch { return false }
      })
      // 北辰分区默认折叠：它与渠道列表是两套账，日常只看标题栏那行就够。
      const [beichenOpen, setBeichenOpen] = useState(() => {
        try { return window.localStorage?.getItem(BEICHEN_OPEN_KEY) === '1' } catch { return false }
      })
      // OFM 模型分区的折叠状态：同样默认收起。
      const [ofmOpen, setOfmOpen] = useState(() => {
        try { return window.localStorage?.getItem(OFM_OPEN_KEY) === '1' } catch { return false }
      })

      // 上一轮读数与串行保护：轮询和手动刷新可能重叠，只允许最新一轮落库。
      const previous = useRef(null)
      const generation = useRef(0)
      const alive = useRef(true)
      // 账本走 Host 还是本地兜底，决定 delta 记到哪儿。
      const ledgerMode = useRef('host')

      // WorkBuddy 的采样代次：与渠道轮询的 generation 分开，两套节拍互不打断。
      const wbGeneration = useRef(0)

      const persistPos = useCallback(next => {
        setPos(next)
        try { window.localStorage?.setItem(POS_KEY, JSON.stringify(next)) } catch { /* 存储不可用 */ }
        // 位置变了立刻移动：等下一次 render 再算会有一次跳动。两个方向一起写，
        // 只写 left 时纵向要慢一帧，斜着拖会看着像卡片在飘。
        const root = document.querySelector('[data-ofm-credit-watch]')
        if (root) {
          root.style.left = `${leftOf(next, window.innerWidth, root.offsetWidth)}px`
          root.style.top = `${Math.round(next.top)}px`
        }
      }, [])

      /**
       * 写回尺寸，并按锚点重算位置。
       *
       * 拖动时每帧都走这里：一边落盘，一边直接改 DOM——等下一次 render 才生效
       * 会迟一帧，手感上就是"粘不住"。`anchor` 是这一帧算出来的左上角：
       * 右边界换算成「距视口右边多少」，上边界直接写回 `top`。两个方向都写，
       * 八个方向才能在拖自己那条边时真的移动它。
       *
       * 尺寸夹取交给调用方（拖拽走 resizeFromDrag、视口变化走 clampSize）：
       * 在这里再夹一次会覆盖掉"对边固定"的结果，把卡片推走。
       */
      const persistSize = useCallback((next, anchor) => {
        const vw = typeof window.innerWidth === 'number' ? window.innerWidth : 1280
        setSize(next)
        saveSize(next)
        const left = Math.min(Math.max(0, anchor?.left ?? 0), Math.max(0, vw - next.width))
        const top = Number.isFinite(anchor?.top) ? Math.max(0, Math.round(anchor.top)) : null
        setPos(prev => {
          const merged = {
            ...prev,
            relRight: relRightFor(left, next.width, vw),
            // 上面那条边也要写回：拖上边时高度变大、上边界同时上移，只更新
            // relRight 会让上边界留在原地，看起来就成了"拉上边动下边"。
            top: top === null ? prev.top : top,
          }
          try { window.localStorage?.setItem(POS_KEY, JSON.stringify(merged)) } catch { /* 存储不可用 */ }
          return merged
        })
        const root = document.querySelector('[data-ofm-credit-watch="panel"]')
        if (root) {
          root.style.width = `${next.width}px`
          // 折叠时不能把保存的展开高度写回 DOM，否则重启后的窗口尺寸事件
          // 会把只有标题栏的卡片撑出一大片空白。
          root.style.height = collapsed || next.height === null ? 'auto' : `${next.height}px`
          root.style.left = `${left}px`
          // 上边界同样要同步写。高度立刻变了、上边界还在等重渲染时，中间态
          // 就是"新高度 + 旧上边界"，底边被推出去；pointermove 属于 continuous
          // 事件，重渲染不保证赶在同一次绘制之前，中间态会被画出来。
          if (top !== null) root.style.top = `${top}px`
        }
      }, [collapsed])

      /**
       * 大栏折叠/展开后，把手动拉出的固定高度重置为自适应。
       *
       * 固定高度下大栏切换不会改变卡片高度，内容只在固定框里滚动，用户
       * 看不到「展开变大、折叠变小」的联动。重置成自适应后，高度回到
       * 「标题栏 + 内容（内容区仍封顶 320px）」的随内容模型，切换大栏才有
       * 可见变化。本就处于自适应时直接返回，不触发多余渲染与写盘。
       */
      const resetAutoHeight = useCallback(() => {
        if (size.height === null) return
        const next = { ...size, height: null }
        setSize(next)
        saveSize(next)
      }, [size])

      /**
       * 写回隐藏集合。先更新界面再落盘：即使 localStorage 不可用（隐私模式、
       * 沙盒 iframe），本次会话内的勾选也要立刻生效。
       */
      const persistHidden = useCallback(next => {
        setHiddenIds(next)
        try {
          window.localStorage?.setItem(HIDDEN_KEY, JSON.stringify([...next]))
        } catch { /* 存储不可用，本次会话仍生效 */ }
      }, [])

      const poll = useCallback(async () => {
        const seq = generation.current + 1
        generation.current = seq
        setLoading(true)
        setError('')
        // 一个渠道失败不该拖垮整轮：各自 settled，失败的行按 failureRow 的
        // 时效规则决定是沿用还是改显没有数据。
        //
        // 隐藏渠道降频：看不见的渠道不必每分钟占用一次上游往返；本轮跳过的
        // 渠道返回 `skip`，下面渲染时原样保留上一行。
        const roundAt = Date.now()
        const results = await mapLimit(CHANNELS, MAX_CONCURRENCY, async channel => {
          const before = previous.current?.find(item => item.id === channel.id)
          // 用上一轮的采样时间（at），不是上一次成功的时间：失败也算查过，
          // 否则一个坏掉的隐藏渠道会每轮都被重试。
          if (!shouldPollChannel(hiddenIds.has(channel.id), before?.at, roundAt)) {
            return { channel, skip: true }
          }
          try {
            const reading = await readChannel(ctx, channel)
            return { channel, ok: true, reading }
          } catch (caught) {
            return { channel, ok: false, message: String(caught?.message ?? caught) }
          }
        })
        if (!alive.current || seq !== generation.current) return

        const stamp = Date.now()
        const prev = previous.current
        const freshDelta = {}
        const spentAt = {}
        const nextRows = results.map(({ channel, ok, reading, message, skip }) => {
          const before = prev?.find(item => item.id === channel.id)
          // 本轮跳过的隐藏渠道：整行原样留着，连带上一次的成功时间戳。
          if (skip) {
            return before ?? {
              id: channel.id, ...channel, ok: true, at: stamp, lastOkAt: 0,
              total: null, accounts: 0, failed: 0,
              unit: UNIT_BY_PROVIDER[channel.id] ?? 'credits', packages: [],
            }
          }
          const row = { id: channel.id, ...channel, ok, at: stamp }
          if (!ok) {
            // 失败：按 failureRow 的时效规则决定沿用还是清空——沿用过头会把
            // 半小时前的余额当成"现在还剩多少"。原因要带到行上给 tooltip。
            return {
              ...row,
              ...failureRow(before, stamp),
              failed: 1,
              error: message,
            }
          }
          row.total = reading.total
          row.accounts = reading.accounts
          row.failed = reading.failed
          row.unit = reading.unit
          row.packages = reading.packages
          row.lastOkAt = stamp
          // 只有上一轮也报出过数字、且本轮更低时才算消耗。领积分会让余额上升，
          // 那不是负消耗，不该出现在「本分钟」栏里。
          if (before && Number.isFinite(before.total) && Number.isFinite(row.total) && row.total < before.total) {
            freshDelta[channel.id] = before.total - row.total
            spentAt[channel.id] = stamp
          }
          return row
        })
        previous.current = nextRows
        setRows(nextRows)
        setDelta(freshDelta)
        if (Object.keys(spentAt).length > 0) {
          setLastSpent(existing => ({ ...existing, ...spentAt }))
        }

        // 账本：读数交给 Host 累计；Host 不可用就退到本地兜底。
        // 跳过的渠道报 null——本轮没有新读数，让 Host 保持原基准不动。
        const readings = results.map(({ channel, ok, reading, skip }) => ({
          provider: channel.id,
          total: ok && !skip ? reading.total : null,
        }))
        let totals = null
        try {
          totals = await postLedger(readings)
          ledgerMode.current = 'host'
        } catch {
          ledgerMode.current = 'local'
          totals = accumulateLocal(freshDelta)
        }
        if (!alive.current || seq !== generation.current) return
        if (totals !== null) setToday(totals)

        setUpdatedAt(stamp)
        setLoading(false)
        // 只有真正查过且全失败才算整体出错；全部跳过（都隐藏且未到重查间隔）
        // 不是故障，别在标题栏报红。
        const attempted = results.filter(item => item.skip !== true)
        if (attempted.length > 0 && attempted.every(item => !item.ok)) setError(t('retryOnNext'))
      }, [ctx, t, hiddenIds])

      useEffect(() => {
        alive.current = true
        // 挂载时先拿一次账本：Host 里可能已经有今天早些时候的累计。
        void fetchLedger().then(totals => {
          if (!alive.current) return
          ledgerMode.current = 'host'
          setToday(totals)
        }).catch(() => { /* Host 没有账本路由，等 poll 走本地兜底 */ })
        void poll()
        return () => { alive.current = false }
        // 只在挂载时跑一次；轮询循环由下面那个 effect 负责。
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      // 轮询：标签页可见时才跑。隐藏时上游不会因为浏览器不看而少花积分，
      // 但把 RPC 停掉既省往返也让「本分钟消耗」在回到前台时立刻更新。
      useEffect(() => {
        let timer
        const start = () => {
          if (timer !== undefined) return
          timer = window.setInterval(() => { void poll() }, POLL_MS)
        }
        const stop = () => {
          if (timer === undefined) return
          window.clearInterval(timer)
          timer = undefined
        }
        const onVisibility = () => {
          if (document.visibilityState === 'visible') { void poll(); start() } else { stop() }
        }
        start()
        document.addEventListener('visibilitychange', onVisibility)
        return () => { stop(); document.removeEventListener('visibilitychange', onVisibility) }
      }, [poll])

      /**
       * 采一轮 token 用量。
       *
       * 与 WorkBuddy 同一个节拍：cost-meter 的账本是"有调用才写"，拉得再勤
       * 也不会更准。失败时保留上一轮的数据，别让统计页整片变空。
       */
      const pollUsage = useCallback(async () => {
        try {
          const next = await fetchUsage()
          if (!alive.current) return
          setUsage(next)
        } catch { /* Host 没有用量路由：保持上一轮 */ }
      }, [])

      /** 采一轮 GPT 订阅限额；失败保留上一轮。 */
      const pollCodex = useCallback(async () => {
        try {
          const next = await fetchCodex()
          if (!alive.current) return
          if (next?.available !== false) setCodex(next)
        } catch { /* 保留上一轮 */ }
      }, [])

      /** 采一轮 OFM 模型今日 token；失败保留上一轮。 */
      const pollOfmTokens = useCallback(async () => {
        try {
          const next = await fetchOfmTokens()
          if (!alive.current) return
          if (next?.available !== false) setOfmTokens(next)
        } catch { /* 保留上一轮 */ }
      }, [])

      /**
       * 采一轮北辰 API。
       *
       * 节拍跟 WorkBuddy 走：Host 侧对上游有 60 秒缓存，拉得再勤也不会更准。
       * 失败时保留上一轮读数——余额看不见比余额略旧更糟。
       */
      const pollBeichen = useCallback(async () => {
        try {
          const next = await fetchBeichen()
          if (!alive.current) return
          // 上游一时读不到时保留上一轮：断一下网不该让余额整行消失。
          if (next?.ok === true || next?.configured === false) setBeichen(next)
        } catch { /* Host 没有这条路由：保留上一轮 */ }
      }, [])

      /**
       * 采一轮 WorkBuddy：读两个区域的账号积分，交给 Host 记账，取回今日与累计。
       *
       * 报给账本的是"每个账号当前的积分总量"。跳不跳过一个账号由 Host 判断
       * （读不到就不动基准），这里只如实上报 null，不自作主张填 0。
       */
      const pollWorkBuddy = useCallback(async () => {
        const seq = wbGeneration.current + 1
        wbGeneration.current = seq
        setWbLoading(true)
        const regions = await Promise.all(WB_REGIONS.map(async region => {
          try { return await fetchWorkBuddyRegion(region) } catch { return null }
        }))
        if (!alive.current || seq !== wbGeneration.current) return
        setWbLoading(false)
        // 两个区域都取不到才叫"没连上"：只有一个区域有账号时另一个本就返回空。
        const connected = regions.some(list => list !== null)
        const rows = connected ? regions.flatMap(list => list ?? []) : []
        setWbConnected(connected)
        setWbRows(rows)
        if (!connected) return

        try {
          const ledger = await postWorkBuddyLedger(rows.map(row => ({ key: row.key, total: row.credits })))
          if (!alive.current || seq !== wbGeneration.current) return
          setWbLedger(ledger)
        } catch {
          // Host 账本不可用：余额照旧显示，消耗列留空，而不是让整块消失。
        }
      }, [])

      useEffect(() => {
        alive.current = true
        // 先取一次账本，让刚打开窗口时就能看到今天早些时候的累计。
        void fetchWorkBuddyLedger().then(ledger => {
          if (alive.current) setWbLedger(ledger)
        }).catch(() => { /* Host 没有 wb 账本路由，等采样时再试 */ })
        void pollWorkBuddy()
        void pollUsage()
        let timer
        const start = () => {
          if (timer !== undefined) return
          timer = window.setInterval(() => {
            void pollWorkBuddy()
            void pollUsage()
          }, WB_POLL_MS)
        }
        const stop = () => {
          if (timer === undefined) return
          window.clearInterval(timer)
          timer = undefined
        }
        // 与 OFM 轮询同一套可见性规则：看不见的时候不采样。
        const onVisibility = () => {
          if (document.visibilityState === 'visible') { void pollWorkBuddy(); void pollUsage(); start() } else { stop() }
        }
        start()
        document.addEventListener('visibilitychange', onVisibility)
        return () => {
          stop()
          document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [pollWorkBuddy, pollUsage])

      // 北辰单独一分钟一轮：它跟 WorkBuddy 的五分钟不是同一个来源，
      // 余额变化也更值得及时看到。可见性规则与上面一致。
      useEffect(() => {
        let timer
        const start = () => {
          if (timer !== undefined) return
          timer = window.setInterval(() => { void pollBeichen() }, BEICHEN_POLL_MS)
        }
        const stop = () => {
          if (timer === undefined) return
          window.clearInterval(timer)
          timer = undefined
        }
        const onVisibility = () => {
          if (document.visibilityState === 'visible') { void pollBeichen(); start() } else { stop() }
        }
        void pollBeichen()
        start()
        document.addEventListener('visibilitychange', onVisibility)
        return () => {
          stop()
          document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [pollBeichen])

      // GPT 订阅与 OFM token 跟北辰同一分钟节拍：三个都是只读快照，
      // 多打一次也只多一次本地读文件。
      useEffect(() => {
        void pollCodex()
        void pollOfmTokens()
        const timer = window.setInterval(() => { void pollCodex(); void pollOfmTokens() }, BEICHEN_POLL_MS)
        return () => window.clearInterval(timer)
      }, [pollCodex, pollOfmTokens])

      // 注入悬停与过渡用的样式表。放在 effect 里：渲染阶段不碰 DOM，宿主
      // 不支持时 ensureStyles 自己安静跳过，退回纯 inline 表现。
      useEffect(() => { ensureStyles() }, [])

      // 每 10 秒走一次"现在"，让"3 分钟前有消耗"这类相对时间自己走字，
      // 而不用为了刷新相对时间重发 RPC。
      useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), 10_000)
        return () => window.clearInterval(timer)
      }, [])

      // 视口变化后先夹尺寸、再贴回右边：位置存的是相对右边的距离，
      // 窗口一缩窄，卡片宽度本身也可能超出视口，两样都要重新解算。
      useEffect(() => {
        const onResize = () => {
          const root = document.querySelector('[data-ofm-credit-watch]')
          if (!root) return
          const vw = typeof window.innerWidth === 'number' ? window.innerWidth : 1280
          const vh = typeof window.innerHeight === 'number' ? window.innerHeight : 800
          // 视口变小：先把尺寸夹回可用范围，再按原来的右边距贴回去。
          const settled = clampSize(size, sizeLimits(pos.top))
          const top = settled.height === null
            ? pos.top
            : Math.max(0, Math.min(pos.top, vh - settled.height - SIZE_MARGIN))
          persistSize(settled, { left: leftOf(pos, vw, settled.width), top })
        }
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [pos, size, persistSize])

      // ── 拖动 ────────────────────────────────────────────────────────────
      // 用 pointer 事件而不是 mouse：触摸屏与手写笔同样可用，且 setPointerCapture
      // 让指针移出窗口时拖动不中断。拖动期间不更新 React 状态里的位置以外的东西。
      const drag = useRef(null)
      const onPointerDown = useCallback(event => {
        if (event.button !== undefined && event.button !== 0) return
        const target = event.currentTarget
        const root = target?.closest?.('[data-ofm-credit-watch]')
        if (root === null || root === undefined) return
        const rect = root.getBoundingClientRect()
        drag.current = { dx: event.clientX - rect.left, dy: event.clientY - rect.top }
        try { target.setPointerCapture?.(event.pointerId) } catch { /* 非指针环境 */ }
        event.preventDefault()
      }, [])
      const onPointerMove = useCallback(event => {
        const state = drag.current
        if (state === null) return
        const root = event.currentTarget?.closest?.('[data-ofm-credit-watch]')
        const width = root?.offsetWidth ?? PANEL_WIDTH
        const height = 48
        const left = Math.min(Math.max(0, event.clientX - state.dx), Math.max(0, window.innerWidth - width))
        const top = Math.min(Math.max(0, event.clientY - state.dy), Math.max(0, window.innerHeight - height))
        // 存相对右边的距离；窗口一缩窄仍会贴边。
        persistPos({ relRight: Math.max(0, window.innerWidth - left - width), top: Math.round(top) })
      }, [persistPos])
      const onPointerUp = useCallback(event => {
        if (drag.current === null) return
        drag.current = null
        try { event.currentTarget?.releasePointerCapture?.(event.pointerId) } catch { /* 非指针环境 */ }
      }, [])

      // ── 缩放：八个方向共用一套 ──────────────────────────────────────────
      // 与拖动共用 pointer 事件与指针捕获，差别只有方向串。按下时把四条边界
      // 记成基准：拖动中每帧都会重渲染，用实时值当基准会把位移叠加进去。
      const resize = useRef(null)
      const resizeHandlers = dir => ({
        onPointerDown: event => {
          if (event.button !== undefined && event.button !== 0) return
          // 折叠时的高度就是标题栏，纵向没有可拉的余地：这类方向不响应。
          const mode = collapsed ? dir.replace(/[ns]/g, '') : dir
          if (mode === '') return
          const target = event.currentTarget
          const root = target?.closest?.('[data-ofm-credit-watch]')
          if (root === null || root === undefined) return
          const rect = root.getBoundingClientRect()
          resize.current = {
            mode,
            startX: event.clientX,
            startY: event.clientY,
            rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
            fixedHeight: size.height,
          }
          try { target.setPointerCapture?.(event.pointerId) } catch { /* 非指针环境 */ }
          event.preventDefault()
          event.stopPropagation()
        },
        onPointerMove: event => {
          const state = resize.current
          if (state === null) return
          const vw = typeof window.innerWidth === 'number' ? window.innerWidth : 1280
          const vh = typeof window.innerHeight === 'number' ? window.innerHeight : 800
          const moved = resizeFromDrag(
            state.rect, state.mode,
            event.clientX - state.startX, event.clientY - state.startY,
            { maxRight: vw - SIZE_MARGIN, maxBottom: vh - SIZE_MARGIN })
          persistSize({
            width: moved.width,
            // 没碰纵向就保持原来的高度语义：该自适应还自适应。
            height: moved.vertical ? moved.height : state.fixedHeight,
          }, { left: moved.left, top: moved.top })
        },
        onPointerUp: event => {
          if (resize.current === null) return
          resize.current = null
          try { event.currentTarget?.releasePointerCapture?.(event.pointerId) } catch { /* 非指针环境 */ }
        },
        // 双击复位：拉坏了不用去翻配置文件，回到默认宽度 + 高度自适应。
        onDoubleClick: event => {
          event.preventDefault()
          event.stopPropagation()
          const root = event.currentTarget?.closest?.('[data-ofm-credit-watch]')
          const rect = root?.getBoundingClientRect?.()
          persistSize({ width: PANEL_WIDTH, height: null },
            { left: rect?.left ?? 0, top: rect?.top ?? pos.top })
        },
      })

      // ── 统计界面：分隔条拖动 ────────────────────────────────────────────
      // 与卡片八向缩放同一套 pointer 捕获：拖出卡片范围也不中断。
      // 存的是明细区高度；上限取「卡片内容区还要给下半区留位置」之后的值。
      const splitDrag = useRef(null)
      /**
       * 分隔条的拖动处理。
       *
       * 两块（主界面 / 统计界面）的分隔条行为完全一样，只是写回的状态与
       * 持久化键不同，所以抽成一个工厂，不写两份。
       *
       * 按下之后把 pointermove / pointerup 挂到 window 上，而不是靠元素自己的
       * pointer capture：拖动会改状态、触发重渲染，一旦分隔条那个 DOM 节点被
       * 换掉，捕获就失效、后续事件全丢，表现就是「光标变了但拖不动」。挂在
       * window 上则与元素存亡无关，指针拖出卡片范围也不会中断。
       */
      function makeSplitHandlers({ listSelector, onStart, onChange, onCommit, onReset }) {
        const stop = () => {
          const state = splitDrag.current
          splitDrag.current = null
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', stop)
          window.removeEventListener('pointercancel', stop)
          if (state !== null) state.onCommit()
        }
        const move = event => {
          const state = splitDrag.current
          if (state === null) return
          // 夹进 [下限, 上限]：下限是内容自然高度，往上拖到它就停，不会把行压扁。
          const raw = state.startHeight + (event.clientY - state.startY)
          const floor = Number.isFinite(state.minHeight) ? state.minHeight : STATS_SPLIT_MIN
          const ceiling = Math.max(floor, Number.isFinite(state.maxHeight) ? state.maxHeight : raw)
          state.onChange(Math.round(Math.min(Math.max(floor, raw), ceiling)))
          event.preventDefault()
        }
        return {
          onPointerDown: event => {
            if (event.button !== undefined && event.button !== 0) return
            const list = event.currentTarget?.parentElement?.querySelector?.(listSelector)
            if (list === null || list === undefined) return
            // 上限取「卡片可用高度减一个最小块」：拖到顶就是列表占满、下半区还剩最小块。
            // 用 body 的 clientHeight 而不是列表自己的高度——用后者的话拖动量
            // 一大就到底，往下拖会立刻没有余量。
            const body = list.parentElement
            const available = body?.clientHeight || 320
            if (typeof onStart === 'function') onStart()
            // 下限用实测的内容自然高度：渠道 4 个时内容只有 ~90px，钉在 48 会把行压扁。
            // scrollHeight 是「不滚动时该有多高」，拖到它就停住，行高保持正常。
            const natural = Math.round(list.scrollHeight)
            // 下方余量：body 里除去列表还剩多少，列表可以把它征用。
            const below = Math.max(0, available - list.offsetHeight)
            // 自适应卡片（body 高度 == 列表高度）时余量是 0，直接算出上限就等于
            // 下限——向下拖会被立刻夹住。此时给一个「撑高卡片」的额度，让拖动
            // 表现为把列表拉大、卡片跟着长高。onStart 已把卡片高度固化，所以
            // 撑大是真实发生的高度变化，行不会被压扁。
            const grow = below > 0 ? 0 : Math.max(160, Math.round(list.scrollHeight))
            const ceiling = Math.max(Math.round(list.scrollHeight) + below + grow, list.offsetHeight, STATS_SPLIT_MIN)
            splitDrag.current = {
              startY: event.clientY,
              startHeight: list.offsetHeight,
              minHeight: Math.max(1, natural),
              maxHeight: ceiling,
              onChange, onCommit,
            }
            window.addEventListener('pointermove', move)
            window.addEventListener('pointerup', stop)
            window.addEventListener('pointercancel', stop)
            event.preventDefault()
            event.stopPropagation()
          },
          onDoubleClick: event => {
            event.preventDefault()
            event.stopPropagation()
            onReset()
          },
        }
      }

      // 统计界面：明细区高度。
      const splitHandlers = makeSplitHandlers({
        listSelector: '[data-stats-list]',
        onChange: setStatsSplit,
        onCommit: () => setStatsSplit(current => {
          if (current !== null) saveStatsSplit(current)
          return current
        }),
        onReset: () => {
          setStatsSplit(null)
          try { window.localStorage?.removeItem(STATS_SPLIT_KEY) } catch { /* 存储不可用 */ }
        },
      })

      // 隐藏态小胶囊上那个总数：所有有余额的渠道合计。
      const total = useMemo(() => {
        let sum = 0
        let seen = false
        for (const row of rows) {
          if (Number.isFinite(row.total)) { sum += row.total; seen = true }
        }
        return seen ? sum : null
      }, [rows])

      // 标题栏的转圈：两套上游任一在刷新就转，用户按一次钮能看到它确实动了。
      const busy = loading || wbLoading

      const headerWhen = updatedAt === 0 ? t('never')
        : (() => {
          const age = now - updatedAt
          const phrase = span(age, lang)
          return phrase === '' ? t('now') : fill(t('ago'), { when: phrase })
        })()

      // ── 样式 ────────────────────────────────────────────────────────────
      // 只引用主题变量，明暗主题自动跟随。悬浮层本身是点击穿透的，
      // 因此窗口容器显式恢复 pointerEvents。
      const TONE = {
        ok: 'inherit',
        warn: 'var(--dsw-alias-state-warn-primary, #d97706)',
        danger: 'var(--dsw-alias-state-error-primary, #d33)',
        muted: 'var(--dsw-alias-label-secondary, #888)',
      }
      // 进度条要的是实色：ok 档的文字色是 inherit，涂到条上看不出档位。
      const BAR_TONE = {
        ok: 'var(--dsw-alias-brand-primary, #4b7bec)',
        warn: 'var(--dsw-alias-state-warn-primary, #d97706)',
        danger: 'var(--dsw-alias-state-error-primary, #d33)',
      }
      /** 余量档位：与百分比数字同一套阈值（≤10 红、≤25 黄）。 */
      const barTone = percent => BAR_TONE[percent <= 10 ? 'danger' : percent <= 25 ? 'warn' : 'ok']
      const style = {
        panel: {
          position: 'fixed',
          left: leftOf(pos, typeof window.innerWidth === 'number' ? window.innerWidth : 1280, size.width),
          top: pos.top,
          width: size.width,
          // 折叠态与"没拉过"都走自适应；显式高度只在用户拉过之后才生效。
          height: collapsed || size.height === null ? 'auto' : size.height,
          // 纵向 flex：高度固定时让列表区吃掉剩余空间、自己滚动。
          display: 'flex',
          flexDirection: 'column',
          zIndex: 2147483000,
          pointerEvents: 'auto',
          borderRadius: 16,
          border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.16))',
          background: 'var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1, #fff))',
          // 双层阴影：贴边一层勾出轮廓，远距一层把卡片托起来。单层要么太糊、
          // 要么像硬描边，两层叠起来才是「浮着」的观感。
          boxShadow: '0 1px 2px rgba(0,0,0,.06), 0 12px 34px -8px rgba(0,0,0,.22)',
          color: 'var(--dsw-alias-label-primary, inherit)',
          fontSize: 12,
          lineHeight: 1.45,
          overflow: 'hidden',
          userSelect: 'none',
          fontFamily: 'inherit',
        },
        head: {
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          // 右上角缩放热区宽 14px，标题栏右侧让出空间给它。
          padding: '9px 16px 8px 10px',
          cursor: 'grab',
          flexShrink: 0,
          borderBottom: collapsed ? 'none' : '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.16))',
          touchAction: 'none',
        },
        title: { fontWeight: 600, fontSize: 12.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
        sub: { color: 'var(--dsw-alias-label-secondary, #888)', fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
        iconBtn: {
          // 扩大透明按钮本身的命中范围，图标大小保持不变；不允许 flex 压缩。
          width: 30, height: 30, flex: '0 0 30px', padding: 0,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          border: 'none', background: 'transparent', cursor: 'pointer',
          color: 'var(--dsw-alias-label-secondary, #888)', fontSize: 13, lineHeight: 1, borderRadius: 6,
        },
        // 高度自适应时列表最多 320 高；用户拉过右下角之后改成吃满剩余空间。
        //
        // 拖过分隔条之后去掉 320 上限：列表高度由用户指定，再压一个 maxHeight
        // 就变成「列表没变高、只是里面滚了」，拖动看起来没反应。
        //
        // 但**不能**改成 overflowY: visible——卡片拉过右下角时 panel 是固定高度
        // 且 overflow: hidden，visible 会让下半区溢出到卡片外被裁掉，表现就是
        // WorkBuddy 分区整个消失。始终保留自身滚动，两种情况都能看到全部内容。
        // 三种情形：
        //   1. 默认（没拖过分隔条）：整体滚动，最高 320；
        //   2. 卡片被拉过右下角：body 吃满剩余空间并滚动；
        //   3. 拖过分隔条：body 变成纵向 flex 容器，列表固定高度、下半区 flex:1
        //      吃掉剩余——只有这样才能"拖矮上面、下面变大"，横线才会真的跟着走。
        //      此时 body 自己不滚动，由两块各自滚。
        // 三种情形：
        //   1. 默认（没拖过分隔条）：整体滚动，最高 320；
        //   2. 卡片被拉过右下角：body 吃满剩余空间并滚动；
        //   3. 拖过分隔条：body 变成纵向 flex 容器，上下两块真正分配高度——
        //      列表定高、下半区吃剩余。这样横线拖到哪就跟到哪。
        // 设置面板展开时也回到普通布局：那时分隔条不显示，列表若仍按
        // 拖出来的固定高度占位，勾选表就会被挤到下半部分去。
        body: mainSplit !== null && !collapsed && !configOpen
          ? { flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column', padding: '4px 0 6px' }
          : size.height === null || collapsed
            ? { maxHeight: 320, overflowY: 'auto', padding: '4px 0 6px' }
            : { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '4px 0 6px' },
        // 四列：色条 / 名称 / 本分钟消耗 / 余额（余额下方叠当日累计）。
        // 消耗与余额分成两列，数字不再挤在同一格里——量级差很大时
        // （1352 余额 vs −1.0 消耗）挤在一列会读成一串。
        row: {
          display: 'grid',
          // 色条 / 名称 / 今日积分 / 余额（余额下方是今日 token）。
          // 与 WorkBuddy 账号行的网格一致，两块的「今日」「余额」列上下对齐。
          gridTemplateColumns: '3px 1fr 52px 64px',
          alignItems: 'center',
          gap: 8,
          padding: '5px 10px',
        },
        stripe: { width: 3, height: 22, borderRadius: 2 },
        nameCell: { minWidth: 0, display: 'flex', flexDirection: 'column' },
        name: { fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
        meta: { fontSize: 10.5, color: 'var(--dsw-alias-label-secondary, #888)', whiteSpace: 'nowrap' },
        spendCell: {
          textAlign: 'right', fontSize: 10.5,
          fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
        },
        numbers: { textAlign: 'right', display: 'flex', flexDirection: 'column', alignItems: 'flex-end' },
        amount: { fontSize: 12.5, fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
        today: { fontSize: 10.5, color: 'var(--dsw-alias-label-secondary, #888)', fontVariantNumeric: 'tabular-nums' },
        footer: {
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
          padding: '6px 10px 8px', borderTop: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.16))',
          color: 'var(--dsw-alias-label-secondary, #888)', fontSize: 10.5, flexShrink: 0,
        },
        pill: {
          border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.22))',
          background: 'transparent', color: 'inherit', borderRadius: 999, cursor: 'pointer',
          padding: '2px 8px', fontSize: 10.5,
        },
        empty: { padding: '10px 12px 12px', color: 'var(--dsw-alias-label-secondary, #888)', fontSize: 11 },
        configPane: {
          borderTop: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.16))',
          padding: '6px 0 8px', flexShrink: 0,
        },
        configHint: {
          padding: '2px 10px 6px', color: 'var(--dsw-alias-label-secondary, #888)',
          fontSize: 10.5, lineHeight: 1.4,
        },
        // 勾选行做成整行可点：10 项的小面板里，去命中 13px 的方框太费劲。
        option: {
          display: 'flex', alignItems: 'center', gap: 7, padding: '4px 10px',
          cursor: 'pointer', fontSize: 11.5,
        },
        optionButton: {
          display: 'flex', alignItems: 'center', gap: 8, width: '100%',
          padding: '4px 10px', border: 'none', background: 'transparent',
          color: 'inherit', font: 'inherit', textAlign: 'left', cursor: 'pointer',
        },
        fakeBox: {
          width: 13, height: 13, flex: '0 0 auto', borderRadius: 3,
          display: 'grid', placeItems: 'center', fontSize: 10, lineHeight: 1,
          border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.45))',
          background: 'transparent', color: 'var(--dsw-alias-brand-primary, #4b7bec)',
        },
        checkbox: { width: 13, height: 13, margin: 0, cursor: 'pointer', accentColor: 'var(--dsw-alias-brand-primary, #4b7bec)' },
        optionName: { flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
        optionAmount: {
          fontSize: 10.5, color: 'var(--dsw-alias-label-secondary, #888)',
          fontVariantNumeric: 'tabular-nums',
        },
        configActions: {
          display: 'flex', gap: 6, padding: '6px 10px 0',
        },
        // 八个缩放热区：平时完全透明（卡片看起来没有任何装饰），鼠标贴到边上
        // 才由处理器刷上提示色。角排在边之后、层级更高，重叠处归角。
        // ── 统计界面 ──
        statsWrap: { padding: '2px 0 6px' },
        statsNav: {
          display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px 6px',
        },
        statsArrow: {
          width: 22, height: 22, flex: '0 0 22px', padding: 0, borderRadius: 6,
          border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.22))',
          background: 'transparent', color: 'inherit', cursor: 'pointer',
          fontSize: 13, lineHeight: 1, fontFamily: 'inherit',
        },
        statsDate: {
          flex: 1, textAlign: 'center', fontSize: 11.5, fontVariantNumeric: 'tabular-nums',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
        },
        statsTodayTag: {
          fontSize: 9.5, padding: '0 4px', borderRadius: 999,
          border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3))',
          color: 'var(--dsw-alias-label-secondary, #888)',
        },
        // 三个大数字并排：合计给得最大，它是这一页要回答的问题。
        statsTotals: {
          display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 5,
          padding: '2px 10px 5px',
        },
        statsTotalCell: { minWidth: 0 },
        statsTotalLabel: {
          fontSize: 9.5, color: 'var(--dsw-alias-label-secondary, #888)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        },
        statsTotalValue: {
          fontSize: 15, fontWeight: 600, fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        },
        statsRow: {
          display: 'grid', gridTemplateColumns: '3px 1fr 72px',
          alignItems: 'center', gap: 8, padding: '4px 10px 4px 7px',
        },
        // 右列两行：上面是当天总量，下面是调用次数。左列那行小字给三桶构成。
        statsNumbers: {
          minWidth: 0, display: 'flex', flexDirection: 'column',
          alignItems: 'flex-end', gap: 1,
        },
        statsCalls: {
          fontSize: 9.5, color: 'var(--dsw-alias-label-secondary, #888)',
          fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
        },
        // 三桶构成行：跨整宽一行小字，不额外占高度。
        statsBuckets: {
          padding: '0 10px 6px', fontSize: 10,
          color: 'var(--dsw-alias-label-secondary, #888)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        },
        statsNameCell: { minWidth: 0, display: 'flex', flexDirection: 'column' },
        statsName: { fontSize: 11.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
        statsAmount: {
          textAlign: 'right', fontSize: 11.5, fontWeight: 600,
          fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
        },
        statsHint: {
          padding: '6px 10px 8px', color: 'var(--dsw-alias-label-secondary, #888)', fontSize: 10.5,
        },
        // 明细区：没拖过分隔条时随内容长；拖过之后固定高度并自己滚动。
        statsListAuto: { overflowY: 'auto' },
        statsList: { overflowY: 'auto' },
        // 分隔条：平时就是一条边线，鼠标贴上去才透出一点提示色。
        // 上下各留 3px 的可点区域，纯 1px 的线很难抓。
        statsSplitter: {
          height: 7, margin: '1px 0', cursor: 'row-resize', touchAction: 'none',
          borderTop: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.16))',
          background: 'transparent',
        },
        statsWbTotal: {
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
          padding: '4px 10px 4px',
          fontSize: 10.5, color: 'var(--dsw-alias-label-secondary, #888)',
        },
        statsWbAmount: { fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: 'var(--dsw-alias-label-primary, inherit)' },
        // ── WorkBuddy 分区 ──
        // 与渠道行同一套视觉语言，多一列当前余额。
        // 上边框由分隔条负责画：这里再画一条就成了并排的两条线。
        //
        // 拖过分隔条之后由它吃满剩余高度，横线才会跟着手走；
        // minHeight: 0 让它能被压下去（内容自己滚），不把卡片顶大。
        wbWrap: mainSplit === null ? {} : { flex: '1 1 auto', minHeight: 0, overflowY: 'auto' },
        // 次要分区（北辰 / GPT / OFM）：与 WorkBuddy 同一种视觉，但不参与
        // flex 高度分配——它们都抢 flex-grow 会把渠道列表挤出可视区（实测
        // 表现为「退出设置后渠道列表被顶走，只剩分区」）。定高内容自然排。
        sectionWrap: mainSplit === null ? {} : { flex: '0 0 auto', minHeight: 0, overflowY: 'auto' },
        // 大栏标题栏：左侧一根 3px 的高光条标身份，悬停由注入的样式表补背景。
        // 内边距比数据行多 1px，标题栏看起来是「片」，数据行是「条」。
        wbHead: {
          display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px 5px',
          cursor: 'pointer', fontSize: 11, fontWeight: 600,
        },
        // 窄窗下标题要让位给胶囊与折叠三角：允许压缩 + 省略号，不撑着溢出。
        wbTitle: {
          whiteSpace: 'nowrap', letterSpacing: '.01em',
          minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
        },
        // 标题栏左侧的身份色条：比数据行的色条细一点，不与行内色条打架。
        wbAccent: { width: 2.5, height: 12, flex: '0 0 2.5px', borderRadius: 2 },
        // 折叠三角：展开朝下、收起朝右，旋转交给样式表的过渡。
        caret: { fontSize: 9, opacity: .55, display: 'inline-block' },
        // 限额进度条：细轨道 + 圆头填充。折叠态的迷你条只有 3px 高，展开态 4px。
        barTrack: (height, width) => ({
          height, width: width ?? '100%', flex: width === undefined ? '1 1 auto' : '0 0 auto',
          borderRadius: 999, overflow: 'hidden', display: 'flex',
          background: 'color-mix(in srgb, currentColor 14%, transparent)',
        }),
        // 百分比很小时条会缩成看不见的一点：给个最小宽度，让「还剩一点点」
        // 这件事本身可见——归零才是真的没有。
        barFill: percent => ({
          width: `${Math.max(percent > 0 ? 3 : 0, Math.min(100, percent))}%`, borderRadius: 999,
          transition: 'width .3s ease',
        }),
        // 折叠态的紧凑胶囊：轨道 + 半透明填充 + 压在中间的小字。
        // 「5h 42%」这样一个胶囊同时给出窗口、余量和趋势，不额外占宽度。
        // 胶囊：左边一小截进度条，右边百分比。比「整块填充 + 压字」读得快——
        // 填充区做底时，短条的边界会和小字挤在一起。
        chip: {
          display: 'inline-flex', alignItems: 'center', gap: 4,
          height: 15, flex: '0 0 auto', borderRadius: 999,
          padding: '0 6px 0 5px',
          background: 'color-mix(in srgb, currentColor 9%, transparent)',
          fontSize: 9.5, fontVariantNumeric: 'tabular-nums', letterSpacing: '.01em',
        },
        chipBar: { width: 14, flex: '0 0 14px' },
        chipFill: percent => ({
          width: `${Math.max(0, Math.min(100, percent))}%`, borderRadius: 999,
          background: 'currentColor', opacity: .55, transition: 'width .3s ease',
        }),
        chipText: { whiteSpace: 'nowrap', fontWeight: 500 },
        wbSum: {
          marginLeft: 'auto', fontSize: 10.5, fontWeight: 400,
          color: 'var(--dsw-alias-label-secondary, #888)', fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        },
        // 色条 / 账号 / 今日积分 / 余额。网格与渠道行完全一致，两块的
        // 「今日」「余额」列在同一竖线上；左侧色条位置留给对齐用的空条。
        // 累计消耗已移到统计界面，主界面只留当天。
        wbRow: {
          display: 'grid', gridTemplateColumns: '3px 1fr 52px 64px',
          alignItems: 'center', gap: 8, padding: '4px 10px',
        },
        wbNameCell: { minWidth: 0, display: 'flex', flexDirection: 'column' },
        wbName: { fontSize: 11.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
        wbCell: {
          textAlign: 'right', fontSize: 10.5, fontVariantNumeric: 'tabular-nums',
          color: 'var(--dsw-alias-label-secondary, #888)', whiteSpace: 'nowrap',
        },
        wbAmount: { textAlign: 'right', fontSize: 11.5, fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
        wbEmpty: { padding: '2px 10px 8px', color: 'var(--dsw-alias-label-secondary, #888)', fontSize: 10.5 },
        handle: dir => ({
          position: 'absolute',
          zIndex: dir.length === 2 ? 2 : 1,
          cursor: CURSOR_BY_DIR[dir],
          touchAction: 'none',
          background: 'transparent',
          ...HANDLE_BOX[dir],
        }),
      }

      // 用量派生量：统计页与 WorkBuddy 分区都要用，统一在两者之前算好。
      //
      // 今日 token 必须按「今天的日期」取，不能取账本最后一条：跨天之后今天的
      // 第一次调用可能还没发生（cost-meter 尚未写入），最后一条就是昨天的，
      // 取它会让主界面一直显示昨天的量、跨天不清零。
      const todayUsage = usageOfDate(usage.days, localDate())
      // 统计页默认落到最近一天；今天没有记录时它就是上一条，这是对的——
      // 统计页是翻历史的地方，主界面才是「今天」。
      const latestUsage = usage.days.length === 0 ? null : usage.days[usage.days.length - 1]
      // 主界面的「今日 token」：今天没有记录就是 null（显示占位），不拿昨天的顶。
      const wbTokensToday = todayUsage === null ? null : totalTokens(todayUsage.workbuddy)
      // WorkBuddy 所有账号的累计积分合计：主界面不再显示，统计界面给一行。
      const wbAccumulatedTotal = sumSpend(wbRows.map(row => wbLedger.cumulative[row.key]))

      // ── 设置面板 ────────────────────────────────────────────────────────
      // 与统计页同一层级：整块独占 body。勾选表本身就是「哪些渠道要显示」的
      // 清单，上面再压一份渠道列表，等于同一批渠道在一屏里出现两次。
      // 设置面板只保留大栏开关：渠道列表已移除，逐渠道勾选失去意义——
      // 单个渠道的余额与用量都收在「OFM 模型」栏里。
      const configPane = h('div', { style: style.configPane, 'data-ofm-credit-watch-config': 'pane' },
        h('div', { style: style.configHint }, t('sectionsHint')),
        // 整行是一个 button：切换由 onClick 直接完成，勾选框只做展示。
        // 这条路不经过 label→input 的原生转发，也不依赖原生 change 事件，
        // 因此不受受控 checkbox 的任何浏览器差异影响。
        [['beichen', 'sectionBeichen'], ['codex', 'sectionCodex'], ['ofm', 'sectionOfm'], ['workbuddy', 'sectionWb']].map(([key, labelKey]) => {
          const visible = !hiddenSections.has(key)
          return h('button', {
            key, type: 'button',
            style: { ...style.optionButton, opacity: visible ? 1 : 0.55 },
            'data-section': key, 'data-checked': visible ? 'true' : 'false',
            'aria-pressed': visible ? 'true' : 'false',
            // 函数式更新：不读闭包里的 hiddenSections。宿主对 occupant 的渲染
            // 有缓存时，闭包可能停留在旧一轮渲染，用旧集合取反会让每次点击
            // 都晚一拍生效（勾 A 不动、勾 B 时 A 才生效）。
            onClick: () => setHiddenSections(previous => {
              const next = new Set(previous)
              if (next.has(key)) next.delete(key)
              else next.add(key)
              try { window.localStorage?.setItem(HIDDEN_SECTIONS_KEY, JSON.stringify([...next])) } catch { /* 存储不可用 */ }
              return next
            }),
          },
            h('span', { style: { ...style.fakeBox, 'data-on': visible ? 'true' : 'false' } }, visible ? '✓' : ''),
            h('span', { style: { width: 3, height: 14, borderRadius: 2, background: '#4C8DFF', flex: '0 0 auto' } }),
            h('span', { style: style.optionName }, t(labelKey)))
        }),
        h('div', { style: style.configActions },
          h('button', {
            type: 'button', style: { ...style.pill, marginLeft: 'auto' },
            onClick: () => setConfigOpen(false),
          }, t('settingsDone'))))

      // 北辰 API 的读数派生量：分区标题栏与统计页都要用。
      const beichenBalance = beichen !== null && Number.isFinite(beichen.balance) ? beichen.balance : null
      const beichenToday = beichen?.today ?? null
      // 按模型明细是累计口径（接口不分日），与「今日」那两行分开摆。
      const beichenModels = Array.isArray(beichen?.models) ? beichen.models : []

      /**
       * 一行「入 x · 缓 y · 出 z」。
       *
       * 只给总量看不出构成，而缓存命中通常占大头——把三桶拆开才说得清这些
       * token 花在哪一项。统计页与 OFM 分区共用这一份写法。
       */
      const breakdownText = row => fill(t('statsBreakdown'), {
        input: formatTokens(row?.input || 0),
        cache: formatTokens(row?.cacheRead || 0),
        output: formatTokens(row?.output || 0),
      })
      /** 若干用量行按三桶相加：统计页顶部那行「构成」用它。 */
      const sumBuckets = (...rows) => {
        const total = { input: 0, cacheRead: 0, output: 0 }
        for (const row of rows) {
          if (row === null || row === undefined) continue
          total.input += row.input || 0
          total.cacheRead += row.cacheRead || 0
          total.output += row.output || 0
        }
        return total
      }

      // ── 统计界面 ────────────────────────────────────────────────────────
      // 整张卡片切换成统计页：顶部日期条、当天合计、OFM 渠道逐行、WorkBuddy 合计。
      // 主界面的 WorkBuddy 分区只保留当日积分，累计消耗挪到这里。
      const statsSection = (() => {
        if (!usage.available) {
          return h('div', { style: style.statsWrap, 'data-ofm-credit-watch-stats': 'unavailable' },
            h('div', { style: style.statsHint }, t('statsUnavailable')))
        }
        const days = usage.days.slice(-STATS_DAYS)
        if (days.length === 0) {
          return h('div', { style: style.statsWrap, 'data-ofm-credit-watch-stats': 'empty' },
            h('div', { style: style.statsHint }, t('statsNoData')))
        }
        // 选中日期：空串或找不到时跟最新一天走，这样跨天后不会停在空页上。
        const pickedIndex = indexOfDate(days, usageDate) === -1 ? days.length - 1 : indexOfDate(days, usageDate)
        const picked = days[pickedIndex]
        const ofmTotal = totalTokens(picked.ofm)
        const wbTotal = totalTokens(picked.workbuddy)
        // GPT 订阅：与 OFM 渠道不是同一个口径（额度按百分比、用量按 token），
        // 但它同样属于「这天用掉多少」，所以单独一行统计、单独一格合计。
        const codexRow = picked.codex ?? null
        const codexTotal = totalTokens(codexRow)
        // 北辰：接口只回当天，历史由 Host 逐日攒在 beichen.days 里，跟同一个
        // 日期条翻。它同样是「这天用掉多少」的一路，进合计与三桶构成。
        const beichenDay = beichen === null || beichen.configured === false ? null
          : usageOfDate(Array.isArray(beichen.days) ? beichen.days : [], picked.date)
        const beichenBucket = beichenDay === null ? null : {
          input: beichenDay.inputTokens || 0,
          cacheRead: beichenDay.cacheReadTokens || 0,
          output: beichenDay.outputTokens || 0,
        }
        const beichenTotal = beichenBucket === null ? null
          : beichenBucket.input + beichenBucket.cacheRead + beichenBucket.output
        // 当天三桶构成：输入 / 缓存命中 / 输出。合计那个数字由它们组成。
        const buckets = sumBuckets(picked.ofm, picked.workbuddy, codexRow, beichenBucket)
        // 渠道行只列当天有调用的，没调用的渠道不占地方。
        const channels = CHANNELS
          .map(channel => ({ channel, row: picked.byChannel?.[channel.id] }))
          .filter(item => item.row !== undefined && (item.row.calls > 0 || totalTokens(item.row) !== null))

        const step = delta => {
          const next = pickedIndex + delta
          if (next < 0 || next >= days.length) return
          setUsageDate(days[next].date)
        }

        return h('div', { style: style.statsWrap, 'data-ofm-credit-watch-stats': 'section' },
          // 日期条：左右箭头 + 当天日期 + 今日标记。
          h('div', { style: style.statsNav },
            h('button', {
              type: 'button', style: style.statsArrow,
              title: t('statsPrev'), disabled: pickedIndex <= 0,
              onClick: () => step(-1),
              'data-act': 'stats-prev',
            }, '‹'),
            h('span', { style: style.statsDate },
              picked.date,
              // 「今日」标记按真实今天判断：账本里最新一天未必是今天。
              picked.date === localDate() ? h('span', { style: style.statsTodayTag }, t('statsToday')) : null),
            h('button', {
              type: 'button', style: style.statsArrow,
              title: t('statsNext'), disabled: pickedIndex >= days.length - 1,
              onClick: () => step(1),
              'data-act': 'stats-next',
            }, '›')),

          // 五个大数字：合计 / OFM / WorkBuddy / GPT 订阅 / 北辰。
          h('div', { style: style.statsTotals },
            h('div', { style: style.statsTotalCell },
              h('div', { style: style.statsTotalLabel }, t('statsTotal')),
              h('div', { style: style.statsTotalValue },
                formatTokens((ofmTotal || 0) + (wbTotal || 0) + (codexTotal || 0) + (beichenTotal || 0)))),
            h('div', { style: style.statsTotalCell },
              h('div', { style: style.statsTotalLabel }, t('statsOfm')),
              h('div', { style: style.statsTotalValue }, formatTokens(ofmTotal))),
            h('div', { style: style.statsTotalCell },
              h('div', { style: style.statsTotalLabel }, t('statsWb')),
              h('div', { style: style.statsTotalValue, 'data-wb-token-total': 'true' }, formatTokens(wbTotal))),
            h('div', { style: style.statsTotalCell },
              h('div', { style: style.statsTotalLabel }, t('statsCodex')),
              h('div', { style: { ...style.statsTotalValue }, 'data-codex-token-total': 'true' },
                codexTotal === null ? '0' : formatTokens(codexTotal))),
            h('div', { style: style.statsTotalCell },
              h('div', { style: style.statsTotalLabel }, t('statsBeichen')),
              h('div', { style: style.statsTotalValue, 'data-beichen-token-total': 'true' },
                beichenTotal === null ? '0' : formatTokens(beichenTotal)))),
          // 三桶构成：合计由输入 / 缓存命中 / 输出组成。缓存读通常占大头，
          // 不拆开就说不清这些 token 花在哪一项。
          h('div', { style: style.statsBuckets, 'data-stats-buckets': 'true' },
            fill(t('statsBuckets'), {
              input: formatTokens(buckets.input),
              cache: formatTokens(buckets.cacheRead),
              output: formatTokens(buckets.output),
            })),

          // 渠道明细：当天有调用的渠道逐行列出。高度可调，超出部分自己滚动——
          // 渠道多的日子里，这一区是唯一会变长的地方。
          h('div', {
            style: statsSplit === null ? style.statsListAuto : { ...style.statsList, height: statsSplit },
            'data-stats-list': 'true',
          },
            channels.length === 0 && codexTotal === null
              ? h('div', { style: style.statsHint }, t('statsEmpty'))
              : [
                ...channels.map(item => h('div', {
                  key: item.channel.id, style: style.statsRow, className: 'ofm-row', 'data-stats-channel': item.channel.id,
                },
                  h('span', { style: { ...style.stripe, background: item.channel.accent } }),
                  h('span', { style: style.statsNameCell },
                    h('span', { style: style.statsName }, item.channel.name),
                    // 输入 / 缓存命中 / 输出：总量下面那行小字说明构成。
                    h('span', { style: style.meta }, breakdownText(item.row))),
                  h('span', { style: style.statsNumbers },
                    h('span', { style: style.statsAmount }, formatTokens(totalTokens(item.row))),
                    h('span', { style: style.statsCalls }, fill(t('statsCalls'), { count: item.row.calls || 0 }))),
                )),
                // GPT 订阅：与渠道并列，但走订阅线路自己的身份色，别被当成 OFM 渠道。
                codexTotal === null ? null : h('div', {
                  key: '__codex', style: style.statsRow, className: 'ofm-row', 'data-stats-codex': 'row',
                },
                  h('span', { style: { ...style.stripe, background: 'var(--dsw-alias-brand-primary, #4b7bec)' } }),
                  h('span', { style: style.statsNameCell },
                    h('span', { style: style.statsName }, t('statsCodex')),
                    h('span', { style: style.meta }, breakdownText(codexRow))),
                  h('span', { style: style.statsNumbers },
                    h('span', { style: style.statsAmount }, formatTokens(codexTotal)),
                    h('span', { style: style.statsCalls }, fill(t('statsCalls'), { count: codexRow.calls || 0 })))),
                // 北辰：网关侧的上游，与 OFM 渠道同一套三桶；右侧小字给当天扣费。
                beichenTotal === null ? null : h('div', {
                  key: '__beichen', style: style.statsRow, className: 'ofm-row', 'data-stats-beichen': 'row',
                },
                  h('span', { style: { ...style.stripe, background: '#4C8DFF' } }),
                  h('span', { style: style.statsNameCell },
                    h('span', { style: style.statsName }, t('statsBeichen')),
                    h('span', { style: style.meta }, breakdownText(beichenBucket))),
                  h('span', { style: style.statsNumbers },
                    h('span', { style: style.statsAmount }, formatTokens(beichenTotal)),
                    h('span', { style: style.statsCalls }, `−$${(beichenDay?.actualCost || 0).toFixed(2)}`))),
              ]),

          // 分隔条：上下拖动改变明细区高度，双击复位成随内容自适应。
          // 平时只是一条边线，鼠标贴上去才透出提示色——与卡片边缘同一手感。
          h('div', {
            key: '__split',
            style: style.statsSplitter,
            'data-stats-splitter': 'true',
            title: t('statsSplitHint'),
            ...splitHandlers,
          }),

          // WorkBuddy 累计积分：所有账号合并，放在这里是因为主界面只需要当天。
          wbAccumulatedTotal === null ? null : h('div', { style: style.statsWbTotal },
            h('span', null, t('wbAccumulated')),
            h('span', { style: style.statsWbAmount }, '−' + formatAmount(wbAccumulatedTotal, 'credits'))),
        )
      })()
      // 折叠三角：展开朝下、收起朝右，旋转由注入的样式表补过渡。
      const caretOf = open => h('span', {
        className: 'ofm-caret',
        style: { ...style.caret, transform: open ? 'rotate(0deg)' : 'rotate(-90deg)' },
      }, '▾')

      /**
       * 限额进度条。
       *
       * 轨道用 currentColor 的弱化版，填充用档位实色：同一条在不同余量下
       * 自己变色，不用另配一套背景。percent 为 null 时只画空轨道。
       */
      const barOf = (percent, height, width) => h('span', { style: style.barTrack(height, width) },
        Number.isFinite(percent)
          ? h('span', { style: { ...style.barFill(percent), background: barTone(percent) } })
          : null)

      /**
       * 折叠态的限额胶囊：一条按百分比填充的底色 + 压在上面的「5h 42%」。
       *
       * 余量越少填充越短，档位色只在文字上体现——胶囊整体调成低饱和，免得
       * 标题栏被三块高饱和色占满。percent 为 null 时只画空胶囊。
       */
      const chipOf = (label, percent) => h('span', {
        style: style.chip,
        title: label,
        'data-codex-chip': label,
      },
        h('span', { style: { ...style.barTrack(3, undefined), ...style.chipBar } },
          Number.isFinite(percent)
            ? h('span', { style: { ...style.chipFill(percent), background: barTone(percent), opacity: 1 } })
            : null),
        h('span', { style: style.chipText }, `${label} ${Number.isFinite(percent) ? `${Math.round(percent)}%` : '—'}`))

      // ── WorkBuddy 分区 ──────────────────────────────────────────────────
      // 与渠道列表共用同一个滚动区：卡片拉高时一起滚，不额外占一条滚动条。
      // 头部常驻，折叠时只留汇总数字，展开才逐账号列。
      const wbTodaySum = sumSpend(wbRows.map(row => wbLedger.daily[row.key]))
      const wbSection = (() => {
        if (!wbConnected) {
          return h('div', { style: style.wbWrap, className: 'ofm-section', 'data-ofm-credit-watch-wb': 'unavailable' },
            h('div', { style: style.wbHead, className: 'ofm-head', title: t('wbUnavailable') },
              h('span', { style: { ...style.wbAccent, background: '#615CED', opacity: .4 } }),
              h('span', { style: style.wbTitle }, t('wbTitle')),
              h('span', { style: { ...style.meta, marginLeft: 'auto' } }, t('wbUnavailable'))))
        }
        const toggle = () => {
          resetAutoHeight()
          setWbOpen(open => {
            const next = !open
            try { window.localStorage?.setItem(WB_OPEN_KEY, next ? '1' : '0') } catch { /* 存储不可用 */ }
            return next
          })
        }
        return h('div', { style: { ...style.wbWrap }, className: 'ofm-section', 'data-ofm-credit-watch-wb': 'section' },
          h('div', {
            style: style.wbHead, className: 'ofm-head', onClick: toggle, role: 'button',
            title: wbOpen ? t('wbCollapse') : t('wbExpand'),
            'aria-expanded': wbOpen ? 'true' : 'false',
          },
            h('span', { style: { ...style.wbAccent, background: '#615CED' } }),
            h('span', { style: style.wbTitle }, t('wbTitle')),
            h('span', { style: style.wbSum },
              wbTodaySum === null ? '—' : `${t('wbToday')} −${formatAmount(wbTodaySum, 'credits')}`,
              // 今日 token：所有账号合起来一个数，与 cost-meter 面板口径一致。
              wbTokensToday === null ? '' : ` · ${formatTokens(wbTokensToday)}`),
            caretOf(wbOpen)),
          wbRows.length === 0
            ? h('div', { style: style.wbEmpty }, t('wbNoAccounts'))
            : !wbOpen ? null : wbRows.map(row => {
              const usedToday = wbLedger.daily[row.key]
              return h('div', { key: row.key, style: style.wbRow, className: 'ofm-row', 'data-wb-account': row.key },
                // 与渠道行同宽的空色条：让「今日」「余额」两列和上面严格对齐。
                h('span', { style: { ...style.stripe, height: 1, background: 'transparent' } }),
                h('span', { style: style.wbNameCell },
                  h('span', { style: style.wbName, title: row.name }, row.name),
                  h('span', { style: style.meta },
                    `${row.region === 'cn' ? t('wbRegionCn') : t('wbRegionGlobal')}${
                      row.selected ? ' · ✓' : ''}`)),
                // 记过账就是 −0（今天还没花），没记过才是 ·（没有数据）——
                // 两者都写成 · 会让人分不清"今天没花"和"没统计到"。
                h('span', { style: style.wbCell },
                  Number.isFinite(usedToday)
                    ? `−${formatAmount(usedToday, 'credits')}`
                    : '·'),
                h('span', { style: style.wbAmount },
                  Number.isFinite(row.credits) ? formatAmount(row.credits, 'credits') : t('wbNoCredits')))
            })
        )
      })()

      // ── 北辰 API 分区 ────────────────────────────────────────────────────
      // 与 WorkBuddy 同一种折叠分区：标题栏常驻，展开才看明细。北辰不是
      // channel-pack 的渠道，所以不进上面的渠道列表——否则「几个渠道有余额」
      // 这类汇总会被一个口径完全不同的上游污染。
      const beichenSection = beichenBalance === null || hiddenSections.has('beichen') ? null : (() => {
        const toggle = () => {
          resetAutoHeight()
          setBeichenOpen(open => {
            const next = !open
            try { window.localStorage?.setItem(BEICHEN_OPEN_KEY, next ? '1' : '0') } catch { /* 存储不可用 */ }
            return next
          })
        }
        const today = beichenToday ?? {}
        const spent = `−$${Number(today.actualCost ?? 0).toFixed(2)}`
        return h('div', { style: { ...style.wbWrap, ...style.sectionWrap }, className: 'ofm-section', 'data-ofm-credit-watch-beichen': 'section' },
          h('div', {
            style: style.wbHead, className: 'ofm-head', onClick: toggle, role: 'button',
            title: beichenOpen ? t('wbCollapse') : t('wbExpand'),
            'aria-expanded': beichenOpen ? 'true' : 'false',
          },
            h('span', { style: { ...style.wbAccent, background: '#4C8DFF' } }),
            h('span', { style: style.wbTitle }, t('beichenName')),
            // 余额跟标题一起左对齐：折叠时最想看的就是「还剩多少」，
            // 它不该藏在展开之后。颜色沿用余额告警档位。
            h('span', {
              style: {
                marginLeft: 'auto', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
                fontVariantNumeric: 'tabular-nums', color: TONE[toneOf(beichenBalance, 'USD')],
              },
              'data-beichen-balance': 'title',
            }, formatAmount(beichenBalance, 'USD')),
            h('span', { style: { ...style.wbSum, marginLeft: 0 } }, beichenToday === null
              ? t('beichenNoData')
              : `${t('wbToday')} ${spent} · ${formatTokens(today.totalTokens ?? 0)}`),
            caretOf(beichenOpen)),
          !beichenOpen ? null : h('div', null, [
            // 余额行：与上面渠道行同宽的空色条，让两列对齐到同一条竖线。
            h('div', { key: 'balance', style: style.wbRow, className: 'ofm-row', 'data-beichen-row': 'balance' },
              h('span', { style: { ...style.stripe, height: 1, background: 'transparent' } }),
              h('span', { style: style.wbNameCell },
                h('span', { style: style.wbName }, t('beichenBalance')),
                h('span', { style: style.meta }, typeof beichen?.plan === 'string' ? beichen.plan : '')),
              h('span', { style: style.wbCell }, beichenToday === null ? '·' : fill(t('statsCalls'), { count: today.requests ?? 0 })),
              h('span', { style: { ...style.wbAmount, color: TONE[toneOf(beichenBalance, 'USD')] } },
                formatAmount(beichenBalance, 'USD'))),
            // 用量行：今日 token 与扣费。三桶拆开，钱主要花在缓存读上。
            h('div', { key: 'tokens', style: style.wbRow, className: 'ofm-row', 'data-beichen-row': 'tokens' },
              h('span', { style: { ...style.stripe, height: 1, background: 'transparent' } }),
              h('span', { style: style.wbNameCell },
                h('span', { style: style.wbName }, t('beichenTokens')),
                h('span', { style: style.meta }, breakdownText({
                  input: today.inputTokens,
                  cacheRead: today.cacheReadTokens,
                  output: today.outputTokens,
                }))),
              h('span', { style: style.wbCell }, beichenToday === null ? '·' : spent),
              h('span', { style: style.wbAmount }, formatTokens(today.totalTokens ?? 0))),
            // 按模型明细：接口给的是累计口径、不分日，所以单列一行标题，
            // 免得这些数被当成「今天」的用量。
            ...(beichenModels.length === 0 ? [] : [
              h('div', { key: 'models', style: { ...style.wbEmpty, paddingTop: 5 } }, t('beichenModels')),
              ...beichenModels.map(row => h('div', {
                key: row.model,
                style: { ...style.wbRow, paddingLeft: 18 },
                className: 'ofm-row',
                'data-beichen-model': row.model,
              },
                h('span', { style: { ...style.stripe, height: 1, background: 'transparent' } }),
                h('span', { style: style.wbNameCell },
                  h('span', { style: style.wbName, title: row.model }, row.model),
                  h('span', { style: style.meta }, breakdownText({
                    input: row.inputTokens,
                    cacheRead: row.cacheReadTokens,
                    output: row.outputTokens,
                  }))),
                h('span', { style: style.wbCell }, fill(t('statsCalls'), { count: row.requests })),
                h('span', { style: style.wbAmount }, `−$${(row.actualCost || 0).toFixed(2)}`))),
            ]),
          ]),
        )
      })()


      // ── GPT 订阅分区 ────────────────────────────────────────────────────
      // 数据源是订阅插件落盘的预测快照（Host 侧读文件）：5 小时窗与周窗的
      // 剩余百分比。折叠栏给「5小时 63% · 本周 94%」，展开加重置时间。
      // 快照过期：样本还停在上次采样那一刻。DSH 关了一夜之后，5 小时窗早就
      // 翻过重置点，快照上那个百分比是上一轮的残留，直接显示会明显偏高。
      // 这种时候按缺失处理，界面给占位，等订阅插件写进新样本再显示。
      const codexStale = codex?.stale === true
      const codexFiveHour = !codexStale && Array.isArray(codex?.windows)
        ? codex.windows.find(row => row.kind === 'fiveHour') ?? null : null
      const codexWeekly = !codexStale && Array.isArray(codex?.windows)
        ? codex.windows.find(row => row.kind === 'weekly') ?? null : null
      const resetWhen = row => {
        if (row === null || !Number.isFinite(row.resetsAt)) return ''
        const ms = row.resetsAt - now
        if (ms <= 0) return t('codexResetSoon')
        return fill(t('codexResets'), { when: span(ms, lang) })
      }
      // 今日 token：订阅线路的额度按百分比算，配一个「这点余量被多少 token 吃掉」
      // 才说得清消耗速度。数据由 Host 侧的 llm/stream 采集器统计。
      const codexTokens = codex?.tokens ?? null
      const codexTokenTotal = codexTokens === null ? null
        : (codexTokens.input || 0) + (codexTokens.output || 0) + (codexTokens.cacheRead || 0)
      const pct = row => row === null ? '—' : `${Math.round(row.remainingPercent)}%`
      /**
       * 悬浮提示里的绝对时刻。
       *
       * 只有相对时长（「27 分钟后」）看不出一件事什么时候发生，只有绝对时刻又
       * 要自己心算还剩多久，所以两样都给。近两天用「今天 / 明天 + 时刻」，
       * 更远给日期，省得提示太长。
       */
      const clockOf = ms => {
        const at = new Date(ms)
        return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
      }
      const whenOf = ms => {
        const at = new Date(ms)
        const base = new Date(now)
        const dayOf = date => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
        const days = Math.round((dayOf(at) - dayOf(base)) / 86_400_000)
        const time = clockOf(ms)
        if (days === 0) return fill(t('codexWhenToday'), { time })
        if (days === 1) return fill(t('codexWhenTomorrow'), { time })
        const month = lang === 'en' ? MONTHS_EN[at.getMonth()] ?? '' : String(at.getMonth() + 1)
        return fill(t('codexWhenDate'), { month, day: at.getDate(), time })
      }
      /**
       * GPT 订阅栏的多行悬浮提示：每个窗口一段「剩余 + 重置于何时」，末尾补一行
       * 采样时刻与动作提示。折叠时只在标题栏给百分比，重置时间要展开才看得到；
       * 鼠标停上去就能看到，不用展开占高度。
       */
      const codexTitle = (() => {
        const line = []
        // 中文用全角空格对齐，英文用冒号更自然。
        const sep = lang === 'en' ? ': ' : '　'
        const addRow = (row, label) => {
          if (row === null) return
          line.push(`${label}${sep}${fill(t('codexRemaining'), { value: pct(row) })}`)
          if (!Number.isFinite(row.resetsAt)) { line.push(t('codexTipNoReset')); return }
          const ms = row.resetsAt - now
          if (ms <= 0) { line.push(t('codexTipResetNow')); return }
          const left = span(ms, lang)
          line.push(left === ''
            ? t('codexTipResetNow')
            : fill(t('codexTipReset'), { when: whenOf(row.resetsAt), left }))
        }
        addRow(codexFiveHour, t('codexFiveHour'))
        addRow(codexWeekly, t('codexWeekly'))
        // 今日 token：光有百分比看不出消耗速度，这一行给出被吃掉多少 token。
        if (codexTokenTotal !== null && codexTokenTotal > 0) {
          line.push(fill(t('codexTipTokens'), {
            total: formatTokens(codexTokenTotal),
            input: formatTokens(codexTokens.input),
            output: formatTokens(codexTokens.output),
            cache: formatTokens(codexTokens.cacheRead),
          }))
        }
        // 过期时两个窗口都被按缺失处理，这里补一行说明，别让提示看起来像没装插件。
        if (codexStale) line.push(t('codexTipStale'))
        // 快照里两个窗口都没有时不给空提示，否则标题栏连展开说明也一起没了。
        if (line.length === 0) return codexOpen ? t('codexTipCollapse') : t('codexTipExpand')
        const sampled = codexFiveHour?.sampledAt ?? codexWeekly?.sampledAt
        if (Number.isFinite(sampled)) line.push(fill(t('codexTipSampled'), { when: whenOf(sampled) }))
        line.push(codexOpen ? t('codexTipCollapse') : t('codexTipExpand'))
        return line.join('\n')
      })()
      const codexSection = codex === null || codex.available === false || hiddenSections.has('codex') ? null : (() => {
        const toggle = () => {
          resetAutoHeight()
          setCodexOpen(open => {
            const next = !open
            try { window.localStorage?.setItem(CODEX_OPEN_KEY, next ? '1' : '0') } catch { /* 存储不可用 */ }
            return next
          })
        }
        const summary = codexStale ? t('codexStale')
          : codexFiveHour === null && codexWeekly === null ? t('codexUnavailable')
          : [codexFiveHour, codexWeekly].map((row, index) =>
            row === null ? null : `${index === 0 ? t('codexFiveHour') : t('codexWeekly')} ${pct(row)}`).filter(Boolean).join(' · ')
        return h('div', { style: { ...style.wbWrap, ...style.sectionWrap }, className: 'ofm-section', 'data-ofm-credit-watch-codex': 'section' },
          h('div', {
            style: style.wbHead, className: 'ofm-head', onClick: toggle, role: 'button',
            title: codexTitle,
            'aria-expanded': codexOpen ? 'true' : 'false',
          },
            h('span', { style: { ...style.wbAccent, background: 'var(--dsw-alias-brand-primary, #4b7bec)' } }),
            h('span', { style: style.wbTitle }, t('codexName')),
            // 折叠时也要看得见余量趋势：两个胶囊代替原来的一行文字，
            // 条长就是余量比例。两个窗口都缺时退回占位文字。
            codexFiveHour === null && codexWeekly === null
              ? h('span', { style: { ...style.wbSum, marginLeft: 'auto' } }, summary)
              : h('span', {
                style: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4, flex: '0 0 auto' },
                'data-codex-chips': 'title',
              },
                codexFiveHour === null ? null : chipOf(t('codexChipFiveHour'), codexFiveHour.remainingPercent),
                codexWeekly === null ? null : chipOf(t('codexChipWeekly'), codexWeekly.remainingPercent),
                // 今日 token 跟在胶囊后面：两个百分比说明还剩多少，这个数说明用掉多少。
                codexTokenTotal === null || codexTokenTotal <= 0
                  ? null
                  : h('span', {
                    style: { ...style.wbSum, marginLeft: 2, fontSize: 10 },
                    'data-codex-tokens': 'title',
                  }, `${formatTokens(codexTokenTotal)}`)),
            caretOf(codexOpen)),
          // 今日 token 明细：一行独立于两个窗口，因为它跨越整条订阅线路。
          !codexOpen || codexTokenTotal === null || codexTokenTotal <= 0 ? null : h('div', {
            style: { ...style.wbRow, paddingLeft: 18 },
            className: 'ofm-row',
            'data-codex-row': 'tokens',
          },
            h('span', { style: { ...style.stripe, height: 1, background: 'transparent' } }),
            h('span', { style: style.wbNameCell },
              h('span', { style: style.wbName }, t('codexTokensToday')),
              h('span', { style: style.meta }, fill(t('codexTokensBreakdown'), {
                input: formatTokens(codexTokens.input),
                output: formatTokens(codexTokens.output),
                cache: formatTokens(codexTokens.cacheRead),
              }))),
            h('span', { style: { display: 'flex', alignItems: 'center' } }),
            h('span', { style: style.wbAmount }, formatTokens(codexTokenTotal))),
          !codexOpen ? null : [codexFiveHour, codexWeekly].map((row, index) => row === null ? null : h('div', {
            key: index,
            // 明细行比标题栏多缩进 8px：层级上它是「GPT 订阅」的下级。
            style: { ...style.wbRow, paddingLeft: 18 },
            className: 'ofm-row',
            'data-codex-row': index === 0 ? 'fiveHour' : 'weekly',
          },
            h('span', { style: { ...style.stripe, height: 1, background: 'transparent' } }),
            h('span', { style: style.wbNameCell },
              h('span', { style: style.wbName }, index === 0 ? t('codexFiveHour') : t('codexWeekly')),
              h('span', { style: style.meta }, resetWhen(row))),
            // 进度条占中间那列：百分比数字在右，条在左，扫一眼就知道还剩多少。
            h('span', { style: { display: 'flex', alignItems: 'center' } },
              barOf(row.remainingPercent, 4)),
            h('span', { style: { ...style.wbAmount, color: TONE[row.remainingPercent <= 10 ? 'danger' : row.remainingPercent <= 25 ? 'warn' : 'ok'] } },
              pct(row)))))
      })()

      // ── OFM 模型分区 ────────────────────────────────────────────────────
      // cost-meter 账本里 OFM 各渠道的今日 token。折叠栏给合计，展开逐渠道列。
      const ofmChannelRows = Array.isArray(ofmTokens?.channels)
        ? ofmTokens.channels.filter(row => row.calls > 0 || (row.input + row.output + row.cacheRead) > 0)
          .map(row => {
            // 余额与账号数来自渠道读数（原渠道列表的数据源）；显示名与
            // 色条来自 CHANNELS 静态表。渠道列表删除后，这些信息都在这
            // 一栏里呈现。
            const live = rows.find(item => item.id === row.channel)
            const meta = CHANNELS.find(c => c.id === row.channel)
            const unit = live?.unit ?? 'credits'
            return {
              ...row,
              name: live?.name ?? meta?.name ?? row.channel,
              accent: live?.accent ?? meta?.accent ?? '#4C8DFF',
              spent: Number.isFinite(today[row.channel]) ? today[row.channel] : null,
              balance: Number.isFinite(live?.total) ? live.total : null,
              unit,
              accounts: live?.accounts ?? 0,
              ok: live?.ok !== false,
            }
          }) : []
      const ofmTotalTokens = ofmTokens?.total === null || ofmTokens?.total === undefined ? null
        : (ofmTokens.total.input + ofmTokens.total.output + ofmTokens.total.cacheRead)
      const ofmSection = ofmTokens === null || ofmTokens.available === false || hiddenSections.has('ofm') ? null
        : h('div', { style: { ...style.sectionWrap }, className: 'ofm-section', 'data-ofm-credit-watch-ofm': 'section' },
          h('div', {
            style: style.wbHead, className: 'ofm-head', onClick: () => { resetAutoHeight(); setOfmOpen(open => !open) }, role: 'button',
            title: ofmOpen ? t('wbCollapse') : t('wbExpand'),
            'aria-expanded': ofmOpen ? 'true' : 'false',
          },
            h('span', { style: { ...style.wbAccent, background: '#00BFA6' } }),
            h('span', { style: style.wbTitle }, t('ofmName')),
            h('span', { style: style.wbSum },
              ofmTokens.day === null ? t('ofmTokensEmpty')
                : ofmTotalTokens === null ? '—' : `${formatTokens(ofmTotalTokens)} tok`),
            caretOf(ofmOpen)),
          !ofmOpen ? null : ofmChannelRows.length === 0
            ? h('div', { style: style.wbEmpty }, t('ofmTokensEmpty'))
            : ofmChannelRows.map(row => h('div', {
              key: row.channel, style: style.wbRow, className: 'ofm-row', 'data-ofm-token-row': row.channel,
            },
              h('span', { style: { ...style.stripe, background: row.accent } }),
              h('span', { style: style.wbNameCell },
                h('span', { style: style.wbName }, row.name),
                h('span', { style: style.meta }, breakdownText(row))),
              // 今日积分消耗：从旧渠道行迁来的口径；没消耗显示 ·。
              h('span', {
                style: {
                  ...style.wbCell,
                  color: row.spent !== null && row.spent > 0
                    ? 'var(--dsw-alias-state-warn-primary, #d97706)'
                    : 'var(--dsw-alias-label-secondary, #888)',
                },
              }, row.spent !== null && row.spent > 0 ? `−${formatAmount(row.spent, 'credits')}` : '·'),
              h('span', { style: style.numbers },
                h('span', { style: { ...style.amount, color: TONE[toneOf(row.balance, row.unit)], opacity: row.ok ? 1 : 0.5 } },
                  formatAmount(row.balance, row.unit)),
                h('span', { style: style.today }, formatTokens(row.input + row.output + row.cacheRead))))))

      // ── 隐藏态：只留一个小胶囊，避免占着屏幕又找不回来 ───────────────────
      if (hidden) {
        return h('div', {
          'data-ofm-credit-watch': 'pill',
          style: {
            ...style.panel, width: 'auto', height: 'auto',
            left: leftOf(pos, typeof window.innerWidth === 'number' ? window.innerWidth : 1280, 96),
            borderRadius: 999,
          },
        }, h('button', {
          type: 'button',
          onClick: () => setHidden(false),
          style: {
            border: 'none', background: 'transparent', cursor: 'pointer', color: 'inherit',
            padding: '6px 12px', fontSize: 11.5, display: 'flex', alignItems: 'center', gap: 6,
          },
          title: t('expand'),
        },
        h('span', { style: { fontWeight: 600 } }, t('show')),
        h('span', { style: { fontVariantNumeric: 'tabular-nums' } }, kilo(total ?? NaN))))
      }

      return h('div', { 'data-ofm-credit-watch': 'panel', style: style.panel, role: 'region', 'aria-label': t('title') },
        // 标题栏：整条都是拖动区，右侧是可点击的按钮（阻止冒泡以免误拖）。
        h('div', {
          style: style.head,
          onPointerDown,
          onPointerMove,
          onPointerUp,
          title: t('dragHint'),
        },
          h('span', { style: { width: 3, height: 16, borderRadius: 2, background: 'var(--dsw-alias-brand-primary, #4b7bec)' } }),
          h('span', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' } },
            h('span', { style: style.title }, t('title')),
            h('span', { style: style.sub }, headerWhen)),
          // 统计视图开关：整张卡片切换到 token 统计页。
          h('button', {
            type: 'button',
            style: { ...style.iconBtn, color: view === 'stats' ? 'var(--dsw-alias-brand-primary, #4b7bec)' : style.iconBtn.color },
            title: view === 'stats' ? t('statsBack') : t('stats'),
            'aria-pressed': view === 'stats' ? 'true' : 'false',
            'data-act': 'stats',
            onPointerDown: event => event.stopPropagation(),
            onClick: event => {
              event.stopPropagation()
              setView(current => {
                const next = current === 'stats' ? 'list' : 'stats'
                try { window.localStorage?.setItem(VIEW_KEY, next) } catch { /* 存储不可用 */ }
                // 进统计页时收起配置面板：两者都是整块内容，叠在一起没意义。
                if (next === 'stats') setConfigOpen(false)
                return next
              })
            },
          }, '▤'),
          h('button', {
            type: 'button', style: style.iconBtn,
            title: busy ? t('refreshing') : t('refresh'),
            onPointerDown: event => event.stopPropagation(),
            // 一次刷新把两套上游都走一遍：渠道是每分钟自转的，WorkBuddy 是
            // 五分钟一轮，手动刷新不该只叫醒其中一个。
            onClick: event => {
              event.stopPropagation()
              void poll()
              void pollWorkBuddy()
              void pollBeichen()
            },
          }, busy ? '◌' : '⟳'),
          // 勾选配置：就地展开面板，不弹窗（悬浮层里再套弹窗会被遮住，
          // 也会跟宿主自己的弹层层级打架）。
          h('button', {
            type: 'button',
            style: { ...style.iconBtn, color: configOpen ? 'var(--dsw-alias-brand-primary, #4b7bec)' : style.iconBtn.color },
            title: t('settings'), 'aria-expanded': configOpen ? 'true' : 'false',
            'aria-pressed': configOpen ? 'true' : 'false',
            'data-act': 'config',
            onPointerDown: event => event.stopPropagation(),
            onClick: event => {
              event.stopPropagation()
              // 打开配置时若窗口是收起的，先展开，否则勾选面板会看不见。
              setConfigOpen(open => { const next = !open; if (next) setCollapsed(false); return next })
            },
          }, '⚙'),
          h('button', {
            type: 'button', style: style.iconBtn, title: collapsed ? t('expand') : t('collapse'),
            onPointerDown: event => event.stopPropagation(),
            onClick: event => {
              event.stopPropagation()
              setCollapsed(value => {
                const next = !value
                try { window.localStorage?.setItem(COLLAPSE_KEY, next ? '1' : '0') } catch { /* 存储不可用 */ }
                return next
              })
            },
          }, collapsed ? '▸' : '▾'),
          h('button', {
            type: 'button', style: style.iconBtn, title: t('close'),
            onPointerDown: event => event.stopPropagation(),
            onClick: event => { event.stopPropagation(); setHidden(true) },
          }, '✕')),
        collapsed ? null : h('div', { style: style.body, 'data-ofm-credit-watch-body': 'true' },
          // 统计视图：整块替换掉渠道列表与 WorkBuddy 分区。
          view === 'stats' ? statsSection
          // 设置视图：同样整块独占。勾选表本身就是「哪些渠道要显示」的清单，
          // 上面再压一份渠道列表，等于同一批渠道在一屏里出现两次。
          : configOpen ? configPane
          // 列表视图：四个大栏依次排开。渠道列表、主分隔条与页脚已移除——
          // 余额、今日消耗、token 三者都收进「OFM 模型」栏，主界面不再有
          // 第二份渠道数据，也就没有需要拖高矮的列表了。
          : [beichenSection, codexSection, ofmSection,
            hiddenSections.has('workbuddy') ? null : wbSection]),
        // 八向缩放热区。绝对定位，不占列表的流；平时透明，鼠标贴到边上才透出
        // 提示色——像 Windows 窗口的边框。角和边的提示语不同：角能同时改宽高。
        ...HANDLES.map(dir => h('div', {
          key: dir,
          'data-ofm-credit-watch-handle': dir,
          style: style.handle(dir),
          title: dir.length === 2 ? t('resizeCorner') : t('resizeEdge'),
          onPointerEnter: event => { event.currentTarget.style.background = HINT_BG },
          onPointerLeave: event => { event.currentTarget.style.background = 'transparent' },
          ...resizeHandlers(dir),
        })))
    }

    // ─── 插件体 ──────────────────────────────────────────────────────────────
    const inject = ['slots']

    /**
     * 把悬浮窗注册到 `shell.overlay`。
     *
     * 这个 slot 是「整框悬浮层」——位于所有列之上、滚动容器之外，且默认点击
     * 穿透（occupant 自己恢复 pointerEvents），正是 dsh-pet 之外放常驻
     * 悬浮件的位置。slot 的注册对象需要唯一的 `id`；用插件名当 id 保证
     * 重载后仍是同一个格子而不是叠加一份。
     */
    function apply(ctx) {
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'ofm-credit-watch',
        order: 80,
      }, () => h(CreditWatch, { ctx })))
    }

    exports.apply = apply
    exports.inject = inject
    exports.__test = {
      CreditWatch, readChannel, channelRpc, kilo, signedKilo, span, fill,
      normalizeHidden, toggleHidden, CHANNELS, DICT, HIDDEN_KEY, WB_OPEN_KEY,
      mapLimit, shouldPollChannel, failureRow, sumSpend, wbLedgerKey,
      totalTokens, formatTokens, fetchUsage, indexOfDate, usageOfDate, USAGE_URL, VIEW_KEY, STATS_DAYS,
      loadStatsSplit, saveStatsSplit, clampStatsSplit, STATS_SPLIT_KEY, STATS_SPLIT_MIN,
      loadMainSplit, saveMainSplit, MAIN_SPLIT_KEY,
      fetchWorkBuddyRegion, normalizeWorkBuddy, MAX_CONCURRENCY, HIDDEN_POLL_MS, STALE_ROW_MS, WB_POLL_MS,
      formatAmount, unitOf, toneOf, expireOf, tooltipOf, normalizeTotals,
      accumulateLocal, loadLocalDaily, loadPos, leftOf, localDate, round2,
      loadSize, saveSize, clampSize, relRightFor, sizeLimits, resizeFromDrag,
      SIZE_KEY, MIN_WIDTH, MIN_HEIGHT, HANDLES, CURSOR_BY_DIR,
    }
    return module.exports
  },
})
