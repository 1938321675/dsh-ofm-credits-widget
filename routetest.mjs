/**
 * 路由集成测试：真的起一个 HTTP 服务，把 index.js 的 apply 挂上去，
 * 再用 fetch 打它——验证的是 webServer.register 契约之外的一切：
 * 路径前缀剥离、方法分派、body 解析、loopback 守卫、账本往返。
 *
 * 单测账本函数（ledgertest.mjs）测不出这些：它们全在 HTTP 层，
 * 而且这一层最容易因为拼错前缀或方法名而静默 404。
 */

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-credit-watch-route-'))
process.env.OFM_CREDIT_WATCH_DIR = temp
// index.js 在模块顶层就把 DSH_HOME 求成了常量，所以必须在 import 之前指过去。
// 否则读的是用户真实目录：GPT 订阅快照那组断言会读到线上数据而非本测试的假快照。
process.env.DSH_HOME = temp
// 用量路由默认读用户真实的 cost-meter 账本；测试指向一个不存在的文件，
// 这样断言的是"读不到账本时的行为"，而不是当天真实用量。
process.env.OFM_COST_METER_LEDGER = path.join(temp, 'no-such-ledger.json')

const failures = []
let checks = 0
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

/**
 * 极简 webServer 桩：只实现这个插件用到的 `register({kind:'prefix'})`。
 * 前缀剥离交给真正的 http 服务做，这样测到的是真实的分派行为。
 */
function fakeWebServer() {
  const routes = []
  return {
    routes,
    register(spec) {
      routes.push(spec)
      return () => {}
    },
  }
}

async function main() {
  const mod = await import(new URL('./index.js', import.meta.url).href)

  const webServer = fakeWebServer()
  const disposers = []
  const ctx = {
    webServer,
    logger: { info() {}, warn() {} },
    effect(factory) { disposers.push(factory()) },
  }
  mod.apply(ctx)

  check('注册了一条路由', webServer.routes.length, 1)
  check('路由是前缀匹配', webServer.routes[0].kind, 'prefix')
  check('路由前缀正确', webServer.routes[0].path, '/api/ofm-credit-watch')
  // effect 的数量不该写死：插件每多一处需要在卸载时清理的资源（路由、定时器）
  // 就多一个 effect。这里要验的是「注册了、并且每个都能安全调用」。
  checkTrue('注册了 effect 用于卸载', disposers.length >= 1)
  checkTrue('每个 effect 都返回可调用的清理函数', disposers.every(fn => typeof fn === 'function'))

  // 真 HTTP 服务：把 /api/ofm-credit-watch/* 交给路由处理。
  const route = webServer.routes[0]
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (!url.pathname.startsWith(route.path)) {
      res.writeHead(404); res.end('no route'); return
    }
    // 复刻 webServer 的前缀语义：handler 看到的是完整 URL，自己剥前缀。
    route.handler(req, res)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}${route.path}`
  const port = server.address().port

  try {
    // ── ping ──
    {
      const res = await fetch(`${base}/ping`)
      check('ping 200', res.status, 200)
      check('ping 内容', await res.json(), { ok: true })
    }

    // ── GET 空账本 ──
    {
      const res = await fetch(`${base}/ledger`)
      check('GET ledger 200', res.status, 200)
      const body = await res.json()
      check('空账本 totals 为空对象', body.totals, {})
      check('空账本 at 为 null', body.at, null)
      checkTrue('空账本带日期', typeof body.date === 'string' && body.date.length === 10)
    }

    // ── POST 第一轮：无基准，不应记账 ──
    {
      const res = await fetch(`${base}/ledger`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ readings: [{ provider: 'qoder', total: 1000 }] }),
      })
      check('POST ledger 200', res.status, 200)
      const body = await res.json()
      check('首轮无基准不记账', body.totals, {})
      check('首轮 delta 为 0', body.deltas.qoder, 0)
    }

    // ── POST 第二轮：下降应记账 ──
    {
      const res = await fetch(`${base}/ledger`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ readings: [{ provider: 'qoder', total: 940 }] }),
      })
      const body = await res.json()
      check('第二轮记下 60', body.totals.qoder, 60)
      check('第二轮 delta 为 60', body.deltas.qoder, 60)
    }

    // ── GET 能看到累计（首次挂载时浏览器走这条） ──
    {
      const body = await (await fetch(`${base}/ledger`)).json()
      check('GET 返回已累计的 60', body.totals.qoder, 60)
      checkTrue('GET 带基准时间', typeof body.at === 'string')
    }

    // ── 坏请求体 ──
    {
      const res = await fetch(`${base}/ledger`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{ 这不是 JSON',
      })
      check('坏 JSON 返回 500 而不是崩掉', res.status, 500)
      checkTrue('坏 JSON 带回错误说明', typeof (await res.json()).error === 'string')
    }

    // ── readings 不是数组：当作空，不记坏账 ──
    {
      const res = await fetch(`${base}/ledger`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ readings: 'oops' }),
      })
      check('readings 非数组仍 200', res.status, 200)
      check('readings 非数组不破坏账本', (await res.json()).totals.qoder, 60)
    }

    // ── WorkBuddy 账本：/wb ──
    {
      const empty = await (await fetch(`${base}/wb`)).json()
      check('GET wb 空账本 daily 为空', empty.daily, {})
      check('GET wb 空账本 cumulative 为空', empty.cumulative, {})

      const key = 'wb:cn:a1'
      const first = await (await fetch(`${base}/wb`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ readings: [{ key, total: 500 }] }),
      })).json()
      check('wb 首轮不记账', first.deltas[key], 0)

      const second = await (await fetch(`${base}/wb`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ readings: [{ key, total: 420 }] }),
      })).json()
      check('wb 第二轮当日 80', second.daily[key], 80)
      check('wb 第二轮累计 80', second.cumulative[key], 80)

      const snapshot = await (await fetch(`${base}/wb`)).json()
      check('GET wb 读到累计', snapshot.cumulative[key], 80)
      check('GET wb 读到当日', snapshot.daily[key], 80)

      const bad = await fetch(`${base}/wb`, { method: 'DELETE' })
      check('wb DELETE 返回 405', bad.status, 405)
    }

    // ── token 用量：/usage ──
    {
      const res = await fetch(`${base}/usage`)
      check('GET usage 200', res.status, 200)
      const body = await res.json()
      // 测试环境默认没有 cost-meter 账本：应当是 available=false 而不是报错。
      check('无账本时 available 为 false', body.available, false)
      check('无账本时 days 为空', body.days, [])

      const bad = await fetch(`${base}/usage`, { method: 'POST' })
      check('usage POST 返回 405', bad.status, 405)
    }

    // ── 方法不支持 ──
    {
      const res = await fetch(`${base}/ledger`, { method: 'DELETE' })
      check('DELETE 返回 405', res.status, 405)
    }

    // ── 未知路由 ──
    {
      const res = await fetch(`${base}/nope`)
      check('未知路由 404', res.status, 404)
    }

    // ── loopback 守卫 ──
    // 直接构造一个 remoteAddress 不是回环的请求，绕过 DNS。
    {
      const fakeReq = {
        method: 'GET',
        url: '/api/ofm-credit-watch/ledger',
        socket: { remoteAddress: '192.168.1.50' },
        on() {}, 
      }
      const captured = {}
      const fakeRes = {
        writeHead(code) { captured.status = code },
        end(text) { captured.body = text },
      }
      await route.handler(fakeReq, fakeRes)
      check('非回环请求被拒 403', captured.status, 403)
    }

    // ── 尾斜杠与查询串 ──
    {
      const res = await fetch(`${base}/ledger/?force=1`)
      check('带尾斜杠与查询串仍能命中', res.status, 200)
    }

    // 确认数据确实写到了临时目录，而不是用户真实账本。
    // OFM 渠道与 WorkBuddy 各两个基准文件 + 各自的当日账本；
    // 目录里不该有第五种之外的东西。
    const files = fs.readdirSync(temp)
    checkTrue('账本落在指定目录', files.includes('last.json'))
    checkTrue('当日账本文件已生成', files.some(name => name.startsWith('daily-')))
    checkTrue('WorkBuddy 账本文件已生成', files.includes('wb-last.json') && files.includes('wb-total.json'))
    checkTrue('WorkBuddy 当日账本已生成', files.some(name => name.startsWith('wb-daily-')))
    check('目录里只有这两套账本', files.length, 5)
  // ── GPT 订阅快照的失效判定 ──
  // 关键语义：样本旧不代表读数失效。用掉的部分不会自己涨回去，只要还没到
  // 该窗口的重置点，快照上的百分比就一直有效。长期不用订阅时快照会很旧，
  // 这时把读数藏起来恰恰是最需要它的时候（想先看一眼余量再决定要不要用）。
  {
    const forecast = path.join(temp, 'state', 'codex-subscription', 'quota-forecast.json')
    const scope = 'scope-x'
    /** 造一份快照：两窗各自的「样本多久前」与「还有多久重置」（负数=已过重置点）。 */
    const writeForecast = (fiveAgeSec, weekAgeSec, fiveResetsInSec, weekResetsInSec) => {
      const nowMs = Date.now()
      const mk = (ageSec, resetsInSec, pct) => ({
        resetsAt: Math.round((nowMs + resetsInSec * 1000) / 1000),
        samples: [{ at: nowMs - ageSec * 1000, remainingPercent: pct }],
      })
      const body = { windows: {} }
      body.windows[JSON.stringify([scope, 'codex', 18000])] = mk(fiveAgeSec, fiveResetsInSec, 73)
      body.windows[JSON.stringify([scope, 'codex', 604800])] = mk(weekAgeSec, weekResetsInSec, 88)
      fs.mkdirSync(path.dirname(forecast), { recursive: true })
      fs.writeFileSync(forecast, JSON.stringify(body), 'utf8')
    }
    const readQuota = async () => {
      const res = await fetch(`${base}/codex`)
      return await res.json()
    }

    try {
      // 样本两小时前，但两个窗口都还没到重置点：读数仍然有效。
      writeForecast(7200, 7200, 3600, 86400 * 3)
      const old = await readQuota()
      checkTrue('样本很旧但窗口未翻篇时不算过期', old.stale === false)
      checkTrue('样本很旧时标记 aged', old.aged === true)
      check('窗口未翻篇时两个读数都可用', old.live, 2)
      check('窗口未翻篇时仍给出余量', old.windows.map(row => Math.round(row.remainingPercent)), [73, 88])

      // 5 小时窗已翻过重置点：该窗顺延为满额，周窗照常有效，整体不算过期。
      writeForecast(7200, 7200, -60, 86400 * 3)
      const half = await readQuota()
      checkTrue('单窗翻篇时整体仍可用', half.stale === false)
      check('单窗翻篇后两个窗口都可用', half.live, 2)
      const fiveRow = half.windows.find(row => row.kind === 'fiveHour')
      check('翻篇的窗口标记为顺延', fiveRow.replenished, true)
      check('翻篇的窗口余量回到满额', fiveRow.remainingPercent, 100)
      check('翻篇的窗口不再标 expired', fiveRow.expired, false)
      checkTrue('翻篇窗口的重置时刻已顺延到未来', fiveRow.resetsAt > Date.now())
      check('未翻篇的窗口不被顺延', half.windows.find(row => row.kind === 'weekly').replenished, false)

      // 两个窗口都翻过重置点：两窗都顺延为满额，界面照常显示，不因快照陈旧而空着。
      writeForecast(7200, 7200, -60, -60)
      const dead = await readQuota()
      checkTrue('两个窗口都翻篇时整体仍可用', dead.stale === false)
      check('两个窗口都翻篇时两窗都顺延为满额', dead.windows.map(row => row.remainingPercent), [100, 100])
      checkTrue('两个窗口的重置时刻都顺延到未来',
        dead.windows.every(row => Number.isFinite(row.resetsAt) && row.resetsAt > Date.now()))
    } finally {
      fs.rmSync(path.join(temp, 'state'), { recursive: true, force: true })
    }
  }

  // ── /agy：限额响应同时带两个订阅栏的今日 token ─────────────────────────
  {
    const poolDir = path.join(temp, 'agy-accounts')
    fs.mkdirSync(poolDir, { recursive: true })
    fs.writeFileSync(path.join(poolDir, 'pool.json'), JSON.stringify({
      version: 1,
      accounts: [{
        id: 'acc_a', alias: 'primary', email: 'a@example.com', planTier: 'pro', enabled: true,
        quotas: {
          google: {
            remainingFraction: 0.7, resetTime: '2099-01-01T00:00:00Z',
            weeklyFraction: 0.8, weeklyResetTime: '2099-01-08T00:00:00Z', description: '', updatedAt: Date.now(),
          },
          anthropic: {
            weeklyFraction: 0.9, weeklyResetTime: '2099-01-08T00:00:00Z', description: '', updatedAt: Date.now(),
          },
        },
      }],
      primaryAccountId: 'acc_a',
      activeAccountIds: { google: 'acc_a', anthropic: 'acc_a' },
      lastActiveAccountId: 'acc_a',
    }), 'utf8')
    // 本地采集账本里放两个订阅栏的今日用量，验证响应把两栏一起带回。
    const date = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
    fs.writeFileSync(path.join(temp, 'ofm-tokens-' + date + '.json'), JSON.stringify({
      date,
      channels: {},
      workbuddy: { input: 0, output: 0, cacheRead: 0, calls: 0 },
      agyGemini: { input: 100, output: 50, cacheRead: 900, calls: 2 },
      agyClaude: { input: 200, output: 80, cacheRead: 1800, calls: 3 },
    }), 'utf8')

    const res = await fetch(base + '/agy')
    check('GET /agy 200', res.status, 200)
    const body = await res.json()
    check('agy 读数可用', body.available, true)
    checkTrue('agy 读数带 Gemini 栏 token', body.tokens && body.tokens.gemini && body.tokens.gemini.input === 100)
    checkTrue('agy 读数带 Claude 栏 token', body.tokens && body.tokens.claude && body.tokens.claude.input === 200)
    checkTrue('agy 读数带账号池', Array.isArray(body.accounts) && body.accounts.length === 1)

    // 5 小时窗已翻过重置点：顺延为满额，界面继续显示，而不是整窗消失。
    // 样本停在重置点之前（updatedAt 早于 resetTime），这样快照里的百分比是
    // 重置前的残留，正是需要顺延处理的情形。
    const pastReset = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString()
    const beforeReset = Date.now() - 7 * 60 * 60 * 1000
    fs.writeFileSync(path.join(poolDir, 'pool.json'), JSON.stringify({
      version: 1,
      accounts: [{
        id: 'acc_a', alias: 'primary', email: 'a@example.com', planTier: 'pro', enabled: true,
        quotas: {
          google: {
            remainingFraction: 0.2, resetTime: pastReset,
            weeklyFraction: 0.8, weeklyResetTime: '2099-01-08T00:00:00Z', description: '', updatedAt: beforeReset,
          },
          anthropic: {
            weeklyFraction: 0.9, weeklyResetTime: '2099-01-08T00:00:00Z', description: '', updatedAt: Date.now(),
          },
        },
      }],
      primaryAccountId: 'acc_a',
      activeAccountIds: { google: 'acc_a', anthropic: 'acc_a' },
      lastActiveAccountId: 'acc_a',
    }), 'utf8')
    const replenished = await fetch(base + '/agy')
    const replenishedBody = await replenished.json()
    const geminiFamily = replenishedBody.accounts[0].families.find(row => row.family === 'google')
    check('agy 翻篇窗口余量回到满额', geminiFamily.fiveHour, 100)
    check('agy 翻篇窗口标记顺延', geminiFamily.fiveHourReplenished, true)
    check('agy 翻篇窗口不再标失效', geminiFamily.fiveHourExpired, false)
    checkTrue('agy 翻篇窗口的重置时刻顺延到未来', geminiFamily.fiveHourResetsAt > Date.now())
    check('agy 周窗不受 5 小时窗翻篇影响', geminiFamily.weekly, 80)

    fs.rmSync(poolDir, { recursive: true, force: true })
    fs.rmSync(path.join(temp, 'ofm-tokens-' + date + '.json'), { force: true })
  }

  if (failures.length > 0) {
    console.error(`✗ ${failures.length}/${checks} 项失败`)
    for (const line of failures) console.error('  - ' + line)
    process.exitCode = 1
  } else {
    console.log(`✓ ${checks} 项路由检查全部通过`)
  }
  } finally {
    await new Promise(resolve => server.close(resolve))
  }

  // 卸载 disposer 不该抛错。
  for (const dispose of disposers) {
    if (typeof dispose === 'function') dispose()
  }

  fs.rmSync(temp, { recursive: true, force: true })
  void port
}

main().catch(error => {
  console.error('路由自测异常：', error)
  fs.rmSync(temp, { recursive: true, force: true })
  process.exit(1)
})
