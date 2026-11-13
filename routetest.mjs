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
  check('注册了 effect 用于卸载', disposers.length, 1)

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
  } finally {
    await new Promise(resolve => server.close(resolve))
  }

  // 卸载 disposer 不该抛错。
  for (const dispose of disposers) {
    if (typeof dispose === 'function') dispose()
  }

  if (failures.length > 0) {
    console.error(`✗ ${failures.length}/${checks} 项失败`)
    for (const line of failures) console.error('  - ' + line)
    process.exitCode = 1
  } else {
    console.log(`✓ ${checks} 项路由检查全部通过`)
  }
  fs.rmSync(temp, { recursive: true, force: true })
  void port
}

main().catch(error => {
  console.error('路由自测异常：', error)
  fs.rmSync(temp, { recursive: true, force: true })
  process.exit(1)
})
