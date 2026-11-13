/**
 * dsh-ofm-credit-watch —— Host 半身。
 *
 * 查询与渲染都在浏览器侧：它挂到 `shell.overlay` 悬浮层，用同源
 * `/api/channel-pack` 直接向 Our Free Model（OFM）已注册的 channel-pack
 * 端点查各渠道积分余额。余额本身不需要 Host 中转——凭据、缓存与失败分类
 * 都在 channel-pack 里，Host 再抄一份只会在 OFM 升级时静默漂移。
 *
 * 这里只做一件浏览器做不了的事：**当日累计消耗的账本**。
 *
 * ## 为什么账本必须落在 Host
 *
 * 「当日消耗」是把相邻两次采样之间的余额差累加起来。若让浏览器自己算，
 * 同时开两个窗口就会把同一笔消耗记两遍；清掉浏览器存储又会归零。放到
 * Host 上，先到的请求把基准推到最新、后到的自然得到 0 差值，天然幂等，
 * 换浏览器、换标签页也都接着同一个账。浏览器只负责把本轮读数报上来。
 *
 * ## 基准过旧时不记账
 *
 * 余额差只能说明「这段时间花了多少」，不能说明花在哪一天。若距上次采样
 * 已超过 STALE_MS（默认两小时，可能是一个晚上没开 DSH），这笔差值的归属
 * 无从判断，就不计入当日累计，只把基准更新到最新。宁可少记，也不要凭空
 * 给今天记上一笔昨天的账。
 *
 * 数据目录 `$DSH_HOME/ofm-credit-watch/`：
 *   - `daily-YYYY-MM-DD.json` 当日累计，跨天自动换文件
 *   - `last.json`             上次采样的余额基准与时间戳
 *
 * @module dsh-ofm-credit-watch
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/** 插件标识，与 package.json 的 name 一致。 */
export const name = 'ofm-credit-watch'

/** 依赖宿主提供的 webServer：账本要有同源 HTTP 路由。 */
export const inject = ['webServer']
const API_PREFIX = '/api/ofm-credit-watch'

/** 基准超过这么久就不再把差值记到当日：归属已不可判断。 */
const STALE_MS = 2 * 60 * 60 * 1000

/**
 * 保底落盘间隔。
 *
 * 读数与上一轮完全一致时不写盘（见 {@link commitReadings}），可基准时间也会
 * 跟着停住。若一直不动，超过 {@link STALE_MS} 之后每一轮都会被误判成「基准
 * 过旧」而停止记账。所以最迟这么久强制写一次，让基准时间跟着走。
 */
const RESAVE_MS = 10 * 60 * 1000

/**
 * WorkBuddy 账号账本的门槛。
 *
 * 与 OFM 渠道的区别在于：这里要记两份。**累计**是自本功能启用起的净下降，
 * 跨天、停机之后的那段同样成立，因此不看陈旧与日期；**当日**仍然只在
 * 「间隔不超过两小时且同一天」时才记，晚一天的账不能记到今天头上。
 */
const WB_STALE_MS = 2 * 60 * 60 * 1000
const WB_RESAVE_MS = 10 * 60 * 1000

/** 请求体上限：一轮也就十个渠道，64KB 绰绰有余。 */
const BODY_LIMIT = 64 * 1024

const DSH_HOME = process.env.DSH_HOME || path.join(homedir(), '.dsh')

/**
 * 账本目录。
 *
 * 惰性求值并按 env 覆盖，是为了让离线测试能指向临时目录——否则每跑一次
 * 自测都会往用户真实的当日账本里写字，测试就不再是可重复的。
 */
function ledgerDir() {
  return process.env.OFM_CREDIT_WATCH_DIR || path.join(DSH_HOME, 'ofm-credit-watch')
}

function lastFile() {
  return path.join(ledgerDir(), 'last.json')
}

// ── 小工具 ──────────────────────────────────────────────────────────────────

const round2 = value => Math.round(value * 100) / 100

/**
 * 「今天」按北京时间算，而不是进程本地时区。
 *
 * 账本是给人看「今天花了多少」的，跨天必须与用户日历一致；进程可能跑在
 * 别的时区上，用 `sv-SE` 的 YYYY-MM-DD 形态能避免自己拼格式出错。
 */
function todayKey() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
}

function dailyFile(date) {
  return path.join(ledgerDir(), `daily-${date}.json`)
}

/** 读 JSON；文件缺失、损坏、权限不足一律当没有，不让账本因为脏数据瘫掉。 */
function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/**
 * 先写临时文件再改名：进程被强杀时不会留下半截 JSON，
 * 也就不会在下次启动时把当日账本读成「损坏 → 归零」。
 */
function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(temp, file)
}

/** 把基准文件收敛成可用形状，任何奇怪的值都当没有。 */
function normalizeLast(raw) {
  const totals = {}
  if (raw && typeof raw.totals === 'object' && raw.totals !== null) {
    for (const [provider, value] of Object.entries(raw.totals)) {
      if (Number.isFinite(value)) totals[provider] = value
    }
  }
  const at = raw && Number.isFinite(raw.at) ? raw.at : 0
  const date = raw && typeof raw.date === 'string' ? raw.date : ''
  return { at, date, totals }
}

/** 读当日账本；日期对不上（跨天）就当作今天还没记录。 */
function loadDaily(date) {
  const raw = readJson(dailyFile(date), null)
  if (raw && raw.date === date && raw.totals && typeof raw.totals === 'object') {
    const totals = {}
    for (const [provider, value] of Object.entries(raw.totals)) {
      if (Number.isFinite(value)) totals[provider] = value
    }
    return { date, totals }
  }
  return { date, totals: {} }
}

// ── 账本核心 ────────────────────────────────────────────────────────────────

/** 当前账本快照：今日累计 + 基准时间。浏览器首次挂载时用它填初值。 */
function readLedger() {
  const date = todayKey()
  const daily = loadDaily(date)
  const last = normalizeLast(readJson(lastFile(), null))
  return {
    date,
    totals: daily.totals,
    at: last.at > 0 ? new Date(last.at).toISOString() : null,
  }
}

/**
 * 用一轮读数更新账本，返回今日累计与本次各渠道的消耗。
 *
 * `readings` 是 `[{ provider, total }]`；`total` 为 null/非数表示该渠道
 * 本轮查询失败——此时既不动基准也不记账，否则一次上游抖动会被当成
 * 「余额归零」而记出一笔巨额消耗。
 */
function commitReadings(readings) {
  const at = Date.now()
  const date = todayKey()
  const daily = loadDaily(date)
  const last = normalizeLast(readJson(lastFile(), null))
  const sinceWrite = last.at === 0 ? Number.POSITIVE_INFINITY : at - last.at
  // 基准太旧或跨了一天：差值归属不了，本轮只更新基准。
  //
  // 跨天这一条不能漏：23:59 采到 1000、00:01 采到 900，那 100 是昨天花的，
  // 记到今天就是凭空多报。基准里带着它自己的日期，正是为了这个判断。
  const tooOld = last.at === 0 || sinceWrite > STALE_MS || last.date !== date

  const deltas = {}
  let changed = false
  for (const row of readings) {
    if (!row || typeof row.provider !== 'string') continue
    const provider = row.provider
    const total = Number.isFinite(row.total) ? row.total : null
    const previous = Number.isFinite(last.totals[provider]) ? last.totals[provider] : null

    if (total !== null) {
      if (total !== previous) changed = true
      last.totals[provider] = total
    }

    if (total === null || previous === null || tooOld) {
      deltas[provider] = 0
      continue
    }

    // 只有余额下降才算消耗：领积分、充值会让余额上升，那不是负消耗。
    const delta = previous - total
    if (delta > 0) {
      const next = round2((daily.totals[provider] || 0) + delta)
      daily.totals[provider] = next
      deltas[provider] = round2(delta)
    } else {
      deltas[provider] = 0
    }
  }

  last.at = at
  last.date = date

  // 写盘节流：读数与上一轮一模一样时，两个文件写下去的都是旧内容，
  // 纯属每分钟一次的 IO。此时跳过写，基准值仍然正确——下一轮拿到的
  // 磁盘基准与真实读数一致，差值照旧为 0。保底见 {@link RESAVE_MS}。
  if (changed || tooOld || sinceWrite >= RESAVE_MS) {
    writeJson(dailyFile(date), daily)
    writeJson(lastFile(), last)
  }

  return { date, totals: daily.totals, deltas }
}

// ── WorkBuddy 账号账本 ──────────────────────────────────────────────────────

/**
 * WorkBuddy 账号的键。
 *
 * 带区域前缀：国内版与国际版是两条独立的上游，理论上可能出现同一个
 * accountId，不带区域就会把两边的消耗加到一个桶里。
 */
function wbKey(region, accountId) {
  return `wb:${region}:${accountId}`
}

function wbLastFile() {
  return path.join(ledgerDir(), 'wb-last.json')
}

function wbTotalFile() {
  return path.join(ledgerDir(), 'wb-total.json')
}

function wbDailyFile(date) {
  return path.join(ledgerDir(), `wb-daily-${date}.json`)
}

/** 读任意 `{ totals: { key: number } }` 形状的文件，坏数据一律当空。 */
function loadTotals(file) {
  const raw = readJson(file, null)
  const totals = {}
  if (raw && typeof raw.totals === 'object' && raw.totals !== null) {
    for (const [key, value] of Object.entries(raw.totals)) {
      if (Number.isFinite(value)) totals[key] = value
    }
  }
  return totals
}

/**
 * WorkBuddy 账本快照。
 *
 * `daily` 是今日消耗，`cumulative` 是自本功能启用起的累计消耗——
 * 两者分开存，因为口径不同：累计不跨天清零，也不受「基准过旧」影响，
 * 它记的就是「余额净下降了多少」。
 */
function readWorkBuddyLedger() {
  const date = todayKey()
  const last = normalizeLast(readJson(wbLastFile(), null))
  return {
    date,
    daily: loadTotals(wbDailyFile(date)),
    cumulative: loadTotals(wbTotalFile()),
    at: last.at > 0 ? new Date(last.at).toISOString() : null,
  }
}

/**
 * 用一轮 WorkBuddy 读数更新账本。
 *
 * `readings` 是 `[{ key, total }]`，`total` 非数表示该账号本轮读不到——
 * 此时不动基准也不记账，否则一次上游抖动会被当成「余额归零」。
 */
function commitWorkBuddy(readings) {
  const at = Date.now()
  const date = todayKey()
  const last = normalizeLast(readJson(wbLastFile(), null))
  const sinceWrite = last.at === 0 ? Number.POSITIVE_INFINITY : at - last.at
  const daily = loadTotals(wbDailyFile(date))
  const cumulative = loadTotals(wbTotalFile())

  // 当日口径：跨天或间隔太久就不记（那笔账归属不明），只推进基准。
  const staleForDaily = last.at === 0 || sinceWrite > WB_STALE_MS || last.date !== date
  // 累计口径只看差值本身：停机期间余额照样会掉，那同样是消耗。
  const hasBaseline = last.at !== 0

  const deltas = {}
  let changed = false
  for (const row of readings) {
    if (!row || typeof row.key !== 'string' || row.key === '') continue
    const key = row.key
    const total = Number.isFinite(row.total) ? row.total : null
    const previous = Number.isFinite(last.totals[key]) ? last.totals[key] : null

    if (total !== null) {
      if (total !== previous) changed = true
      last.totals[key] = total
    }

    if (total === null || previous === null) {
      deltas[key] = 0
      continue
    }

    // 只有余额下降才算消耗：签到、领积分、换包都会让余额上升。
    const delta = previous - total
    if (delta <= 0) {
      deltas[key] = 0
      continue
    }
    deltas[key] = round2(delta)
    cumulative[key] = round2((cumulative[key] || 0) + delta)
    if (hasBaseline && !staleForDaily) {
      daily[key] = round2((daily[key] || 0) + delta)
    }
  }

  last.at = at
  last.date = date

  if (changed || staleForDaily || sinceWrite >= WB_RESAVE_MS) {
    writeJson(wbDailyFile(date), { date, totals: daily })
    writeJson(wbTotalFile(), { totals: cumulative })
    writeJson(wbLastFile(), last)
  }

  return { date, daily, cumulative, deltas }
}

// ── HTTP ────────────────────────────────────────────────────────────────────

/**
 * 只接受本机回环请求。
 *
 * 路由能写入用户目录下的账本文件，虽然内容只是些数字，但没有理由让
 * 局域网里随便谁都往上面写。
 */
function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(text)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('请求体不是 JSON'))
      }
    })
    req.on('error', reject)
  })
}

async function handleApi(req, res) {
  if (!isLoopback(req)) return sendJson(res, 403, { error: '只接受本机请求' })

  const url = new URL(req.url ?? '/', 'http://localhost')
  const route = url.pathname.slice(API_PREFIX.length).replace(/\/+$/, '') || '/'

  try {
    if (route === '/ledger') {
      if (req.method === 'GET') return sendJson(res, 200, readLedger())
      if (req.method === 'POST') {
        const body = await readBody(req)
        const readings = Array.isArray(body?.readings) ? body.readings : []
        return sendJson(res, 200, commitReadings(readings))
      }
      return sendJson(res, 405, { error: 'method not allowed' })
    }
    if (route === '/wb') {
      if (req.method === 'GET') return sendJson(res, 200, readWorkBuddyLedger())
      if (req.method === 'POST') {
        const body = await readBody(req)
        const readings = Array.isArray(body?.readings) ? body.readings : []
        return sendJson(res, 200, commitWorkBuddy(readings))
      }
      return sendJson(res, 405, { error: 'method not allowed' })
    }
    if (route === '/ping') return sendJson(res, 200, { ok: true })
    return sendJson(res, 404, { error: 'not found' })
  } catch (error) {
    // 账本写失败不该让卡片整片变空：把原因回给浏览器，它会把当日列留空。
    return sendJson(res, 500, { error: String(error?.message ?? error).slice(0, 200) })
  }
}

/**
 * 挂载账本路由。
 *
 * 不必再判断 `ctx.webServer` 是否存在：Cordis 没有可选注入——`inject` 里
 * 的每一项都是硬依赖，服务缺席时整个插件根本不会被激活。这个插件离了
 * webServer 也确实没有存在意义（浏览器拿不到累计数据），故照常声明即可。
 */
export function apply(ctx) {
  try {
    mkdirSync(ledgerDir(), { recursive: true })
  } catch (error) {
    ctx.logger?.warn?.(`ofm-credit-watch: 无法创建账本目录 (${String(error?.message ?? error)})`)
  }
  const dispose = ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler: handleApi })
  ctx.effect(() => dispose, 'ofm-credit-watch: 当日累计账本')
  ctx.logger?.info?.(`ofm-credit-watch: 当日累计账本挂载在 ${API_PREFIX}`)
}

/** 供离线测试直接驱动账本逻辑，不经过 HTTP。 */
export const __test = {
  commitReadings, readLedger, normalizeLast, todayKey, round2, ledgerDir,
  wbKey, readWorkBuddyLedger, commitWorkBuddy, WB_STALE_MS, WB_RESAVE_MS, RESAVE_MS, STALE_MS,
}
