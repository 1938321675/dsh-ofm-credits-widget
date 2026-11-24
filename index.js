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

import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

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

// ── 模型用量（token）统计 ───────────────────────────────────────────────────

/**
 * 用量数据来自 cost-meter 的日聚合账本。
 *
 * 它是唯一一份「按天 × provider × model」的现成记录：插件运行期间每笔调用
 * 都会落在这里，不需要我们再从会话日志里重算一遍——重算会与 cost-meter 的
 * 口径漂移，而且会话日志是 zstd 多帧、解析成本高得多。
 *
 * 账本 1.7MB 量级，且是「有调用才写」，所以按 mtime + size 做一层缓存：
 * 面板每 5 分钟轮询一次，命中缓存时只 stat 一次文件。
 */
function usageLedgerFile() {
  return process.env.OFM_COST_METER_LEDGER ||
    path.join(DSH_HOME, 'storages', 'cost-meter', 'ledger.json')
}

/** OFM 的十个渠道在账本里各自是独立的 provider 前缀。 */
const OFM_PROVIDERS = [
  'lobsterai', 'qoder', 'qodercn', 'trae', 'cline',
  'loomy', 'raccoon', 'minimax', 'zcode', 'gemini',
]

/** WorkBuddy 两个区域的前缀；面板把它们合成一个总数。 */
const WORKBUDDY_PROVIDERS = ['workbuddy', 'workbuddy-global']

/**
 * GPT 订阅（ChatGPT 账号）的 provider id。
 *
 * 订阅插件只回「还剩多少百分比」，不带 token 用量；用量得自己从 llm/stream
 * 的 usage 块里采。订阅线路的额度按百分比计，token 用量是另一件事，两者
 * 一起看才知道「这点余量是被多少 token 吃掉的」。
 */
const CODEX_PROVIDERS = ['openai-codex']

// ── 自带用量账本（不依赖 cost-meter）────────────────────────────────────────
/**
 * 自己记一份 OFM 渠道的 token 用量。
 *
 * 面板原本读 cost-meter 的账本，但那是另一个插件的数据——它被停用、升级
 * 换格式或还没写盘时，这栏就没有数据可读。这里改为直接挂宿主自己的
 * `llm/stream` 钩子：每次模型调用结束都会带一个 usage 块（inputTokens /
 * outputTokens / cacheReadTokens 等），当场累加到本地账本。
 *
 * 口径与 cost-meter 一致：OFM 的十个渠道与免费车道按渠道分开记，WorkBuddy
 * 两个区域合成一个总数——主界面那行给的是「所有账号的今日 token 合计」。
 *
 * 文件：`ofm-tokens-YYYY-MM-DD.json`，每天一份，跨天自动换文件。
 */
function tokensFile(date) {
  return path.join(ledgerDir(), `ofm-tokens-${date}.json`)
}

/**
 * usage 块 → 五桶。字段名以宿主 usage 块为准，缺项按 0。
 *
 * 只取这四项：reasoning 已经包含在 output 里，重复相加会把 output 算两遍。
 */
function bucketsOf(usage) {
  const n = value => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0)
  return {
    input: n(usage?.inputTokens),
    output: n(usage?.outputTokens),
    cacheRead: n(usage?.cacheReadTokens),
  }
}

/**
 * 记一次调用。
 *
 * 只有 OFM 渠道才入账：provider 是渠道 id 本身。宿主在瀑布各层可能重复
 * 派发同一个 usage（包装路由），所以按 (provider, model, 三桶) 做 10 秒窗口
 * 去重——与 cost-meter 的指纹窗口同一思路，避免同一笔调用记两次。
 */
const TOKEN_DEDUP_MS = 10_000
const tokenSeen = new Map()

function dedupToken(sessionId, provider, model, buckets, atMs) {
  const fingerprint = JSON.stringify([sessionId ?? '', provider, model ?? '', buckets.input, buckets.output, buckets.cacheRead])
  const previous = tokenSeen.get(fingerprint)
  if (previous !== undefined && Math.abs(atMs - previous) < TOKEN_DEDUP_MS) return false
  tokenSeen.set(fingerprint, atMs)
  // 清掉过期指纹：这张表一分钟就能涨到几百条，不定期扫会一直涨。
  if (tokenSeen.size > 512) {
    for (const [key, at] of tokenSeen) {
      if (Math.abs(atMs - at) >= TOKEN_DEDUP_MS) tokenSeen.delete(key)
    }
  }
  return true
}

function recordTokenUsage(provider, model, sessionId, usage, atMs) {
  if (typeof provider !== 'string' || provider === '') return
  const isOfm = OFM_PROVIDERS.includes(provider) || provider === 'our-free-model'
  const isWorkBuddy = WORKBUDDY_PROVIDERS.includes(provider)
  const isCodex = CODEX_PROVIDERS.includes(provider)
  if (!isOfm && !isWorkBuddy && !isCodex) return
  const buckets = bucketsOf(usage)
  if (buckets.input === 0 && buckets.output === 0 && buckets.cacheRead === 0) return
  if (!dedupToken(sessionId, provider, model, buckets, atMs)) return

  const date = todayKey()
  const file = tokensFile(date)
  const state = readJson(file, null)
  const record = state && state.date === date && typeof state.channels === 'object' && state.channels !== null
    ? state : { date, channels: {}, workbuddy: { input: 0, output: 0, cacheRead: 0, calls: 0 } }
  // OFM 渠道逐渠道记；WorkBuddy 与 GPT 订阅各按一个合计桶记。
  const target = isWorkBuddy
    ? (record.workbuddy ?? (record.workbuddy = { input: 0, output: 0, cacheRead: 0, calls: 0 }))
    : isCodex
      ? (record.codex ?? (record.codex = { input: 0, output: 0, cacheRead: 0, calls: 0 }))
      : (record.channels[provider] ?? (record.channels[provider] = { input: 0, output: 0, cacheRead: 0, calls: 0 }))
  target.input += buckets.input
  target.output += buckets.output
  target.cacheRead += buckets.cacheRead
  target.calls += 1
  try {
    writeJson(file, record)
  } catch {
    // 写盘失败不该打断模型流：这一笔丢失，下一轮照常记。
  }
}

/**
 * 自带账本的今日读数。
 *
 * 与 {@link readOfmTokenUsage} 返回同一形状，前端不必区分数据来自哪里。
 * 今天的文件还没有（今天第一次调用尚未发生）时返回 day:null。
 */
function readLocalTokenUsage() {
  const date = todayKey()
  const state = readJson(tokensFile(date), null)
  if (state === null || state.date !== date || typeof state.channels !== 'object' || state.channels === null) {
    return { available: true, day: null, channels: [], total: null, source: 'local' }
  }
  const channels = []
  const total = { input: 0, output: 0, cacheRead: 0, calls: 0 }
  for (const [channel, row] of Object.entries(state.channels)) {
    if (row === null || typeof row !== 'object') continue
    const bucket = {
      channel,
      input: Number(row.input) || 0,
      output: Number(row.output) || 0,
      cacheRead: Number(row.cacheRead) || 0,
      calls: Number(row.calls) || 0,
    }
    if (bucket.calls === 0) continue
    channels.push(bucket)
    total.input += bucket.input
    total.output += bucket.output
    total.cacheRead += bucket.cacheRead
    total.calls += bucket.calls
  }
  return {
    available: true, day: date, channels, total, source: 'local',
    workbuddy: localBucketTotal(state, 'workbuddy'),
    codex: localBucketTotal(state, 'codex'),
  }
}

/**
 * 本地账本里某个合计桶的今日用量（workbuddy / codex）。
 *
 * 没有记录时返回全 0 而不是 null：0 表示「今天这个渠道确实还没用过」，
 * null 留给「连数据源都没有」，前端据此决定显示 0 还是占位。
 */
function localBucketTotal(state, key) {
  const row = state?.[key]
  if (row === null || typeof row !== 'object') return { input: 0, output: 0, cacheRead: 0, calls: 0 }
  return {
    input: Number(row.input) || 0,
    output: Number(row.output) || 0,
    cacheRead: Number(row.cacheRead) || 0,
    calls: Number(row.calls) || 0,
  }
}

// ── 启动回填：补齐「采集器还没挂上时」漏掉的 GPT 订阅用量 ─────────────────
/**
 * 会话日志是一份可回溯的用量记录：每条 `assistant/message` 都带 usage 块。
 *
 * 采集器只能在插件挂载之后记数，重启前那段（尤其是今天早些时候）就漏了。
 * 订阅分区只显示「今日 token」，漏一段会让数字明显偏小，所以启动时从今天的
 * 会话日志补一遍。只补 codex：OFM 与 WorkBuddy 那边同样会漏，但本插件已经
 * 在跑一整天，重启造成的缺口远小于 codex 这条今天才接入的线路。
 *
 * 日志是多帧 zstd 拼接，`zstdDecompressSync` 对整份文件只解第一帧（只有头行），
 * 必须按帧魔数切开逐帧解压；明文日志则直接读。
 */
const SESSION_LOG = /^session(?:\.v([1-9]\d*))?\.jsonl(\.zstd)?$/

function decompressSessionLog(file) {
  const buf = readFileSync(file)
  if (!file.endsWith('.zstd')) {
    return buf.toString('utf8')
  }
  const magic = [0x28, 0xb5, 0x2f, 0xfd]
  const offsets = []
  for (let i = 0; i + 3 < buf.length; i += 1) {
    if (buf[i] === magic[0] && buf[i + 1] === magic[1] && buf[i + 2] === magic[2] && buf[i + 3] === magic[3]) offsets.push(i)
  }
  const parts = []
  for (let k = 0; k < offsets.length; k += 1) {
    const start = offsets[k]
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length
    try { parts.push(zstdDecompressSync(buf.subarray(start, end))) } catch { /* 半截帧跳过 */ }
  }
  return Buffer.concat(parts).toString('utf8')
}

/** 列出每个会话目录的当前代日志文件。 */
function listSessionLogs(root) {
  const files = []
  let projects = []
  try { projects = readdirSync(root) } catch { return files }
  for (const project of projects) {
    let sessions = []
    try { sessions = readdirSync(path.join(root, project)) } catch { continue }
    for (const session of sessions) {
      const dir = path.join(root, project, session)
      let names = []
      try { names = readdirSync(dir) } catch { continue }
      const candidates = names
        .map(name => {
          const matched = SESSION_LOG.exec(name)
          return matched === null ? null : { name, version: Number(matched[1] ?? 0), compressed: Boolean(matched[2]) }
        })
        .filter(Boolean)
        .sort((a, b) => b.version - a.version || Number(b.compressed) - Number(a.compressed))
      if (candidates.length > 0) files.push(path.join(dir, candidates[0].name))
    }
  }
  return files
}

/**
 * 从今天的会话日志补齐漏采的用量。
 *
 * 与实时采集共用同一个账本和同一个合计桶，因此这里**只补差额**：账本里已有的
 * 部分不重复累加。做法是拿日志重建出的总量与账本当前值取较大者——日志是完整
 * 记录、账本是增量累计，正常情况下日志的量大；万一日志被清理过，保留账本值。
 */
function backfillTodayFromSessionLogs(sessionsRoot) {
  const date = todayKey()
  const dayStart = Date.parse(`${date}T00:00:00+08:00`)
  if (!Number.isFinite(dayStart)) return { updated: false, reason: 'no-day' }
  const rebuilt = {}
  let scanned = 0
  for (const file of listSessionLogs(sessionsRoot)) {
    let info
    try { info = statSync(file) } catch { continue }
    if (info.mtimeMs < dayStart) continue
    scanned += 1
    let text
    try { text = decompressSessionLog(file) } catch { continue }
    for (const line of text.split('\n')) {
      if (line === '') continue
      let row
      try { row = JSON.parse(line) } catch { continue }
      const usage = row?.data?.usage
      if (usage === null || usage === undefined) continue
      const provider = row?.data?.message?.source?.provider ?? row?.data?.provider
      if (typeof provider !== 'string') continue
      const isCodex = CODEX_PROVIDERS.includes(provider)
      const isWorkBuddy = WORKBUDDY_PROVIDERS.includes(provider)
      const isOfm = OFM_PROVIDERS.includes(provider) || provider === 'our-free-model'
      if (!isCodex && !isWorkBuddy && !isOfm) continue
      const time = Number(row?.time)
      if (!Number.isFinite(time) || time < dayStart) continue
      const key = isCodex ? 'codex' : isWorkBuddy ? 'workbuddy' : provider
      const bucket = rebuilt[key] ?? (rebuilt[key] = { input: 0, output: 0, cacheRead: 0, calls: 0 })
      const parsed = bucketsOf(usage)
      bucket.input += parsed.input
      bucket.output += parsed.output
      bucket.cacheRead += parsed.cacheRead
      bucket.calls += 1
    }
  }
  if (scanned === 0) return { updated: false, reason: 'no-logs' }

  const file = tokensFile(date)
  const state = readJson(file, null)
  const record = state && state.date === date && typeof state.channels === 'object' && state.channels !== null
    ? state : { date, channels: {}, workbuddy: { input: 0, output: 0, cacheRead: 0, calls: 0 } }
  let changed = false
  for (const [key, bucket] of Object.entries(rebuilt)) {
    const target = key === 'codex' || key === 'workbuddy'
      ? (record[key] ?? (record[key] = { input: 0, output: 0, cacheRead: 0, calls: 0 }))
      : (record.channels[key] ?? (record.channels[key] = { input: 0, output: 0, cacheRead: 0, calls: 0 }))
    // 只升不降：日志重建值更大说明有漏采，补上；更小说明日志不全，保留账本。
    if (bucket.input > target.input) { target.input = bucket.input; changed = true }
    if (bucket.output > target.output) { target.output = bucket.output; changed = true }
    if (bucket.cacheRead > target.cacheRead) { target.cacheRead = bucket.cacheRead; changed = true }
    if (bucket.calls > target.calls) { target.calls = bucket.calls; changed = true }
  }
  if (!changed) return { updated: false, reason: 'up-to-date' }
  try {
    writeJson(file, record)
    return { updated: true, keys: Object.keys(rebuilt) }
  } catch {
    return { updated: false, reason: 'write-failed' }
  }
}

/**
 * 把本插件自己采集的日账本并进 `days`（同一天以本地为准）。
 *
 * cost-meter 停用后它那边的账本不再增长，主界面「今日 token」与统计页就只能
 * 靠这份本地账。同一天两边都有时用本地的：它是实时采集的，覆盖的是同一个
 * 口径，取本地不会把两个来源相加。
 */
function mergeLocalDays(days) {
  let names = []
  try { names = readdirSync(ledgerDir()) } catch { return }
  for (const name of names) {
    if (!name.startsWith('ofm-tokens-') || !name.endsWith('.json')) continue
    const state = readJson(path.join(ledgerDir(), name), null)
    const date = typeof state?.date === 'string' ? state.date : ''
    if (date === '' || typeof state?.channels !== 'object' || state.channels === null) continue
    const ofm = emptyUsage()
    const workbuddy = emptyUsage()
    const byChannel = {}
    for (const [channel, row] of Object.entries(state.channels)) {
      if (row === null || typeof row !== 'object') continue
      addUsage(ofm, row)
      byChannel[channel] = emptyUsage()
      addUsage(byChannel[channel], row)
    }
    const wb = state.workbuddy
    if (wb !== null && typeof wb === 'object') addUsage(workbuddy, wb)
    // GPT 订阅：独立一桶，统计页与订阅分区都用它。
    const codex = emptyUsage()
    const cx = state.codex
    if (cx !== null && typeof cx === 'object') addUsage(codex, cx)
    const existing = days.find(row => row.date === date)
    if (existing === undefined) days.push({ date, ofm, workbuddy, byChannel, codex })
    else {
      existing.ofm = ofm
      existing.workbuddy = workbuddy
      existing.byChannel = byChannel
      // codex 只在本地区账本真有记录时才覆盖：cost-meter 那边可能留着本插件
      // 尚未采到的那一段历史，本地是空桶时把它抹成 0，统计页的 GPT 订阅
      // 行就会凭空消失。
      if (codex.calls > 0 || codex.input + codex.output + codex.cacheRead > 0) existing.codex = codex
    }
  }
}

/** 缓存：文件指纹没变就不重新解析。 */
let usageCache = { key: '', value: null }

/** 把一条 byProviderModel 记录累加进目标桶。 */
function addUsage(target, row) {
  target.input += Number.isFinite(row?.input) ? row.input : 0
  target.output += Number.isFinite(row?.output) ? row.output : 0
  target.cacheRead += Number.isFinite(row?.cacheRead) ? row.cacheRead : 0
  target.calls += Number.isFinite(row?.calls) ? row.calls : 0
  return target
}

function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, calls: 0 }
}

/**
 * 读账本并按天汇总成面板要的形状。
 *
 * 返回 `{ available, days: [{ date, ofm, workbuddy, byChannel }] }`，日期升序。
 * 账本缺失或读不出来时 `available: false`——面板据此显示「未连接 cost-meter」，
 * 而不是把 0 当成"今天没花"。
 */
/**
 * 数据源指纹：cost-meter 账本 + 本地采集账本。
 *
 * 缓存键必须覆盖**所有**参与汇总的文件。只算 cost-meter 那份是不够的：它停用
 * 之后 mtime 永远不动，键就永远不变，缓存建好一次就再也不失效——本地采集的
 * 新用量全被挡在缓存外面（面板上表现为积分在涨、token 一直不动）。
 */
function usageSourceKey() {
  const parts = []
  for (const file of [usageLedgerFile()]) {
    try {
      const st = statSync(file)
      parts.push(`${st.mtimeMs}:${st.size}`)
    } catch {
      parts.push('missing')
    }
  }
  let names = []
  try { names = readdirSync(ledgerDir()) } catch { names = [] }
  for (const name of names.filter(n => n.startsWith('ofm-tokens-') && n.endsWith('.json')).sort()) {
    try {
      const st = statSync(path.join(ledgerDir(), name))
      parts.push(`${name}:${st.mtimeMs}:${st.size}`)
    } catch {
      parts.push(`${name}:missing`)
    }
  }
  return parts.join('|')
}

/** 本地采集账本是否已有任何一天的记录。 */
function hasLocalTokenLedger() {
  try {
    return readdirSync(ledgerDir()).some(name => name.startsWith('ofm-tokens-') && name.endsWith('.json'))
  } catch {
    return false
  }
}

function readUsageStats() {
  const file = usageLedgerFile()
  const key = usageSourceKey()
  if (usageCache.key === key && usageCache.value !== null) return usageCache.value

  // cost-meter 账本缺失不再是「没有数据」：本地采集账本可以独立支撑这份汇总。
  // 只有两个来源都没有时才算不可用——那时面板显示「没有数据源」才是实话。
  let ledger = null
  try {
    ledger = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    ledger = null
  }
  if (ledger === null && !hasLocalTokenLedger()) return { available: false, ledger: file, days: [] }

  const ofmSet = new Set(OFM_PROVIDERS)
  const wbSet = new Set(WORKBUDDY_PROVIDERS)
  const codexSet = new Set(CODEX_PROVIDERS)
  const days = []
  for (const [date, day] of Object.entries(ledger?.days ?? {})) {
    const rows = day?.byProviderModel
    if (rows === null || typeof rows !== 'object') continue
    const ofm = emptyUsage()
    const workbuddy = emptyUsage()
    const codex = emptyUsage()
    const byChannel = {}
    for (const [prefix, row] of Object.entries(rows)) {
      // 账本键是 `provider:model`；模型名里可能还有冒号，只切第一个。
      const colon = prefix.indexOf(':')
      const provider = colon === -1 ? prefix : prefix.slice(0, colon)
      if (wbSet.has(provider)) { addUsage(workbuddy, row); continue }
      // GPT 订阅线路（openai-codex）与 WorkBuddy 同一种算法：整条线路合成
      // 一个桶。订阅额度按百分比计、用量按 token 计，两者一起才说得清
      // 「这点余量是被多少 token 吃掉的」。
      if (codexSet.has(provider)) { addUsage(codex, row); continue }
      if (!ofmSet.has(provider)) continue
      addUsage(ofm, row)
      if (byChannel[provider] === undefined) byChannel[provider] = emptyUsage()
      addUsage(byChannel[provider], row)
    }
    days.push({ date, ofm, workbuddy, byChannel, codex })
  }
  mergeLocalDays(days)
  days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))

  const value = { available: true, ledger: file, days }
  usageCache = { key, value }
  return value
}


// ── 北辰 API（beichenapi.com）─────────────────────────────────────────────────
/**
 * 北辰是中转网关，余额与用量不走 channel-pack：网页 /usage 要登录，网关另
 * 开了一条只读口子 GET /v1/usage，用 API Key 就能取到余额、当天汇总、按模型
 * 明细。这里做的是「浏览器做不了」的那一半：Key 在 Host 侧解析，历史按日落在
 * 本机（接口只回当天，多天趋势得自己攒）。
 *
 * 只读查询，不发起推理，因此不产生任何 token 计费。
 */
const BEICHEN_USAGE_URL = 'https://api.beichenapi.com/v1/usage'
const BEICHEN_CACHE_MS = 60_000
const BEICHEN_KEEP_DAYS = 90
const BEICHEN_TIMEOUT_MS = 15_000
let beichenCache = null
let beichenInFlight = null

function beichenFile() {
  return path.join(ledgerDir(), 'beichen-days.json')
}

/** Key 解析：环境变量优先，其次 `~/.dsh/.credentials.yaml` 里的同名条目。 */
function readBeichenKey() {
  const env = process.env.BEICHEN_MAIN_API_KEY
  if (typeof env === 'string' && env.trim() !== '') return env.trim()
  try {
    const text = readFileSync(path.join(DSH_HOME, '.credentials.yaml'), 'utf8')
    const match = text.match(/^\s*BEICHEN_MAIN_API_KEY\s*:\s*['\"]?([^'\"\s#]+)/m)
    return match === null ? '' : match[1].trim()
  } catch {
    return ''
  }
}

function readBeichenDays() {
  try {
    const raw = JSON.parse(readFileSync(beichenFile(), 'utf8'))
    if (raw !== null && typeof raw === 'object' && raw.days !== null && typeof raw.days === 'object') return raw
  } catch { /* 还没有历史是常态 */ }
  return { days: {} }
}

function writeBeichenDays(state) {
  try {
    mkdirSync(ledgerDir(), { recursive: true })
    const target = beichenFile()
    const temp = target + '.' + process.pid + '.tmp'
    writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 })
    renameSync(temp, target)
  } catch (error) {
    // 写不进去不该让余额也显示不出来：历史是加分项，读数才是主体。
  }
}

function countOf(value) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

/**
 * 把接口的按模型明细归一成插件自己的字段名。
 *
 * model_stats 是累计口径（对应接口的 usage.total），不分日，因此只用于分区里的
 * 模型明细，不进「今天」的统计。
 */
function normalizeBeichenModels(rows) {
  if (!Array.isArray(rows)) return []
  return rows
    .map(row => {
      const model = typeof row?.model === 'string' ? row.model.trim() : ''
      if (model === '') return null
      return {
        model,
        requests: countOf(row?.requests),
        inputTokens: countOf(row?.input_tokens),
        outputTokens: countOf(row?.output_tokens),
        cacheReadTokens: countOf(row?.cache_read_tokens),
        totalTokens: countOf(row?.total_tokens),
        actualCost: countOf(row?.actual_cost),
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.totalTokens - a.totalTokens)
}

/** 把接口的一天归一成插件自己的字段名。 */
function normalizeBeichenDay(row) {
  if (row === null || typeof row !== 'object') return null
  const date = typeof row.date === 'string' ? row.date.trim() : ''
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  return {
    date,
    requests: countOf(row.requests),
    inputTokens: countOf(row.input_tokens),
    outputTokens: countOf(row.output_tokens),
    cacheReadTokens: countOf(row.cache_read_tokens),
    cacheWriteTokens: countOf(row.cache_write_tokens),
    totalTokens: countOf(row.total_tokens),
    cost: countOf(row.cost),
    actualCost: countOf(row.actual_cost),
  }
}

async function fetchBeichen() {
  const key = readBeichenKey()
  const days = Object.values(readBeichenDays().days).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  if (key === '') return { configured: false, ok: false, error: 'no-key', balance: null, unit: 'USD', today: null, days }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), BEICHEN_TIMEOUT_MS)
  let response
  try {
    response = await fetch(BEICHEN_USAGE_URL, {
      headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' },
      signal: controller.signal,
    })
  } catch (error) {
    const reason = error?.name === 'AbortError' ? 'timeout' : String(error?.message ?? error)
    return { configured: true, ok: false, error: reason, balance: null, unit: 'USD', today: null, days }
  } finally {
    clearTimeout(timer)
  }
  if (!response.ok) return { configured: true, ok: false, error: 'HTTP ' + response.status, balance: null, unit: 'USD', today: null, days }
  let body
  try {
    body = await response.json()
  } catch (error) {
    return { configured: true, ok: false, error: String(error?.message ?? error), balance: null, unit: 'USD', today: null, days }
  }
  // 每日行写进历史：接口给的是当天累计，按日期覆盖即最新值。
  const state = readBeichenDays()
  for (const row of Array.isArray(body?.daily_usage) ? body.daily_usage : []) {
    const day = normalizeBeichenDay(row)
    if (day !== null) state.days[day.date] = day
  }
  const floor = new Date(Date.now() - BEICHEN_KEEP_DAYS * 86_400_000)
  const pad = n => String(n).padStart(2, '0')
  const cutoff = String(floor.getFullYear()) + '-' + pad(floor.getMonth() + 1) + '-' + pad(floor.getDate())
  for (const key2 of Object.keys(state.days)) if (key2 < cutoff) delete state.days[key2]
  writeBeichenDays(state)
  // 按模型明细（model_stats）是「累计」口径，接口不分日：它对应 usage.total，
  // 与上面的 daily_usage 不是一回事。这里照原样带回，由界面标注清楚，
  // 不混进某一天的统计里。
  const models = normalizeBeichenModels(body?.model_stats)
  const merged = Object.values(state.days).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const todayKey = new Date().toLocaleDateString('sv-SE')
  const today = merged.find(row => row.date === todayKey) ?? null
  return {
    configured: true,
    ok: true,
    balance: countOf(body?.balance ?? body?.remaining),
    unit: 'USD',
    plan: typeof body?.planName === 'string' ? body.planName : '',
    mode: typeof body?.mode === 'string' ? body.mode : '',
    today,
    days: merged,
    models,
  }
}

/** 60 秒缓存 + 并发去重：卡片每分钟轮询，不必每次真的打上游。 */
async function readBeichen(force) {
  const now = Date.now()
  if (force !== true && beichenCache !== null && now - beichenCache.at < BEICHEN_CACHE_MS) return beichenCache.value
  if (beichenInFlight !== null) return beichenInFlight
  beichenInFlight = (async () => {
    try {
      const value = await fetchBeichen()
      beichenCache = { at: Date.now(), value }
      return value
    } finally {
      beichenInFlight = null
    }
  })()
  return beichenInFlight
}


// ── GPT 订阅限额（dsh-codex-subscription）──────────────────────────────────
/**
 * 订阅插件把每次 /wham/usage 的读数连同预测样本落在
 * `~/.dsh/state/codex-subscription/quota-forecast.json`：键是
 * `[scope, limitId, windowSeconds]`，样本里是 remainingPercent（0-100，剩余量）。
 * 这里不复制它的 OAuth 生命周期，只读它落好的盘——它自己的界面每分钟都在
 * 驱动这份快照，数据最多滞后约一分钟。5 小时窗 = 18000s，周窗 = 604800s。
 */
const CODEX_FORECAST_FILE = 'state/codex-subscription/quota-forecast.json'
const CODEX_WINDOWS = [
  { key: 18_000, label: 'fiveHour' },
  { key: 604_800, label: 'weekly' },
]

/**
 * 快照多久没更新就算过期。
 *
 * 订阅插件跑起来时每 5～60 秒写一次样本（见它的 quotaRefreshMs：用得越多写得越勤），
 * 所以十几分钟没有新样本只可能是一种情况——它这一阵没在采样，通常就是 DSH 关着。
 * 这段时间里 5 小时窗多半已经翻过了重置点，快照上的百分比是上一轮的残留，
 * 拿它当「现在还剩多少」会明显偏高。超过这个时长就标 stale，界面改为占位，
 * 等它把新样本写进来再显示。
 */
const CODEX_STALE_MS = 15 * 60 * 1000

function readCodexQuota() {
  let state
  try {
    const raw = JSON.parse(readFileSync(path.join(DSH_HOME, CODEX_FORECAST_FILE), 'utf8'))
    if (raw !== null && typeof raw === 'object' && raw.windows !== null && typeof raw.windows === 'object') state = raw.windows
    else state = {}
  } catch {
    // 订阅插件没装或还没驱动过快照：返回 available:false，面板据此显示占位。
    return { available: false, windows: [] }
  }
  const windows = []
  for (const [key, record] of Object.entries(state)) {
    let scope = '', limitId = '', seconds = 0
    try {
      const parts = JSON.parse(key)
      if (Array.isArray(parts)) { scope = String(parts[0] ?? ''); limitId = String(parts[1] ?? ''); seconds = Number(parts[2] ?? 0) }
    } catch { continue }
    const last = Array.isArray(record?.samples) && record.samples.length > 0 ? record.samples[record.samples.length - 1] : null
    const remaining = last === null ? null : Number(last.remainingPercent)
    if (!Number.isFinite(remaining)) continue
    const matched = CODEX_WINDOWS.find(row => row.key === seconds)
    windows.push({
      scope,
      limitId,
      windowSeconds: seconds,
      kind: matched?.label ?? (seconds < 3600 * 24 ? 'short' : 'long'),
      remainingPercent: Math.max(0, Math.min(100, remaining)),
      resetsAt: Number.isFinite(Number(record?.resetsAt)) ? Number(record.resetsAt) * 1000 : null,
      sampledAt: last === null ? null : Number(last.at),
    })
  }
  // 只留 codex 主限额：scope 取最新样本的那一组，其余（code_review 等）不进面板。
  const codexWindows = windows.filter(row => row.limitId === 'codex')
  const latest = codexWindows.reduce((acc, row) => row.sampledAt !== null && (acc === null || row.sampledAt > acc) ? row.sampledAt : acc, null)
  const picked = latest === null ? [] : codexWindows.filter(row => row.sampledAt === latest)
  // 今日 token 跟限额一起回：订阅线路的额度是按百分比算的，光看「还剩 48%」
  // 不知道是被多少 token 吃掉的。这份数据来自本插件自己的采集账本。
  const tokens = readLocalTokenUsage()
  const todayTokens = tokens.codex ?? null
  if (picked.length === 0) {
    return { available: false, windows: [], sampledAt: null, ageMs: null, stale: false, tokens: todayTokens }
  }
  // 陈旧判定放在 Host 侧：浏览器算不出「样本是不是早就该翻篇了」，
  // 它只看得到一个百分比。开机那一刻快照还停在上次关机的读数，这里必须先拦下。
  const ageMs = Math.max(0, Date.now() - latest)
  return { available: true, windows: picked, sampledAt: latest, ageMs, stale: ageMs > CODEX_STALE_MS, tokens: todayTokens }
}

// ── OFM 模型今日 token（cost-meter）────────────────────────────────────────
/**
 * cost-meter 的账本按 `provider:model` 记今日用量；OFM 免费模型走
 * `our-free-model:` 前缀。这里按渠道（provider id 是冒号后第一段）聚合成
 * 面板要的形状。账本读不到时 available:false。
 */
const COST_METER_LEDGER = 'storages/cost-meter/ledger.json'

function readOfmTokenUsage() {
  let ledger
  try {
    ledger = JSON.parse(readFileSync(path.join(DSH_HOME, COST_METER_LEDGER), 'utf8'))
  } catch {
    return { available: false, day: null, channels: [], total: null }
  }
  // 必须按「今天」精确取，不能取账本里最后一天。
  //
  // 跨天之后今天第一次调用可能还没发生，账本尚未写入——此时最后一条是昨天的，
  // 取它会让面板整个白天都挂着一个不会变的旧数，看起来就像「累计没清空」。
  // 找不今天的记录就如实报 day:null，界面显示占位。
  const date = todayKey()
  const day = ledger?.days?.[date]
  // 今天还没有记录（今天第一次调用尚未发生，或账本尚未落盘）：如实报空，
  // 让界面显示占位，而不是把昨天的数顶上去。
  if (day === null || typeof day !== 'object') return { available: true, day: null, channels: [], total: null }
  // 账本键是 `provider:model`。OFM 十个账号渠道各自是独立前缀（与 OFM_PROVIDERS
  // 一致），免费车道则是 `our-free-model`。模型名里可能还有冒号，只切第一段。
  const ofmSet = new Set(OFM_PROVIDERS)
  const channels = {}
  let grand = { input: 0, output: 0, cacheRead: 0, calls: 0 }
  for (const [prefix, row] of Object.entries(day?.byProviderModel ?? {})) {
    const colon = prefix.indexOf(':')
    const provider = colon === -1 ? prefix : prefix.slice(0, colon)
    if (!ofmSet.has(provider) && provider !== 'our-free-model') continue
    const channel = ofmSet.has(provider) ? provider : 'our-free-model'
    const bucket = channels[channel] ?? (channels[channel] = { channel, input: 0, output: 0, cacheRead: 0, calls: 0 })
    bucket.input += Number(row?.input ?? 0)
    bucket.output += Number(row?.output ?? 0)
    bucket.cacheRead += Number(row?.cacheRead ?? 0)
    bucket.calls += Number(row?.calls ?? 0)
    grand.input += Number(row?.input ?? 0)
    grand.output += Number(row?.output ?? 0)
    grand.cacheRead += Number(row?.cacheRead ?? 0)
    grand.calls += Number(row?.calls ?? 0)
  }
  return { available: true, day: date, channels: Object.values(channels), total: grand }
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
    if (route === '/usage') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
      return sendJson(res, 200, readUsageStats())
    }
    // 北辰 API 的余额与按日用量：Host 侧解析 Key、请求上游、留存历史。
    if (route === '/beichen') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
      return sendJson(res, 200, await readBeichen(url.searchParams.get('force') === '1'))
    }
    // GPT 订阅限额：读订阅插件落盘的预测快照。
    if (route === '/codex') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
      return sendJson(res, 200, readCodexQuota())
    }
    // OFM 免费模型的今日 token：读 cost-meter 账本。
    if (route === '/ofm-tokens') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
      // 本地账本优先：它由本插件自己挂 llm/stream 采集，不依赖 cost-meter。
      // 本地还没有今天的数据时才回落到 cost-meter 的账本（老用户第一次升级时
      // 今天早些时候的用量还在那边，直接丢掉会让当日数字凭空归零）。
      const local = readLocalTokenUsage()
      return sendJson(res, 200, local.day === null ? readOfmTokenUsage() : local)
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

  // 用量采集：挂在宿主的 llm/stream 瀑布上，每次模型调用结束取一次 usage。
  //
  // global: true 让子会话、后台任务与其它 llm 服务作用域里的调用也走这里——
  // 面板要的是「今天 OFM 花了多少」，漏掉子代理会把数字算小。
  // 只透传 next()，不改变流协议，也不吞下游的异常。
  if (typeof ctx.on === 'function') {
    const disposeStream = ctx.on('llm/stream', (options, next) => {
      const startedAtMs = Date.now()
      const provider = options?.provider
      const model = options?.model
      const sessionId = options?.sessionId
      const downstream = next()
      return (async function* ofmTokenWatchStream() {
        let usage = null
        for await (const chunk of downstream) {
          if (chunk !== null && chunk !== undefined && chunk.type === 'usage' && chunk.usage != null) usage = chunk.usage
          yield chunk
        }
        if (usage !== null) {
          try { recordTokenUsage(provider, model, sessionId, usage, startedAtMs) } catch { /* 记账失败不影响已跑完的流 */ }
        }
      })()
    }, { global: true })
    // ctx.on 的返回值由 Cordis 按插件作用域自动回收，不必再包一层 effect：
    // 多包一层会在卸载时把同一个 disposer 调用两次。
  }
  // 启动回填：采集器只能记挂载之后的调用，今天早些时候（或上一次运行）的用量
  // 会漏。放到定时器里异步跑——它要解开几十 MB 的会话日志，放在 apply 里会把
  // 启动拖住近十秒。失败只是少补一段数，不影响实时采集。
  const backfillTimer = setTimeout(() => {
    try {
      const result = backfillTodayFromSessionLogs(path.join(DSH_HOME, 'sessions'))
      if (result.updated) ctx.logger?.info?.(`ofm-credit-watch: 启动回填已补齐 ${result.keys.join(', ')}`)
    } catch (error) {
      ctx.logger?.debug?.(`ofm-credit-watch: 启动回填跳过 (${String(error?.message ?? error)})`)
    }
  }, 3000)
  backfillTimer.unref?.()
  ctx.effect(() => () => clearTimeout(backfillTimer), 'ofm-credit-watch: 启动回填')

  ctx.logger?.info?.(`ofm-credit-watch: 当日累计账本挂载在 ${API_PREFIX}`)
}

/** 供离线测试直接驱动账本逻辑，不经过 HTTP。 */
export const __test = {
  commitReadings, readLedger, normalizeLast, todayKey, round2, ledgerDir,
  wbKey, readWorkBuddyLedger, commitWorkBuddy, WB_STALE_MS, WB_RESAVE_MS, RESAVE_MS, STALE_MS,
  readUsageStats, usageLedgerFile, OFM_PROVIDERS, WORKBUDDY_PROVIDERS, usageCache,
  fetchBeichen, readBeichen, readBeichenKey, beichenFile, normalizeBeichenModels,
  readCodexQuota, readOfmTokenUsage,
  recordTokenUsage, readLocalTokenUsage, tokensFile, bucketsOf,
  backfillTodayFromSessionLogs, listSessionLogs, decompressSessionLog, CODEX_PROVIDERS,
}
