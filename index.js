/**
 * dsh-ofm-credits-widget — 宿主半身。
 *
 * 浏览器半身（client.js）渲染在 DSH 主界面的 DOM 里，通过同源的
 * `/api/ofm-credits/*` 拿数据；本文件负责注册这些路由，并把查询委托给
 * `widget/credits-query.mjs`（与 OFM 插件的 channel-pack `credits.balances`
 * 同源直连各渠道余额端点）。
 *
 * 两套运行形态：
 * 1. DOM 卡片（默认）—— 数据走 HTTP 路由，插件启停即卡片显隐。
 * 2. 独立 Win32 窗口（旧形态，保留作回退）—— 设 `OFM_WIDGET_MODE=window`
 *    环境变量，或写了 `use-window-widget` 标记文件时启用；命中时不再起
 *    HTTP 路由，改拉 PowerShell 悬浮窗。
 *
 * 历史教训（2026-10-29/30）：
 * - 从 DSH 宿主子进程会话里直启 GUI 进程会静默秒退 —— 经 explorer.exe 代启动
 *   .lnk 等价双击。
 * - 用 CIM 按命令行清扫窗口进程要数秒，会误杀热重组后新拉起的窗口 —— 改 pidfile。
 * - owned window 不进 EnumWindows 顶层列表，外部工具"看不到"是正常的。
 */
import { spawn, execFile } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export const name = 'ofm-credits-widget'
export const inject = ['webServer']

const pluginDir = path.dirname(fileURLToPath(import.meta.url))
const widgetDir = path.join(pluginDir, 'widget')
const queryScript = path.join(widgetDir, 'credits-query.mjs')
const widgetLauncher = path.join(widgetDir, 'credits-widget.lnk')
const pidFile = path.join(pluginDir, 'widget-pid.txt')
const modeFlag = path.join(pluginDir, 'use-window-widget')

const API_PREFIX = '/api/ofm-credits'
const QUERY_TIMEOUT_MS = 45_000
/** 结果缓存：多个界面轮询时不必每次真打上游。 */
const CACHE_MS = 20_000
let cache = { at: 0, payload: null, inflight: null }

function mark(event, detail = '') {
  try { appendFileSync(path.join(pluginDir, 'lifecycle.log'), `${new Date().toISOString()} ${event} ${detail}\n`) } catch { /* 尽力 */ }
}

/** 决定本次是否走旧窗口形态。 */
function wantsWindowMode() {
  if (process.env.OFM_WIDGET_MODE === 'window') return true
  return existsSync(modeFlag)
}

// ── 旧形态：PowerShell 悬浮窗 ─────────────────────────────────────────────────

function killRecordedWidget() {
  let pid = 0
  try { pid = parseInt(readFileSync(pidFile, 'utf8'), 10) || 0 } catch { return false }
  if (pid <= 0) return false
  try { process.kill(pid); mark('kill-pid', `pid=${pid}`); return true }
  catch (error) {
    if (error?.code === 'ESRCH') { try { unlinkSync(pidFile) } catch { /* 已没了 */ } return false }
    mark('kill-fail', `${pid}: ${error?.message ?? error}`)
    return false
  }
}

function spawnWindowWidget(ctx) {
  killRecordedWidget()
  try {
    const child = spawn('explorer.exe', [widgetLauncher], { windowsHide: true, stdio: 'ignore' })
    child.unref()
    mark('spawn-window-ok', `explorer=${child.pid}`)
    ctx.logger?.info?.('ofm-credits-widget: 悬浮窗（窗口形态）已拉起')
  } catch (error) {
    mark('spawn-window-fail', String(error?.message ?? error))
    ctx.logger?.warn?.(`ofm-credits-widget: 启动窗口失败 (${error?.message ?? error})`)
  }
  ctx.effect(() => () => {
    mark('dispose-window')
    killRecordedWidget()
  }, 'ofm-credits-widget: window lifecycle')
}

// ── 新形态：查询服务 ─────────────────────────────────────────────────────────

/** 跑一次 credits-query.mjs，返回解析后的 JSON。 */
function runQuery() {
  return new Promise((resolve, reject) => {
    execFile(
      process.platform === 'win32' ? 'node.exe' : 'node',
      [queryScript],
      { cwd: widgetDir, timeout: QUERY_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          // 超时/非零退出：把 stderr 摘要带回，界面能显示原因而不是空白
          reject(new Error((stderr || error.message || 'query failed').toString().slice(0, 300)))
          return
        }
        try {
          resolve(JSON.parse(stdout))
        } catch (parseError) {
          reject(new Error(`查询输出不是 JSON: ${String(parseError?.message ?? parseError)}`))
        }
      },
    )
  })
}

/** 带缓存与并发合并的取数。 */
function getCredits(force) {
  const now = Date.now()
  if (!force && cache.payload && now - cache.at < CACHE_MS) {
    return Promise.resolve({ ...cache.payload, cached: true })
  }
  if (cache.inflight) return cache.inflight
  cache.inflight = runQuery()
    .then(payload => {
      cache = { at: Date.now(), payload, inflight: null }
      return payload
    })
    .catch(error => {
      cache.inflight = null
      throw error
    })
  return cache.inflight
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

async function handleApi(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const route = url.pathname.slice(API_PREFIX.length).replace(/\/+$/, '') || '/'
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
  try {
    if (route === '/credits') {
      const force = url.searchParams.get('force') === '1'
      const payload = await getCredits(force)
      return sendJson(res, 200, payload)
    }
    if (route === '/ping') return sendJson(res, 200, { ok: true })
    return sendJson(res, 404, { error: 'not found' })
  } catch (error) {
    mark('api-error', String(error?.message ?? error))
    return sendJson(res, 500, { error: String(error?.message ?? error) })
  }
}

export function apply(ctx) {
  mark('apply-enter', wantsWindowMode() ? 'mode=window' : 'mode=dom')
  if (wantsWindowMode()) {
    if (process.platform !== 'win32') {
      ctx.logger?.info?.('ofm-credits-widget: 窗口形态仅支持 Windows，本宿主跳过')
      return
    }
    spawnWindowWidget(ctx)
    return
  }

  // DOM 形态：注册查询路由，浏览器半身自己渲染卡片。
  if (!ctx.webServer) {
    ctx.logger?.warn?.('ofm-credits-widget: 宿主没有 webServer，DOM 卡片不可用')
    return
  }
  const dispose = ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler: handleApi })
  ctx.effect(() => dispose, 'ofm-credits-widget: credits API')
  // 切到 DOM 形态时清掉可能残留的旧窗口（回退切换后不留孤儿）
  killRecordedWidget()
  ctx.logger?.info?.('ofm-credits-widget: 积分查询路由已挂载在 ' + API_PREFIX)
}
