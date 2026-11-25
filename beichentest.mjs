/**
 * 北辰多分组自测：验证「一个分组一个 Key，逐个取数后按日期/模型合并」。
 *
 * 单分组时代只解析 BEICHEN_MAIN_API_KEY，多分组时只有其中一个进了当日消耗。
 * 这里把 global.fetch 换成按 Authorization 头返回不同分组读数的桩，验证：
 *   - 每个分组都取到，当天与按模型明细跨分组相加，余额求和；
 *   - 单个分组取数失败不影响其它分组，全部失败才 ok:false；
 *   - 无 Key 时 configured:false。
 *
 * DSH_HOME 指到临时目录，避免读到用户真实的 .credentials.yaml 而引入额外分组。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ledgerTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-credit-watch-beichen-'))
const homeTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-credit-watch-beichen-home-'))
process.env.DSH_HOME = homeTemp
process.env.OFM_CREDIT_WATCH_DIR = ledgerTemp

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

function dayRow(date, cost) {
  return {
    date,
    requests: 10,
    input_tokens: 100,
    output_tokens: 20,
    cache_read_tokens: 30,
    cache_write_tokens: 0,
    total_tokens: 150,
    cost,
    actual_cost: cost / 2,
  }
}

async function main() {
  const mod = await import(new URL('./index.js', import.meta.url).href)
  const t = mod.__test

  // ── 纯合并：同一天跨分组相加 ─────────────────────────────────────────────
  {
    const merged = t.mergeBeichenDays([
      { date: '2026-11-24', requests: 10, inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 0, totalTokens: 150, cost: 2, actualCost: 1 },
      { date: '2026-11-24', requests: 5, inputTokens: 40, outputTokens: 8, cacheReadTokens: 12, cacheWriteTokens: 0, totalTokens: 60, cost: 3, actualCost: 1.5 },
    ])
    check('同一天合并为一条', merged.length, 1)
    check('合并后 requests 相加', merged[0].requests, 15)
    check('合并后 inputTokens 相加', merged[0].inputTokens, 140)
    check('合并后 cost 相加', merged[0].cost, 5)
    check('合并后 actualCost 相加', merged[0].actualCost, 2.5)
  }

  // ── 纯合并：按模型名跨分组相加 ───────────────────────────────────────────
  {
    const models = t.mergeBeichenModels([
      { model: 'gpt-4o', requests: 3, input_tokens: 300, output_tokens: 30, cache_read_tokens: 0, total_tokens: 330, actual_cost: 1 },
      { model: 'gpt-4o', requests: 2, input_tokens: 200, output_tokens: 20, cache_read_tokens: 0, total_tokens: 220, actual_cost: 0.5 },
      { model: 'claude', requests: 1, input_tokens: 100, output_tokens: 10, cache_read_tokens: 0, total_tokens: 110, actual_cost: 0.2 },
    ])
    check('按模型名合并为两条', models.length, 2)
    const gpt = models.find(m => m.model === 'gpt-4o')
    check('同名模型 requests 相加', gpt.requests, 5)
    check('同名模型 inputTokens 相加', gpt.inputTokens, 500)
    check('同名模型 actualCost 相加', gpt.actualCost, 1.5)
  }

  const today = new Date().toLocaleDateString('sv-SE')
  const realFetch = globalThis.fetch

  // ── 端到端：两个分组各自取数，合并进当天 ───────────────────────────────
  globalThis.fetch = async (url, options) => {
    const key = options?.headers?.Authorization?.replace('Bearer ', '')
    if (key === 'key-a') {
      return { ok: true, status: 200, json: async () => ({ balance: 10, planName: 'A', mode: 'main', daily_usage: [dayRow(today, 2)], model_stats: [{ model: 'gpt-4o', requests: 3, input_tokens: 300, output_tokens: 30, cache_read_tokens: 0, total_tokens: 330, actual_cost: 1 }] }) }
    }
    if (key === 'key-b') {
      return { ok: true, status: 200, json: async () => ({ balance: 20, planName: 'B', mode: 'main', daily_usage: [dayRow(today, 3)], model_stats: [{ model: 'gpt-4o', requests: 2, input_tokens: 200, output_tokens: 20, cache_read_tokens: 0, total_tokens: 220, actual_cost: 0.5 }] }) }
    }
    return { ok: false, status: 401, json: async () => ({}) }
  }
  try {
    process.env.BEICHEN_API_KEYS = 'key-a,key-b'
    delete process.env.BEICHEN_MAIN_API_KEY
    const out = await t.fetchBeichen()
    check('两个分组都取到', out.keyCount, 2)
    check('取数成功', out.ok, true)
    // 两个分组是同一个账户：余额取最大值，不相加。
    check('余额取账户级最大值', out.balance, 20)
    check('当天只有一条', out.days.length, 1)
    check('当天 cost 相加', out.today.cost, 5)
    check('当天 actualCost 相加', out.today.actualCost, 2.5)
    check('当天 requests 相加', out.today.requests, 20)
    check('按模型合并为一条', out.models.length, 1)
    check('按模型 requests 相加', out.models[0].requests, 5)
    checkTrue('没有分组失败', out.errors.length === 0)
    checkTrue('历史已落盘', fs.existsSync(t.beichenFile()))
    const stored = JSON.parse(fs.readFileSync(t.beichenFile(), 'utf8'))
    check('历史当天 cost 相加', stored.days[today].cost, 5)
  } finally {
    globalThis.fetch = realFetch
    delete process.env.BEICHEN_API_KEYS
  }

  // ── 端到端：单个分组失败不影响另一个 ───────────────────────────────────
  globalThis.fetch = async (url, options) => {
    const key = options?.headers?.Authorization?.replace('Bearer ', '')
    if (key === 'key-a') return { ok: true, status: 200, json: async () => ({ balance: 10, daily_usage: [dayRow(today, 2)], model_stats: [] }) }
    return { ok: false, status: 500, json: async () => ({}) }
  }
  try {
    process.env.BEICHEN_API_KEYS = 'key-a,key-dead'
    const out = await t.fetchBeichen()
    check('部分失败仍 ok', out.ok, true)
    check('仍解析到两个分组', out.keyCount, 2)
    check('记录了失败分组', out.errors, ['HTTP 500'])
    check('成功分组的当天照常返回', out.today.cost, 2)
  } finally {
    globalThis.fetch = realFetch
    delete process.env.BEICHEN_API_KEYS
  }

  // ── 端到端：全部失败才 ok:false ───────────────────────────────────────
  globalThis.fetch = async () => ({ ok: false, status: 502, json: async () => ({}) })
  try {
    process.env.BEICHEN_API_KEYS = 'key-a,key-b'
    const out = await t.fetchBeichen()
    check('全部失败时 ok 为 false', out.ok, false)
    check('全部失败时报错', out.error, 'HTTP 502')
  } finally {
    globalThis.fetch = realFetch
    delete process.env.BEICHEN_API_KEYS
  }

  // ── 无 Key：configured 为 false ────────────────────────────────────────
  try {
    delete process.env.BEICHEN_API_KEYS
    delete process.env.BEICHEN_MAIN_API_KEY
    const out = await t.fetchBeichen()
    check('无 Key 时 configured 为 false', out.configured, false)
    check('无 Key 时 error 为 no-key', out.error, 'no-key')
  } finally {
    globalThis.fetch = realFetch
  }

  // ── Key 解析：凭据文件的多键列表与单键两种写法 ─────────────────────────
  // 凭据里同时放列表、MAIN 与另一个分组的独立命名条目。
  fs.writeFileSync(path.join(homeTemp, '.credentials.yaml'), [
    'BEICHEN_API_KEYS:',
    '  - yaml-a',
    '  - yaml-b',
    'BEICHEN_MAIN_API_KEY: yaml-main',
    'BEICHEN_CC_API_KEY: yaml-cc',
    '',
  ].join('\n'), 'utf8')
  {
    delete process.env.BEICHEN_API_KEYS
    delete process.env.BEICHEN_MAIN_API_KEY
    check('列表、MAIN 与独立命名条目都解析', t.readBeichenKeys(), ['yaml-a', 'yaml-b', 'yaml-main', 'yaml-cc'])
  }
  {
    process.env.BEICHEN_API_KEYS = 'yaml-a,env-x'
    check('环境变量键与凭据合并且去重', t.readBeichenKeys(), ['yaml-a', 'env-x', 'yaml-b', 'yaml-main', 'yaml-cc'])
    delete process.env.BEICHEN_API_KEYS
  }

  // ── 当天没有账单行：用两轮余额差补当天 ───────────────────────────────
  {
    const checkoutDays = fs.readdirSync(ledgerTemp).filter(n => n.startsWith('beichen'))
    for (const name of checkoutDays) fs.rmSync(path.join(ledgerTemp, name), { force: true })
    // 上一节写进凭据文件的 yaml-* 会被一并解析成额外分组，先清掉再只留本节两个 Key。
    fs.rmSync(path.join(homeTemp, '.credentials.yaml'), { force: true })
    // 单 Key：余额差就是账户余额差，口径清晰。
    process.env.BEICHEN_API_KEYS = 'key-a'
    let round = 0
    globalThis.fetch = async () => {
      // 首轮 30 只立基准；第二轮降到 29.5，差额 0.5 记入当天。
      const balance = round === 0 ? 30 : 29.5
      return { ok: true, status: 200, json: async () => ({ balance, daily_usage: [], model_stats: [] }) }
    }
    try {
      const first = await t.fetchBeichen()
      check('首轮无基准不补当天', first.today, null)
      round = 1
      const second = await t.fetchBeichen()
      checkTrue('第二轮用余额差补出当天', second.today !== null)
      check('余额差记入当天 actualCost', second.today?.actualCost, 0.5)
      const thirdRound = await t.fetchBeichen()
      check('余额不变不重复记，当天维持已累积值', thirdRound.today?.actualCost, 0.5)
    } finally {
      globalThis.fetch = realFetch
      delete process.env.BEICHEN_API_KEYS
    }
  }

  // ── 余额是账户级：各分组读到同一钱包，取最大值而不是相加 ─────────────
  {
    for (const name of fs.readdirSync(ledgerTemp).filter(n => n.startsWith('beichen'))) {
      fs.rmSync(path.join(ledgerTemp, name), { force: true })
    }
    fs.rmSync(path.join(homeTemp, '.credentials.yaml'), { force: true })
    process.env.BEICHEN_API_KEYS = 'key-a,key-b'
    // 两个分组的 Key 都返回同一个账户余额 11.4。
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ balance: 11.4, daily_usage: [], model_stats: [] }) })
    try {
      const out = await t.fetchBeichen()
      check('同账户多分组余额取最大值', out.balance, 11.4)
      checkTrue('不把余额相加成两倍', out.balance !== 22.8)
    } finally {
      globalThis.fetch = realFetch
      delete process.env.BEICHEN_API_KEYS
    }
  }

  // ── 旧口径（求和）基准不参与记账，避免算出一笔假消耗 ───────────────────
  {
    for (const name of fs.readdirSync(ledgerTemp).filter(n => n.startsWith('beichen'))) {
      fs.rmSync(path.join(ledgerTemp, name), { force: true })
    }
    fs.rmSync(path.join(homeTemp, '.credentials.yaml'), { force: true })
    process.env.BEICHEN_API_KEYS = 'key-a'
    const today = new Date().toLocaleDateString('sv-SE')
    // 旧版本留下的求和基准 22.8，与现在的账户级余额 11.4 相差一倍多。
    fs.writeFileSync(path.join(ledgerTemp, 'beichen-last.json'),
      JSON.stringify({ at: Date.now(), date: today, total: 22.8 }), 'utf8')
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ balance: 11.4, daily_usage: [], model_stats: [] }) })
    try {
      const out = await t.fetchBeichen()
      check('跨口径旧基准不记假消耗', out.today, null)
    } finally {
      globalThis.fetch = realFetch
      delete process.env.BEICHEN_API_KEYS
    }
  }

  if (failures.length > 0) {
    console.error(`✗ ${failures.length}/${checks} 项失败`)
    for (const line of failures) console.error('  - ' + line)
    process.exitCode = 1
  } else {
    console.log(`✓ ${checks} 项北辰多分组检查全部通过`)
  }
  fs.rmSync(ledgerTemp, { recursive: true, force: true })
  fs.rmSync(homeTemp, { recursive: true, force: true })
}

main().catch(error => {
  console.error('北辰自测异常：', error)
  fs.rmSync(ledgerTemp, { recursive: true, force: true })
  fs.rmSync(homeTemp, { recursive: true, force: true })
  process.exit(1)
})
