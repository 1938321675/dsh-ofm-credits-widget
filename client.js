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
    /** 折叠状态持久化键。 */
    const COLLAPSE_KEY = 'ofm-credit-watch.collapsed'
    /** 被用户隐藏的渠道 id 列表持久化键。存「隐藏」而不是「显示」：
     *  新版本 OFM 若新增渠道，它会默认显示出来，而不是悄悄消失。 */
    const HIDDEN_KEY = 'ofm-credit-watch.hiddenChannels'
    /** Host 不可用时，当日累计的本地兜底账本键。 */
    const LOCAL_DAILY_KEY = 'ofm-credit-watch.daily'
    /** Host 账本路由。 */
    const LEDGER_URL = '/api/ofm-credit-watch/ledger'
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

    // ─── 文案 ────────────────────────────────────────────────────────────────
    const DICT = {
      zh: {
        title: 'OFM 积分监控',
        subtitle: 'EAC router 剩余积分',
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
      },
      en: {
        title: 'OFM Credit Watch',
        subtitle: 'EAC router credits left',
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

    /** 把毫秒差写成「刚刚 / 42 秒 / 3 分钟 / 2 小时」这类短语。 */
    function span(ms) {
      if (!Number.isFinite(ms) || ms < 0) return ''
      const sec = Math.round(ms / 1000)
      if (sec < 5) return ''
      if (sec < 60) return `${sec} 秒`
      const min = Math.round(sec / 60)
      if (min < 60) return `${min} 分钟`
      const hour = Math.round(min / 60)
      if (hour < 24) return `${hour} 小时`
      return `${Math.round(hour / 24)} 天`
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

      // 上一轮读数与串行保护：轮询和手动刷新可能重叠，只允许最新一轮落库。
      const previous = useRef(null)
      const generation = useRef(0)
      const alive = useRef(true)
      // 账本走 Host 还是本地兜底，决定 delta 记到哪儿。
      const ledgerMode = useRef('host')

      const persistPos = useCallback(next => {
        setPos(next)
        try { window.localStorage?.setItem(POS_KEY, JSON.stringify(next)) } catch { /* 存储不可用 */ }
        // 位置变了立刻移动：等下一次 render 再算会有一次跳动。
        const root = document.querySelector('[data-ofm-credit-watch]')
        if (root) root.style.left = `${leftOf(next, window.innerWidth, root.offsetWidth)}px`
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
        setPos(prev => {
          const merged = {
            ...prev,
            relRight: relRightFor(left, next.width, vw),
            // 上面那条边也要写回：拖上边时高度变大、上边界同时上移，只更新
            // relRight 会让上边界留在原地，看起来就成了"拉上边动下边"。
            top: Number.isFinite(anchor?.top) ? Math.max(0, Math.round(anchor.top)) : prev.top,
          }
          try { window.localStorage?.setItem(POS_KEY, JSON.stringify(merged)) } catch { /* 存储不可用 */ }
          return merged
        })
        const root = document.querySelector('[data-ofm-credit-watch]')
        if (root) {
          root.style.width = `${next.width}px`
          root.style.height = next.height === null ? '' : `${next.height}px`
          root.style.left = `${left}px`
        }
      }, [])

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
        // 一个渠道失败不该拖垮整轮：各自 settled，失败的行保留上一轮的读数，
        // 这样悬浮窗不会因为某一家上游抖动就整片变空。
        const results = await Promise.all(CHANNELS.map(async channel => {
          try {
            const reading = await readChannel(ctx, channel)
            return { channel, ok: true, reading }
          } catch (caught) {
            return { channel, ok: false, message: String(caught?.message ?? caught) }
          }
        }))
        if (!alive.current || seq !== generation.current) return

        const stamp = Date.now()
        const prev = previous.current
        const freshDelta = {}
        const spentAt = {}
        const nextRows = results.map(({ channel, ok, reading, message }) => {
          const row = { id: channel.id, ...channel, ok, at: stamp }
          if (!ok) {
            // 失败：沿用上一轮已知的剩余，但标记失败，避免数字凭空消失。
            // 失败原因要带到行上，tooltip 才有东西可说。
            const before = prev?.find(item => item.id === channel.id)
            return {
              ...row,
              total: before?.total ?? null,
              accounts: before?.accounts ?? 0,
              failed: 1,
              stale: true,
              error: message,
              unit: before?.unit ?? UNIT_BY_PROVIDER[channel.id] ?? 'credits',
              packages: before?.packages ?? [],
            }
          }
          row.total = reading.total
          row.accounts = reading.accounts
          row.failed = reading.failed
          row.unit = reading.unit
          row.packages = reading.packages
          const before = prev?.find(item => item.id === channel.id)
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
        const readings = results.map(({ channel, ok, reading }) => ({
          provider: channel.id,
          total: ok ? reading.total : null,
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
        if (results.every(item => !item.ok)) setError(t('retryOnNext'))
      }, [ctx, t])

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

      // ── 排序与汇总 ───────────────────────────────────────────────────────
      // 只有被勾选显示的渠道才参与列表渲染与排序；数据仍然全部采集，
      // 因此勾回来立刻有数字。
      const visibleRows = useMemo(
        () => rows.filter(row => !hiddenIds.has(row.id)),
        [rows, hiddenIds])

      // 活跃优先：最近一次出现消耗距现在越近越靠前（IDLE_WINDOW_MS 内算活跃）；
      // 都不活跃时按剩余积分从多到少，让"还有多少可用"一眼可见。
      const ordered = useMemo(() => {
        const rank = row => {
          const at = lastSpent[row.id]
          if (!Number.isFinite(at)) return Number.POSITIVE_INFINITY
          const age = now - at
          return age <= IDLE_WINDOW_MS ? age : Number.POSITIVE_INFINITY
        }
        return [...visibleRows].sort((left, right) => {
          const ra = rank(left)
          const rb = rank(right)
          if (ra !== rb) return ra - rb
          const ta = Number.isFinite(left.total) ? left.total : -1
          const tb = Number.isFinite(right.total) ? right.total : -1
          if (ta !== tb) return tb - ta
          return left.name.localeCompare(right.name)
        })
      }, [visibleRows, lastSpent, now])

      // 合计与"有余额的渠道数"也跟着可见性走：隐藏了 TRAE 之后，
      // 页脚的合计若还算着它，数字就和列表对不上了。
      const total = useMemo(() => {
        let sum = 0
        let seen = false
        for (const row of visibleRows) {
          if (Number.isFinite(row.total)) { sum += row.total; seen = true }
        }
        return seen ? sum : null
      }, [visibleRows])

      const channelCount = visibleRows.filter(row => Number.isFinite(row.total)).length
      const failedCount = visibleRows.filter(row => row.ok === false).length
      const hiddenCount = rows.length - visibleRows.length

      const headerWhen = updatedAt === 0 ? t('never')
        : (() => {
          const age = now - updatedAt
          const phrase = span(age)
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
          borderRadius: 14,
          border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.22))',
          background: 'var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1, #fff))',
          boxShadow: '0 10px 32px rgba(0,0,0,.18)',
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
          gap: 8,
          padding: '9px 10px 8px',
          cursor: 'grab',
          flexShrink: 0,
          borderBottom: collapsed ? 'none' : '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.16))',
          touchAction: 'none',
        },
        title: { fontWeight: 600, fontSize: 12.5, whiteSpace: 'nowrap' },
        sub: { color: 'var(--dsw-alias-label-secondary, #888)', fontSize: 11, whiteSpace: 'nowrap' },
        iconBtn: {
          border: 'none', background: 'transparent', cursor: 'pointer', padding: '2px 4px',
          color: 'var(--dsw-alias-label-secondary, #888)', fontSize: 13, lineHeight: 1, borderRadius: 6,
        },
        // 高度自适应时列表最多 320 高；用户拉过右下角之后改成吃满剩余空间。
        // 两条路都靠自身滚动，卡片不会被内容撑开。
        body: size.height === null || collapsed
          ? { maxHeight: 320, overflowY: 'auto', padding: '4px 0 6px' }
          : { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '4px 0 6px' },
        // 四列：色条 / 名称 / 本分钟消耗 / 余额（余额下方叠当日累计）。
        // 消耗与余额分成两列，数字不再挤在同一格里——量级差很大时
        // （1352 余额 vs −1.0 消耗）挤在一列会读成一串。
        row: {
          display: 'grid',
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
        handle: dir => ({
          position: 'absolute',
          zIndex: dir.length === 2 ? 2 : 1,
          cursor: CURSOR_BY_DIR[dir],
          touchAction: 'none',
          background: 'transparent',
          ...HANDLE_BOX[dir],
        }),
      }

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
          h('button', {
            type: 'button', style: style.iconBtn, title: loading ? t('refreshing') : t('refresh'),
            onPointerDown: event => event.stopPropagation(),
            onClick: event => { event.stopPropagation(); void poll() },
          }, loading ? '◌' : '⟳'),
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
        collapsed ? null : h('div', { style: style.body },
          rows.length === 0
            ? h('div', { style: style.empty }, error !== '' ? error : t('never'))
            : ordered.length === 0
              // 全部被隐藏：给出回程路径，而不是留一片空白让人以为坏了。
              ? h('div', { style: style.empty }, t('allHidden'))
              : (ordered.map(row => {
              const spend = delta[row.id]
              const spentAt = lastSpent[row.id]
              const active = Number.isFinite(spentAt) && (now - spentAt) <= IDLE_WINDOW_MS
              const todayUsed = today[row.id]
              const unit = row.unit ?? 'credits'
              // 副标题优先报问题，其次报账号数与最近消耗时间——一行放不下三件事。
              const status = row.ok === false
                ? t('failed')
                : !Number.isFinite(row.total)
                  ? (row.accounts === 0 ? t('noAccounts') : t('noData'))
                  : active
                    ? (() => {
                      const phrase = span(now - spentAt)
                      return phrase === '' ? t('spentJustNow') : fill(t('spentAgo'), { when: phrase })
                    })()
                    : row.accounts > 1 ? fill(t('accounts'), { count: row.accounts }) : ''
              return h('div', {
                key: row.id, style: style.row,
                'data-channel': row.id, 'data-active': active ? 'true' : 'false',
                'data-tone': toneOf(row.total, unit),
              },
                h('span', { style: { ...style.stripe, background: row.ok === false ? 'var(--dsw-alias-state-idle-primary, #bbb)' : row.accent } }),
                h('span', { style: style.nameCell },
                  h('span', { style: { ...style.name, opacity: row.ok === false ? 0.6 : 1 } }, row.name),
                  status === '' ? null : h('span', { style: style.meta }, status)),
                h('span', {
                  style: {
                    ...style.spendCell,
                    color: Number.isFinite(spend) && spend > 0
                      ? 'var(--dsw-alias-state-warn-primary, #d97706)'
                      : 'var(--dsw-alias-label-secondary, #888)',
                  },
                }, Number.isFinite(spend) && spend > 0 ? `−${formatAmount(spend, unit)}` : '·'),
                h('span', { style: style.numbers, title: tooltipOf(row) },
                  h('span', {
                    style: {
                      ...style.amount,
                      color: TONE[toneOf(row.total, unit)],
                      opacity: Number.isFinite(row.total) ? 1 : 0.45,
                    },
                  }, formatAmount(row.total, unit)),
                  Number.isFinite(todayUsed) && todayUsed > 0
                    ? h('span', { style: style.today }, `${t('today')} −${formatAmount(todayUsed, unit)}`)
                    : null))
            }))),
        // 配置面板：与列表同宽就地展开，列出全部渠道（含已隐藏的），
        // 每行显示当前余额，方便判断"这个穷光蛋渠道可以藏起来"。
        collapsed || !configOpen ? null : h('div', { style: style.configPane, 'data-ofm-credit-watch-config': 'pane' },
          h('div', { style: style.configHint }, t('settingsHint')),
          CHANNELS.map(channel => {
            const row = rows.find(item => item.id === channel.id)
            const checked = !hiddenIds.has(channel.id)
            return h('label', {
              key: channel.id, style: style.option,
              'data-channel': channel.id, 'data-checked': checked ? 'true' : 'false',
            },
            h('input', {
              type: 'checkbox', style: style.checkbox, checked,
              onChange: () => persistHidden(toggleHidden(hiddenIds, channel.id)),
            }),
            h('span', { style: { width: 3, height: 14, borderRadius: 2, background: channel.accent, flex: '0 0 auto' } }),
            h('span', { style: style.optionName }, channel.name),
            h('span', { style: style.optionAmount },
              row === undefined
                ? '—'
                : Number.isFinite(row.total)
                  ? formatAmount(row.total, row.unit ?? 'credits')
                  : (row.ok === false ? t('failed') : t('noData'))))
          }),
          h('div', { style: style.configActions },
            h('button', {
              type: 'button', style: style.pill,
              onClick: () => persistHidden(new Set(CHANNELS.map(channel => channel.id))),
            }, t('hideAll')),
            h('button', {
              type: 'button', style: style.pill,
              onClick: () => persistHidden(new Set()),
            }, t('showAll')),
            h('button', {
              type: 'button', style: { ...style.pill, marginLeft: 'auto' },
              onClick: () => setConfigOpen(false),
            }, t('settingsDone')))),
        collapsed ? null : h('div', { style: style.footer },
          h('span', null, rows.length === 0
            ? t('never')
            : total === null ? t('never') : fill(t('summary'), { channels: channelCount, total: kilo(total) })),
          h('span', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
            // 有隐藏项时明说一句，免得"渠道怎么变少了"看起来像故障。
            hiddenCount > 0 ? h('span', null, fill(t('hiddenCount'), { count: hiddenCount })) : null,
            failedCount > 0 ? h('span', { style: { color: 'var(--dsw-alias-state-error-primary, #d33)' } }, `⚠ ${failedCount}`) : null)),
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
      normalizeHidden, toggleHidden, CHANNELS, DICT, HIDDEN_KEY,
      formatAmount, unitOf, toneOf, expireOf, tooltipOf, normalizeTotals,
      accumulateLocal, loadLocalDaily, loadPos, leftOf, localDate, round2,
      loadSize, saveSize, clampSize, relRightFor, sizeLimits, resizeFromDrag,
      SIZE_KEY, MIN_WIDTH, MIN_HEIGHT, HANDLES, CURSOR_BY_DIR,
    }
    return module.exports
  },
})
