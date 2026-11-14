/**
 * 账本自测：验证 index.js 里「当日累计消耗」的记账规则。
 *
 * 先把 OFM_CREDIT_WATCH_DIR 指到系统临时目录，再动态 import index.js——
 * 账本目录是惰性求值的，这样测试永远不会碰用户真实的当日账本。
 *
 * 测的是最容易错、又最难在界面上看出来的几条：
 *   - 余额下降才计入，领积分/充值不算负消耗；
 *   - 查询失败不动基准（否则一次上游抖动会被记成花光了）；
 *   - 基准太旧或跨天时不记账，只更新基准；
 *   - 两个窗口先后报同一轮读数，只记一次（幂等）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-credit-watch-test-'))
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

/** 每一节用独立目录，避免上一节的基准影响下一节。 */
let sectionDir = 0
function freshDir() {
  sectionDir += 1
  const dir = path.join(temp, `case-${sectionDir}`)
  fs.mkdirSync(dir, { recursive: true })
  process.env.OFM_CREDIT_WATCH_DIR = dir
  return dir
}

/** 直接写基准文件，模拟"上一轮采样"的各种状态。 */
function seedLast(dir, totals, extra = {}) {
  const date = extra.date ?? new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
  const at = extra.at ?? Date.now()
  fs.writeFileSync(path.join(dir, 'last.json'),
    JSON.stringify({ at, date, totals }, null, 2), 'utf8')
}

async function main() {
  const mod = await import(new URL('./index.js', import.meta.url).href)
  const t = mod.__test

  // ── 1. 正常下降记入当日 ────────────────────────────────────────────────
  {
    const dir = freshDir()
    seedLast(dir, { qoder: 3000 })

    const out = t.commitReadings([{ provider: 'qoder', total: 2870 }])
    check('下降 130 记入当日', out.totals.qoder, 130)
    check('本次 delta 为 130', out.deltas.qoder, 130)

    const second = t.commitReadings([{ provider: 'qoder', total: 2870 }])
    check('余额不变不再累加', second.totals.qoder, 130)
    check('余额不变 delta 为 0', second.deltas.qoder, 0)
  }

  // ── 2. 余额回升不算负消耗 ──────────────────────────────────────────────
  {
    const dir = freshDir()
    seedLast(dir, { qoder: 1000 })
    const out = t.commitReadings([{ provider: 'qoder', total: 1800 }])
    check('领积分回升不计消耗', out.totals.qoder, undefined)
    check('回升 delta 为 0', out.deltas.qoder, 0)
    checkTrue('回升后基准被更新', (() => {
      const last = JSON.parse(fs.readFileSync(path.join(dir, 'last.json'), 'utf8'))
      return last.totals.qoder === 1800
    })())
  }

  // ── 3. 查询失败不动基准 ────────────────────────────────────────────────
  {
    const dir = freshDir()
    seedLast(dir, { trae: 5000 })
    const out = t.commitReadings([{ provider: 'trae', total: null }])
    check('失败不计消耗', out.totals.trae, undefined)
    checkTrue('失败不覆盖基准', (() => {
      const last = JSON.parse(fs.readFileSync(path.join(dir, 'last.json'), 'utf8'))
      return last.totals.trae === 5000
    })())
  }

  // ── 4. 跨天不把昨天的账记到今天 ────────────────────────────────────────
  {
    const dir = freshDir()
    // 基准来自昨天：23:59 采到 1000，00:01 采到 900，这 100 属于昨天。
    seedLast(dir, { cline: 1000 }, { date: '2000-01-01' })
    const out = t.commitReadings([{ provider: 'cline', total: 900 }])
    check('跨天差值不计入今天', out.totals.cline, undefined)
    check('跨天 delta 为 0', out.deltas.cline, 0)
    checkTrue('跨天后基准日期更新', (() => {
      const last = JSON.parse(fs.readFileSync(path.join(dir, 'last.json'), 'utf8'))
      return last.date === t.todayKey()
    })())
  }

  // ── 5. 基准过旧同样不记账 ──────────────────────────────────────────────
  {
    const dir = freshDir()
    // 三小时前采样：中间可能关了一晚上 DSH，差值归属不明。
    seedLast(dir, { minimax: 2000 }, { at: Date.now() - 3 * 60 * 60 * 1000 })
    const out = t.commitReadings([{ provider: 'minimax', total: 1500 }])
    check('过旧基准不计入', out.totals.minimax, undefined)
    checkTrue('过旧基准被刷新', (() => {
      const last = JSON.parse(fs.readFileSync(path.join(dir, 'last.json'), 'utf8'))
      return last.totals.minimax === 1500 && Date.now() - last.at < 60_000
    })())
  }

  // ── 6. 幂等：两个窗口报同一轮读数只记一次 ──────────────────────────────
  {
    const dir = freshDir()
    seedLast(dir, { zcode: 8000 })
    const first = t.commitReadings([{ provider: 'zcode', total: 7000 }])
    const second = t.commitReadings([{ provider: 'zcode', total: 7000 }])
    check('第一个窗口记 1000', first.totals.zcode, 1000)
    check('第二个窗口不再重复记', second.totals.zcode, 1000)
    check('第二个窗口 delta 为 0', second.deltas.zcode, 0)
  }

  // ── 7. 当日累计跨轮累加 ────────────────────────────────────────────────
  {
    const dir = freshDir()
    seedLast(dir, { loomy: 500 })
    t.commitReadings([{ provider: 'loomy', total: 400 }])
    const out = t.commitReadings([{ provider: 'loomy', total: 350 }])
    check('两轮累加 100+50', out.totals.loomy, 150)
  }

  // ── 8. 读账本快照 ──────────────────────────────────────────────────────
  {
    const dir = freshDir()
    seedLast(dir, { qoder: 100 })
    t.commitReadings([{ provider: 'qoder', total: 60 }])
    const snapshot = t.readLedger()
    check('快照带当日日期', snapshot.date, t.todayKey())
    check('快照带当日累计', snapshot.totals.qoder, 40)
    checkTrue('快照带基准时间', typeof snapshot.at === 'string' && snapshot.at.length > 0)
  }

  // ── 9. 脏数据不炸 ──────────────────────────────────────────────────────
  {
    const dir = freshDir()
    fs.writeFileSync(path.join(dir, 'last.json'), '{ 这不是 JSON', 'utf8')
    const out = t.commitReadings([{ provider: 'qoder', total: 100 }])
    check('坏基准文件当没有基准', out.deltas.qoder, 0)
    checkTrue('坏基准被正常覆盖', (() => {
      const last = JSON.parse(fs.readFileSync(path.join(dir, 'last.json'), 'utf8'))
      return last.totals.qoder === 100
    })())

    const dir2 = freshDir()
    const dailyDate = t.todayKey()
    fs.writeFileSync(path.join(dir2, `daily-${dailyDate}.json`), 'null', 'utf8')
    const out2 = t.commitReadings([{ provider: 'trae', total: 100 }])
    checkTrue('坏当日账本不抛错', out2 && typeof out2.totals === 'object')
  }

  // ── 10. 未知形状的读数被忽略 ───────────────────────────────────────────
  {
    const dir = freshDir()
    seedLast(dir, { qoder: 100 })
    const out = t.commitReadings([
      null,
      { provider: 42, total: 5 },
      { provider: 'qoder', total: 80 },
    ])
    check('坏条目被跳过、好条目照算', out.totals.qoder, 20)
  }

  // ── 11. WB 累计：首轮无基准不记，第二轮下降累计与当日都记 ─────────────
  {
    const dir = freshDir()
    const first = t.commitWorkBuddy([{ key: t.wbKey('cn', 'a1'), total: 1000 }])
    check('WB 首轮不记账', first.deltas[t.wbKey('cn', 'a1')], 0)
    check('WB 首轮累计为空', first.cumulative[t.wbKey('cn', 'a1')], undefined)

    const second = t.commitWorkBuddy([{ key: t.wbKey('cn', 'a1'), total: 940 }])
    check('WB 第二轮累计 60', second.cumulative[t.wbKey('cn', 'a1')], 60)
    check('WB 第二轮当日 60', second.daily[t.wbKey('cn', 'a1')], 60)

    const third = t.commitWorkBuddy([{ key: t.wbKey('cn', 'a1'), total: 900 }])
    check('WB 累计继续叠加', third.cumulative[t.wbKey('cn', 'a1')], 100)
    check('WB 当日继续叠加', third.daily[t.wbKey('cn', 'a1')], 100)

    // 两个区域同名 id 不串账。
    const other = t.commitWorkBuddy([{ key: t.wbKey('global', 'a1'), total: 500 }])
    check('WB 区域前缀隔离', other.cumulative[t.wbKey('global', 'a1')], undefined)
    check('WB 国内版不受影响', other.cumulative[t.wbKey('cn', 'a1')], 100)
    checkTrue('WB 键带区域', t.wbKey('cn', 'x') !== t.wbKey('global', 'x'))
    void dir
  }

  // ── 12. WB 基准过旧：累计照记，当日不记 ────────────────────────────────
  {
    const dir = freshDir()
    const key = t.wbKey('cn', 'b1')
    fs.writeFileSync(path.join(dir, 'wb-last.json'),
      JSON.stringify({ at: Date.now() - 3 * 60 * 60 * 1000, date: t.todayKey(), totals: { [key]: 2000 } }), 'utf8')
    const out = t.commitWorkBuddy([{ key, total: 1500 }])
    check('WB 过旧仍累计', out.cumulative[key], 500)
    check('WB 过旧不计当日', out.daily[key], undefined)
  }

  // ── 13. WB 跨天：累计照记，当日不记 ────────────────────────────────────
  {
    const dir = freshDir()
    const key = t.wbKey('cn', 'c1')
    fs.writeFileSync(path.join(dir, 'wb-last.json'),
      JSON.stringify({ at: Date.now(), date: '2000-01-01', totals: { [key]: 800 } }), 'utf8')
    const out = t.commitWorkBuddy([{ key, total: 700 }])
    check('WB 跨天仍累计', out.cumulative[key], 100)
    check('WB 跨天不计当日', out.daily[key], undefined)
  }

  // ── 14. WB 余额上升与失败都不记 ────────────────────────────────────────
  {
    const dir = freshDir()
    const key = t.wbKey('cn', 'd1')
    fs.writeFileSync(path.join(dir, 'wb-last.json'),
      JSON.stringify({ at: Date.now(), date: t.todayKey(), totals: { [key]: 100 } }), 'utf8')
    const up = t.commitWorkBuddy([{ key, total: 400 }])
    check('WB 签到回升不记消耗', up.deltas[key], 0)
    check('WB 回升不改累计', up.cumulative[key], undefined)

    const fail = t.commitWorkBuddy([{ key, total: null }])
    check('WB 失败不记消耗', fail.deltas[key], 0)
    checkTrue('WB 失败基准保留 400', (() => {
      const last = JSON.parse(fs.readFileSync(path.join(dir, 'wb-last.json'), 'utf8'))
      return last.totals[key] === 400
    })())
  }

  // ── 15. WB 读账本快照 ──────────────────────────────────────────────────
  {
    const dir = freshDir()
    const key = t.wbKey('cn', 'e1')
    fs.writeFileSync(path.join(dir, 'wb-last.json'),
      JSON.stringify({ at: Date.now(), date: t.todayKey(), totals: { [key]: 900 } }), 'utf8')
    t.commitWorkBuddy([{ key, total: 600 }])
    const snapshot = t.readWorkBuddyLedger()
    check('WB 快照带今日', snapshot.daily[key], 300)
    check('WB 快照带累计', snapshot.cumulative[key], 300)
    checkTrue('WB 快照带时间', typeof snapshot.at === 'string')
  }

  // ── 16. 写盘节流：读数与基准一致时不重写文件 ───────────────────────────
  {
    const dir = freshDir()
    seedLast(dir, { qoder: 500 })
    const before = JSON.parse(fs.readFileSync(path.join(dir, 'last.json'), 'utf8')).at
    t.commitReadings([{ provider: 'qoder', total: 500 }])
    const after = JSON.parse(fs.readFileSync(path.join(dir, 'last.json'), 'utf8')).at
    check('读数未变时不重写基准', after, before)
    checkTrue('读数未变时不生成当日文件', !fs.readdirSync(dir).some(name => name.startsWith('daily-')))

    // 读数一变就必须落盘。
    t.commitReadings([{ provider: 'qoder', total: 480 }])
    check('读数变化后落盘', JSON.parse(fs.readFileSync(path.join(dir, 'last.json'), 'utf8')).totals.qoder, 480)
  }

  // ── 17. 用量汇总 ──────────────────────────────────────────────────────
  {
    const dir = freshDir()
    const ledger = path.join(dir, 'ledger.json')
    fs.writeFileSync(ledger, JSON.stringify({
      version: 1,
      days: {
        '2026-11-10': { date: '2026-11-10', byProviderModel: {
          'qoder:some-model': { input: 100, output: 50, cacheRead: 1000, calls: 2 },
          'trae:another:model': { input: 10, output: 5, cacheRead: 100, calls: 1 },
          'workbuddy:deepseek-v4': { input: 7, output: 3, cacheRead: 70, calls: 4 },
          'openai-codex:gpt-6.1': { input: 999, output: 999, cacheRead: 999, calls: 9 },
        } },
        '2026-11-11': { date: '2026-11-11', byProviderModel: {
          'workbuddy-global:kimi': { input: 1, output: 1, cacheRead: 1, calls: 1 },
        } },
      },
    }), 'utf8')
    process.env.OFM_COST_METER_LEDGER = ledger
    // 缓存按 mtime+size 命中，换文件后必须显式清掉。
    t.usageCache.key = ''

    const stats = t.readUsageStats()
    check('用量账本可读', stats.available, true)
    check('按日期升序', stats.days.map(d => d.date), ['2026-11-10', '2026-11-11'])

    const first = stats.days[0]
    // OFM 只算自己的渠道；openai-codex 不在名单里，必须排除。
    check('OFM 输入只算自己的渠道', first.ofm.input, 110)
    check('OFM 输出', first.ofm.output, 55)
    check('OFM 缓存读', first.ofm.cacheRead, 1100)
    check('OFM 调用数', first.ofm.calls, 3)
    check('WorkBuddy 合并两个区域', stats.days[0].workbuddy.input + stats.days[1].workbuddy.input, 8)
    check('WorkBuddy 单日调用', first.workbuddy.calls, 4)
    check('渠道明细按 provider 归并', first.byChannel.qoder.input, 100)
    check('模型名带冒号也切对', first.byChannel.trae.input, 10)
    check('未出现的渠道不在明细里', first.byChannel.raccoon, undefined)

    // 账本不存在：available 为 false，days 为空。
    process.env.OFM_COST_METER_LEDGER = path.join(dir, 'nope.json')
    t.usageCache.key = ''
    const missing = t.readUsageStats()
    check('账本缺失时 available 为 false', missing.available, false)
    check('账本缺失时没有天数', missing.days, [])

    // 缓存：同一份文件第二次读应当复用（mtime+size 不变）。
    process.env.OFM_COST_METER_LEDGER = ledger
    t.usageCache.key = ''
    const a = t.readUsageStats()
    const b = t.readUsageStats()
    check('缓存命中返回同一对象', a === b, true)
    delete process.env.OFM_CREDIT_WATCH_DIR === undefined ? 'x' : 'x'
    delete process.env.OFM_COST_METER_LEDGER
  }

  if (failures.length > 0) {
    console.error(`✗ ${failures.length}/${checks} 项失败`)
    for (const line of failures) console.error('  - ' + line)
    process.exitCode = 1
  } else {
    console.log(`✓ ${checks} 项账本检查全部通过`)
  }
  fs.rmSync(temp, { recursive: true, force: true })
}

main().catch(error => {
  console.error('自测异常：', error)
  fs.rmSync(temp, { recursive: true, force: true })
  process.exit(1)
})
