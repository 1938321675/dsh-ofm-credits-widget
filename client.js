/**
 * dsh-ofm-credits-widget — 浏览器半身。
 *
 * 把积分卡片渲染到 DSH 主界面的 DOM 里（document.body 上的单根容器），
 * 因此它随主界面移动/缩放天然同步、切到设置页等其它视图时不可见。
 *
 * 数据走同源 `/api/ofm-credits/credits`（宿主半身注册的路由），默认 60 秒
 * 刷新一次。界面为浅色卡片：渠道名 / 消耗量（相对上次刷新）/ 剩余额度，
 * 有消耗的渠道排在前；⚙ 打开隐藏配置，按渠道勾选显示。
 *
 * 位置以"距视口右下角的偏移"存在 localStorage，窗口变化后自动贴回。
 */
window.__ModuleLoader__.load({
  id: 'dsh-ofm-credits-widget',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const reactDom = require('react-dom/client')

    const ROOT_ATTR = 'data-dsh-ofm-credits-root'
    const STORE_KEY = 'ofm-credits-widget:v1'
    const API_BASE = '/api/ofm-credits'
    const REFRESH_MS = 60_000
    const POS_MARGIN = 16

    // 浏览器半身没有宿主服务依赖：数据走同源 fetch，UI 自建 DOM 根。
    const inject = []

    // ── 持久化：位置 + 隐藏渠道 + 上次余额（用于算消耗） ──────────────────────
    function loadStore() {
      try {
        const raw = window.localStorage.getItem(STORE_KEY)
        if (!raw) return { relRight: POS_MARGIN, relBottom: POS_MARGIN, hidden: [], totals: {} }
        const parsed = JSON.parse(raw)
        return {
          relRight: Number.isFinite(parsed.relRight) ? parsed.relRight : POS_MARGIN,
          relBottom: Number.isFinite(parsed.relBottom) ? parsed.relBottom : POS_MARGIN,
          hidden: Array.isArray(parsed.hidden) ? parsed.hidden : [],
          totals: parsed.totals && typeof parsed.totals === 'object' ? parsed.totals : {},
        }
      } catch {
        return { relRight: POS_MARGIN, relBottom: POS_MARGIN, hidden: [], totals: {} }
      }
    }

    function saveStore(patch) {
      try {
        const next = { ...loadStore(), ...patch }
        window.localStorage.setItem(STORE_KEY, JSON.stringify(next))
      } catch { /* 隐私模式等场景忽略 */ }
    }

    // ── 格式化 ────────────────────────────────────────────────────────────────
    function compact(value, unit) {
      const abs = Math.abs(value)
      if (unit === 'USD') return '$' + value.toFixed(2)
      if (unit === 'tokens') {
        if (abs >= 1e6) return (value / 1e6).toFixed(1) + 'M'
        if (abs >= 1000) return (value / 1000).toFixed(1) + 'K'
        return formatCredit(value)
      }
      if (abs >= 10000) return (value / 1000).toFixed(1) + 'K'
      return formatCredit(value)
    }

    function formatCredit(value) {
      if (Number.isInteger(value)) return value.toString()
      let s = value.toFixed(2)
      s = s.replace(/(\.\d*?[1-9])0+$/, '$1')
      s = s.replace(/\.0+$/, '')
      return s
    }

    function totalColor(row) {
      if (row.total === null || row.total === undefined) return '#969ca8'
      const warn = row.unit === 'tokens' ? 100000 : row.unit === 'USD' ? 0.5 : 500
      if (row.total <= 0) return '#c63636'
      if (row.total < warn) return '#b07a0c'
      return '#168048'
    }

    function deltaInfo(row) {
      const c = row.consumed || 0
      if (c > 0) return { text: '-' + compact(c, row.unit), color: '#cc741c' }
      if (c < 0) return { text: '+' + compact(-c, row.unit), color: '#168048' }
      return { text: '·', color: '#c8ccd4' }
    }

    // ── 卡片组件 ──────────────────────────────────────────────────────────────
    const S = {
      card: {
        position: 'fixed', width: 300, background: '#fafafc', color: '#373e4a',
        border: '1px solid #ced4de', borderRadius: 8, overflow: 'hidden',
        fontFamily: '"Microsoft YaHei UI", "Segoe UI", sans-serif', fontSize: 12,
        boxShadow: '0 6px 20px rgba(16,24,40,0.18)', userSelect: 'none', zIndex: 2147483000,
      },
      bar: {
        display: 'flex', alignItems: 'center', height: 28, padding: '0 8px',
        background: '#ebedf4', cursor: 'move', gap: 4,
      },
      title: { fontSize: 13, fontWeight: 600, color: '#282e3a', flex: 1 },
      icon: {
        width: 20, height: 20, lineHeight: '20px', textAlign: 'center', borderRadius: 4,
        color: '#6e7684', cursor: 'pointer', fontSize: 13,
      },
      body: { padding: '4px 8px 2px' },
      row: { display: 'flex', alignItems: 'center', height: 24, gap: 6 },
      name: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#373e4a' },
      delta: {
        width: 52, textAlign: 'right', fontFamily: 'Consolas, monospace',
        fontSize: 11, color: '#c8ccd4',
      },
      value: { width: 58, textAlign: 'right', fontFamily: 'Consolas, monospace', fontSize: 13, fontWeight: 700 },
      today: { width: 58, textAlign: 'right', fontFamily: 'Consolas, monospace', fontSize: 11, color: '#969ca8' },
      status: { padding: '2px 8px 5px', textAlign: 'center', fontSize: 10, color: '#969ca8' },
      panel: {
        borderTop: '1px solid #e2e6ee', background: '#f4f6fa', padding: '6px 8px 8px',
        maxHeight: 240, overflowY: 'auto',
      },
      panelHint: { fontSize: 11, color: '#6e7684', marginBottom: 4 },
      checkRow: { display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0', cursor: 'pointer' },
    }

    function CreditsCard(props) {
      const { rows, status, settingsOpen, onToggleSettings, onToggleHidden, hidden, onDragStart, cardRef } = props
      const visible = rows
        .filter(r => !hidden.includes(r.provider))
        .sort((a, b) => {
          const ca = a.consumed > 0 ? 0 : 1
          const cb = b.consumed > 0 ? 0 : 1
          if (ca !== cb) return ca - cb
          return a.label.localeCompare(b.label, 'zh')
        })

      return react.createElement('div', { style: S.card, ref: cardRef },
        react.createElement('div', { style: S.bar, onMouseDown: onDragStart },
          react.createElement('div', { style: S.title }, 'OFM 积分'),
          react.createElement('div', { style: S.icon, title: '显示设置', onClick: onToggleSettings }, '⚙'),
        ),
        react.createElement('div', { style: S.body },
          visible.length === 0
            ? react.createElement('div', { style: { ...S.status, padding: '10px 0' } }, '没有可显示的渠道')
            : visible.map(r => react.createElement('div', { key: r.provider, style: S.row },
                react.createElement('div', { style: S.name, title: tooltipOf(r) }, r.label),
                react.createElement('div', { style: { ...S.delta, color: deltaInfo(r).color } }, deltaInfo(r).text),
                react.createElement('div', { style: { ...S.value, color: totalColor(r) } },
                  r.total === null || r.total === undefined ? '—' : compact(r.total, r.unit)),
                react.createElement('div', { style: { ...S.today } },
                  r.todayConsumed == null ? '—' : ('-' + compact(r.todayConsumed, r.unit))),
              ))
        ),
        settingsOpen && react.createElement('div', { style: S.panel },
          react.createElement('div', { style: S.panelHint }, '勾选要显示的渠道：'),
          rows
            .slice()
            .sort((a, b) => a.label.localeCompare(b.label, 'zh'))
            .map(r => react.createElement('div', {
              key: r.provider,
              style: S.checkRow,
              onClick: () => onToggleHidden(r.provider),
            },
              react.createElement('span', {
                style: {
                  width: 13, height: 13, borderRadius: 3, border: '1px solid #b6bdca',
                  background: hidden.includes(r.provider) ? '#fff' : '#2f6de0',
                  color: '#fff', fontSize: 10, lineHeight: '12px', textAlign: 'center', flex: '0 0 auto',
                },
                onMouseDown: e => e.preventDefault(),
              }, hidden.includes(r.provider) ? '' : '✓'),
              react.createElement('span', { style: S.name }, r.label),
            )),
        ),
        react.createElement('div', { style: S.status }, status),
      )
    }

    function tooltipOf(row) {
      let tip = row.account || ''
      if (Array.isArray(row.packages) && row.packages.length) {
        const visiblePackages = row.packages.filter(p => (p.remaining || 0) > 0)
        tip += '\n' + visiblePackages.map(p => {
          const exp = p.expireAt ? ` 过期：${p.expireAt}` : ''
          return `${p.name}: ${Math.round(p.remaining)}${exp}`
        }).join('\n')
      }
      if (row.error) tip += '\n' + row.error
      return tip
    }

    // ── apply ─────────────────────────────────────────────────────────────────
    function apply(ctx) {
      if (typeof document === 'undefined') return

      const store = loadStore()
      const container = document.createElement('div')
      container.setAttribute(ROOT_ATTR, '')
      document.body.appendChild(container)
      const root = reactDom.createRoot(container)

      const state = {
        rows: [],
        status: '查询中…',
        hidden: store.hidden.slice(),
        settingsOpen: false,
        pos: { relRight: store.relRight, relBottom: store.relBottom },
        totals: { ...store.totals },
      }
      let timer = null
      let disposed = false

      function place() {
        const card = container.firstElementChild
        if (!card) return
        const w = card.offsetWidth || 256
        const h = card.offsetHeight || 200
        const maxLeft = Math.max(0, window.innerWidth - w - state.pos.relRight)
        const maxTop = Math.max(0, window.innerHeight - h - state.pos.relBottom)
        // 用 left/top 直接写，避免每次 render 重新计算造成跳动
        card.style.left = maxLeft + 'px'
        card.style.top = maxTop + 'px'
      }

      const cardRef = node => {
        if (!node) return
        requestAnimationFrame(() => {
          place()
          const observer = new ResizeObserver(() => place())
          observer.observe(node)
        })
      }

      function render() {
        if (disposed) return
        root.render(react.createElement(CreditsCard, {
          rows: state.rows,
          status: state.status,
          settingsOpen: state.settingsOpen,
          hidden: state.hidden,
          cardRef,
          onToggleSettings: () => {
            state.settingsOpen = !state.settingsOpen
            render()
          },
          onToggleHidden: provider => {
            const idx = state.hidden.indexOf(provider)
            if (idx >= 0) state.hidden.splice(idx, 1)
            else state.hidden.push(provider)
            saveStore({ hidden: state.hidden })
            render()
          },
          onDragStart: onDragStart,
        }))
      }

      function onDragStart(event) {
        if (event.button !== 0) return
        const card = container.firstElementChild
        if (!card) return
        const startX = event.clientX
        const startY = event.clientY
        const rect = card.getBoundingClientRect()
        const startLeft = rect.left
        const startTop = rect.top

        const move = e => {
          const w = card.offsetWidth || 256
          const h = card.offsetHeight || 200
          let left = startLeft + (e.clientX - startX)
          let top = startTop + (e.clientY - startY)
          left = Math.max(0, Math.min(left, window.innerWidth - w))
          top = Math.max(0, Math.min(top, window.innerHeight - h))
          card.style.left = left + 'px'
          card.style.top = top + 'px'
        }
        const up = () => {
          window.removeEventListener('mousemove', move)
          window.removeEventListener('mouseup', up)
          const r = card.getBoundingClientRect()
          state.pos.relRight = Math.max(0, window.innerWidth - r.right)
          state.pos.relBottom = Math.max(0, window.innerHeight - r.bottom)
          saveStore({ relRight: state.pos.relRight, relBottom: state.pos.relBottom })
        }
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
        event.preventDefault()
      }

      async function refresh() {
        try {
          const res = await fetch(`${API_BASE}/credits`, { cache: 'no-store' })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const data = await res.json()
          if (disposed) return
          const rows = Array.isArray(data.rows) ? data.rows : []
          // 消耗 = 上次余额 - 本次余额（正=消耗，负=签到/充值）
          const nextTotals = {}
          const merged = rows.map(row => {
            if (row.total === null || row.total === undefined) return { ...row, consumed: 0 }
            const prev = state.totals[row.provider]
            nextTotals[row.provider] = row.total
            return { ...row, consumed: typeof prev === 'number' ? prev - row.total : 0 }
          })
          state.totals = nextTotals
          saveStore({ totals: nextTotals })
          state.rows = merged
          const at = new Date()
          const failed = merged.filter(r => r.total === null || r.total === undefined).length
          const stamp = at.toTimeString().slice(0, 8)
          state.status = `${stamp} 已刷新${failed ? `（${failed} 个失败）` : ''}`
        } catch (error) {
          if (disposed) return
          state.status = '刷新失败：' + String(error?.message ?? error).slice(0, 90)
        }
        render()
      }

      render()
      refresh()
      timer = window.setInterval(() => { if (document.visibilityState !== 'hidden') refresh() }, REFRESH_MS)

      // 视口变化（窗口缩放、切换主视图布局）后贴回右下角
      const onResize = () => place()
      window.addEventListener('resize', onResize)

      ctx.effect(() => () => {
        disposed = true
        if (timer) window.clearInterval(timer)
        window.removeEventListener('resize', onResize)
        try { root.unmount() } catch { /* 已卸载 */ }
        container.remove()
      }, 'ofm-credits-widget: card lifecycle')
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
