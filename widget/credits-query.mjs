/**
 * OFM(EAC router 渠道)积分查询 —— 独立于 DSH 插件的实时查询脚本
 *
 * 数据来源与 dsh-our-free-model 插件的 channel-pack `credits.balances` 完全同源：
 *   凭据: ~/.dsh/.credentials.yaml（明文 JSON）
 *   账号: ~/.dsh/channel-pack/state.json
 * 各渠道余额端点从插件 vendor/channel-pack/pack.js 移植。
 *
 * 用法:
 *   node credits-query.mjs                # 打印 JSON 到 stdout
 *   node credits-query.mjs --out <file>   # 同时写文件（悬浮窗用）
 * 输出: { at, rows: [{provider,label,account,unit,total,packages?,error?}] }
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';

const DSH = process.env.DSH_HOME || path.join(homedir(), '.dsh');
const CRED_YAML = path.join(DSH, '.credentials.yaml');
const STATE_JSON = path.join(DSH, 'channel-pack', 'state.json');
const TIMEOUT_MS = 15_000;

// ── 按天消耗持久化 ────────────────────────────────────────────────────────────
const DAILY_DIR = path.join(DSH, 'ofm-widget');
function dailyFileFor(dateStr) {
  return path.join(DAILY_DIR, `daily-${dateStr}.json`);
}
function shanghaiDate() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
}
function loadDailyTotals() {
  const dateStr = shanghaiDate();
  const file = dailyFileFor(dateStr);
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (data && data.date === dateStr && data.totals) return data;
  } catch { /* 文件不存在或损坏，重新开始 */ }
  return { date: dateStr, totals: {} };
}
function saveDailyTotals(data) {
  try {
    writeFileSync(dailyFileFor(data.date), JSON.stringify(data, null, 2), 'utf8');
  } catch { /* 尽力写入，失败不影响查询 */ }
}

// ── 过期时间尽力解析 ─────────────────────────────────────────────────────────
const EXPIRY_KEYS = ['expireAt', 'expiredAt', 'expire_at', 'expired_at', 'validUntil', 'valid_until', 'expirationDate', 'expiryDate', 'expireTime', 'expire_time', 'expiredTime', 'expired_time'];
function guessExpiry(obj) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of EXPIRY_KEYS) {
    if (k in obj && obj[k] != null) {
      const v = obj[k];
      if (typeof v === 'string') return v;
      if (typeof v === 'number') return new Date(v).toISOString().slice(0, 10);
    }
  }
  return null;
}

// ── 凭据与账号 ────────────────────────────────────────────────────────────────
function loadCredentials() {
  const text = readFileSync(CRED_YAML, 'utf8');
  const out = {};
  const re = /^  ([A-Z0-9_]+_ACCOUNT_[0-9A-F]+): '(.*)'$/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    try { out[m[1]] = JSON.parse(m[2].replace(/''/g, "'")); } catch { /* 跳过坏行 */ }
  }
  return out;
}
function loadAccounts() {
  const state = JSON.parse(readFileSync(STATE_JSON, 'utf8'));
  return state.accounts ?? [];
}

// ── 通用 fetch ────────────────────────────────────────────────────────────────
async function getJSON(url, headers, init = {}) {
  const res = await fetch(url, {
    headers, ...init, signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  if (!res.ok && json === null) throw new Error(`HTTP ${res.status}: ${text.slice(0, 80).replace(/\s+/g, ' ')}`);
  return { status: res.status, json, text };
}
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
const round2 = v => Math.round(v * 100) / 100;

// ── 各渠道查询（与 pack.js 同源） ─────────────────────────────────────────────

// Qoder / Qoder CN: GET {openApiBase}/sash/api/v2/me/usage
async function queryQoder(cred, isCn) {
  const base = isCn ? 'https://openapi.qoder.com.cn' : 'https://openapi.qoder.sh';
  const token = cred.security_oauth_token || cred.access_token || '';
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
    'Cosy-ClientType': '10',
    'User-Agent': 'Qoder',
  };
  // 机器身份头：插件从 machine_token.json 读，本机没有该文件时插件也会省略，行为一致。
  const machineFile = [
    path.join(process.env.APPDATA || '', 'Qoder' + (isCn ? ' CN' : ''), 'SharedClientCache', 'cache', 'machine_token.json'),
  ];
  for (const p of machineFile) {
    try {
      const j = JSON.parse(readFileSync(p, 'utf8'));
      if (j.token && j.type) { headers['Cosy-MachineToken'] = j.token; headers['Cosy-MachineType'] = j.type; break; }
    } catch { /* 无文件 */ }
  }
  const { json } = await getJSON(`${base}/sash/api/v2/me/usage`, headers);
  if (!json || typeof json !== 'object') throw new Error('响应异常');
  if (json.displayMode === 'enterprise') throw new Error('企业版无额度数字');
  const usage = json.qoderUsage;
  if (!usage) throw new Error('缺少 qoderUsage');
  const packages = [];
  let total = 0;
  const pack = (name, quota) => {
    if (!quota || typeof quota !== 'object') return;
    const t = num(quota.total), u = num(quota.used), r = num(quota.remaining);
    if (t === undefined && u === undefined && r === undefined) return;
    const remaining = r !== undefined ? Math.max(0, r) : Math.max(0, (t ?? 0) - (u ?? 0));
    packages.push({ name, remaining: round2(remaining), total: Math.max(0, t ?? 0), expireAt: guessExpiry(quota) });
    total += remaining;
  };
  pack('套餐额度', usage.userQuota);
  pack('资源包', usage.addOnQuota);
  for (const item of usage.dedicatedResourcePackages ?? []) {
    pack(item?.name ?? item?.id ?? '专用资源包', item);
  }
  if (packages.length === 0) throw new Error('无额度数据');
  return { total: round2(total), unit: 'credits', packages };
}

// TRAE: POST https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage
function seededStream(seed, salt, nbytes) {
  const prefix = `${salt}:${seed}`;
  const result = [];
  let counter = 0;
  while (result.length < nbytes) {
    const cb = new Uint8Array(4);
    cb[0] = counter >> 24 & 255; cb[1] = counter >> 16 & 255; cb[2] = counter >> 8 & 255; cb[3] = counter & 255;
    const h = createHash('sha256');
    h.update(prefix, 'utf8'); h.update(cb);
    for (const b of h.digest()) { result.push(b); if (result.length >= nbytes) break; }
    counter++;
  }
  return result.slice(0, nbytes);
}
const hex = bs => bs.map(b => b.toString(16).padStart(2, '0')).join('');
async function queryTrae(cred) {
  const uid = cred.uid ?? '';
  if (!uid) throw new Error('凭据缺少 uid');
  const devid = seededStream(uid, 'devid', 15).map(b => (b % 10).toString()).join('');
  const bs = seededStream(uid, 'market', 16);
  bs[6] = bs[6] & 15 | 64; bs[8] = bs[8] & 63 | 128;
  const h = hex(bs);
  const marketUserId = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
  const sessionId = hex(seededStream(uid, 'sess', 32));
  const { json } = await getJSON('https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage', {
    'Content-Type': 'application/json', Accept: '*/*', 'Accept-Language': 'zh-CN',
    'User-Agent': 'VSCode 1.107.1 (TRAE SOLO CN)',
    Authorization: `Cloud-IDE-JWT ${cred.access_token}`,
    'X-Market-Client-Id': 'VSCode 1.107.1', 'X-Market-User-Id': marketUserId,
    'X-User-Region': 'CN', 'X-Device-Id': devid, 'X-Lgw-Req-Sdk-Type': '3',
    'Package-Type': 'stable_cn', 'X-Lscbd-Aid': '787976', 'X-Lscbd-Platform': 'windows',
    'App-Version': '0.1.52', 'Vscode-Sessionid': sessionId,
  }, { method: 'POST', body: JSON.stringify({ require_usage: true, req_source: 2 }) });
  const packList = json?.user_entitlement_pack_list;
  if (!Array.isArray(packList) || packList.length === 0) throw new Error('无资源包数据');
  let total = 0; const packages = [];
  for (const item of packList) {
    const quota = item?.entitlement_base_info?.quota;
    const limit = num(quota?.credits_limit);
    if (limit === undefined || limit <= 0) continue;
    const used = num(item?.usage?.credits_amount) ?? 0;
    const remaining = limit - used;
    packages.push({ name: item?.entitlement_base_info?.display_desc ?? item?.display_desc ?? '资源包', remaining: round2(remaining), total: limit, expireAt: guessExpiry(item?.entitlement_base_info?.quota ?? item) });
    total += remaining;
  }
  if (packages.length === 0) throw new Error('无有效额度包');
  return { total: round2(total), unit: 'credits', packages };
}

// Cline: GET https://api.cline.bot/api/v1/users/{id}/balance （USD，/1e5）
async function queryCline(cred) {
  const token = String(cred.access_token ?? '').trim();
  const bearer = token.startsWith('workos:') ? token : `workos:${token}`;
  const { json } = await getJSON(`https://api.cline.bot/api/v1/users/${encodeURIComponent(cred.account_id)}/balance`, {
    Authorization: `Bearer ${bearer}`, Accept: 'application/json',
    'HTTP-Referer': 'https://cline.bot', 'X-Title': 'Cline', 'X-IS-MULTIROOT': 'false', 'X-CLIENT-TYPE': 'cline-sdk',
  });
  if (json?.success === false || (typeof json?.error === 'string' && json.error)) throw new Error(json?.error ?? '服务端返回失败');
  const raw = num(json?.data?.balance);
  if (raw === undefined) throw new Error('响应缺少 balance 字段');
  const total = round2(raw / 1e5);
  return { total, unit: 'USD', packages: [{ name: 'Cline 账户余额', remaining: total, total, expireAt: guessExpiry(json?.data ?? json) }] };
}

// Loomy: GET https://loomyad.xunfei.cn/api/v1/points/records?pageSize=1
async function queryLoomy(cred) {
  const { json } = await getJSON('https://loomyad.xunfei.cn/api/v1/points/records?pageNo=1&pageSize=1&recordType=all', {
    Accept: 'application/json', token: cred.access_token,
  });
  if (json?.code !== '000000') throw new Error(json?.desc ?? json?.message ?? `业务错误 ${json?.code ?? '?'}`);
  const d = json.data ?? {};
  const permanent = num(d.balance), daily = num(d.dailyBalance), available = num(d.availableBalance);
  if (permanent === undefined) throw new Error('响应缺少 balance 字段');
  const total = available ?? permanent + (daily ?? 0);
  const packages = [{ name: '永久积分', remaining: permanent, total: permanent, expireAt: guessExpiry(d) }];
  if (daily !== undefined) packages.push({ name: '每日赠送', remaining: daily, total: daily, expireAt: guessExpiry(d) });
  return { total: round2(total), unit: 'credits', packages };
}

// Raccoon: GET https://xiaohuanxiong.com/api/web/points/v1/balance
async function queryRaccoon(cred) {
  const { json } = await getJSON('https://xiaohuanxiong.com/api/web/points/v1/balance', {
    Accept: 'application/json', 'Content-Type': 'application/json',
    Authorization: `Bearer ${cred.access_token}`,
    'X-Org-Code': cred.office_identity ?? '', 'X-Raccoon-Language': 'zh',
    'X-Client-Platform': 'desktop-windows', 'X-Client-Version': 'v1.0.35',
    'User-Agent': 'Raccoon Work/1.0.35 (Windows)',
    ...(cred.device_id ? { 'X-Client-Device-ID': cred.device_id } : {}),
  });
  const code = typeof json?.code === 'number' ? json.code : 0;
  if (code !== 0) throw new Error(json?.message ?? json?.details ?? `业务错误 ${code}`);
  const available = num(json?.data?.available_points);
  if (available === undefined) throw new Error('响应缺少 available_points');
  const d = json.data;
  const packages = [];
  const push = (name, v) => { const n = num(v); if (n !== undefined && (name !== '会员积分' || n > 0)) packages.push({ name, remaining: n, total: n, expireAt: guessExpiry(d) }); };
  push('奖励积分', d.reward_points); push('每日积分', d.daily_points);
  push('会员积分', d.monthly_points); push('充值积分', d.topup_points);
  if (packages.length === 0) packages.push({ name: '可用积分', remaining: available, total: available, expireAt: guessExpiry(d) });
  return { total: available, unit: 'credits', packages };
}

// MiniMax: GET https://agent.minimax.cn/minimax-cloud/api/v1/credit/details
async function queryMinimax(cred) {
  const { json } = await getJSON('https://agent.minimax.cn/minimax-cloud/api/v1/credit/details', {
    Authorization: `Bearer ${cred.access_token}`, Accept: 'application/json',
  });
  const sc = num(json?.base_resp?.status_code);
  if (sc !== undefined && sc !== 0) throw new Error(json?.base_resp?.status_msg ?? `业务错误 ${sc}`);
  const data = (json?.data && typeof json.data === 'object') ? json.data : json;
  const details = Array.isArray(data?.details) ? data.details : [];
  let total = 0; const packages = [];
  for (const e of details) {
    const r = num(e?.remaining_amount);
    if (r !== undefined) { total += r; packages.push({ name: e?.name ?? e?.type ?? '积分包', remaining: r, total: num(e?.total_amount) ?? r, expireAt: guessExpiry(e) }); }
  }
  const totalCount = num(data?.total_count);
  if (details.length === 0 && totalCount === undefined) throw new Error('无额度数据');
  if (details.length === 0) total = totalCount ?? 0;
  return { total: round2(total), unit: 'credits', packages };
}

// ZCode: GET https://zcode.z.ai/api/v1/zcode-plan/billing/balance （token 额度桶）
async function queryZcode(cred) {
  const appVersion = cred.app_version ?? '3.14.3';
  const { json } = await getJSON('https://zcode.z.ai/api/v1/zcode-plan/billing/balance', {
    'User-Agent': `ZCode/${appVersion}`, 'HTTP-Referer': 'https://zcode.z.ai',
    'X-ZCode-App-Version': appVersion, 'X-Release-Channel': 'stable',
    'X-Client-Language': 'zh-CN', 'X-Client-Timezone': 'Asia/Shanghai',
    'X-Device-Mid': cred.device_mid ?? '', 'X-Platform': 'win32', 'X-Os-Category': 'windows',
    'anthropic-version': '2023-06-01', 'Content-Type': 'application/json',
    Authorization: `Bearer ${cred.zcode_jwt}`,
  });
  const data = json?.data;
  if (!data) throw new Error(`响应缺少 data（HTTP ${json?.code ?? '?'}）`);
  if (data.displayMode === 'enterprise') throw new Error('企业版账号不下发额度数字');
  const buckets = Array.isArray(data.balances) ? data.balances : [];
  let remaining = 0, total = 0; const packages = [];
  for (const b of buckets) {
    const r = num(b?.available_units) ?? num(b?.remaining_units) ?? 0;
    remaining += r; total += num(b?.total_units) ?? 0;
    packages.push({ name: b?.show_name ?? b?.plan_id ?? '额度桶', remaining: r, total: num(b?.total_units) ?? 0, unit: b?.unit_type ?? 'token', expireAt: guessExpiry(b) });
  }
  return { total: round2(remaining), unit: 'tokens', packages };
}

// LobsterAI: GET https://lobsterai-server.youdao.com/api/user/profile-summary
async function queryLobsterai(cred) {
  const { json } = await getJSON('https://lobsterai-server.youdao.com/api/user/profile-summary', {
    Authorization: `Bearer ${cred.access_token}`, Accept: 'application/json',
    'Content-Type': 'application/json', 'User-Agent': 'LobsterAI/0.1.0',
  });
  const data = json?.data ?? json;
  const total = num(data?.totalCreditsRemaining);
  if (total === undefined) throw new Error('无额度数据');
  return { total: round2(Math.max(0, total)), unit: 'credits', packages: [] };
}

// ── 汇总 ──────────────────────────────────────────────────────────────────────
const QUERIES = {
  qoder: { label: 'Qoder', fn: c => queryQoder(c, false) },
  qodercn: { label: 'Qoder 中国版', fn: c => queryQoder(c, true) },
  trae: { label: 'TRAE', fn: queryTrae },
  cline: { label: 'Cline', fn: queryCline },
  loomy: { label: 'Loomy', fn: queryLoomy },
  raccoon: { label: 'Raccoon', fn: queryRaccoon },
  minimax: { label: 'MiniMax Code', fn: queryMinimax },
  zcode: { label: 'ZCode', fn: queryZcode },
  lobsterai: { label: 'LobsterAI', fn: queryLobsterai },
};

async function main() {
  const outIdx = process.argv.indexOf('--out');
  const outFile = outIdx >= 0 ? process.argv[outIdx + 1] : null;
  const creds = loadCredentials();
  const accounts = loadAccounts();
  const rows = [];
  const jobs = [];

  // 按天累计：加载当天已累计的消耗与上次余额
  const daily = loadDailyTotals();
  const lastTotals = daily.lastTotals || {};

  for (const acc of accounts) {
    const q = QUERIES[acc.provider];
    if (!q) continue; // workbuddy/buddy/codearts 无余额端点
    if (acc.enabled === false) continue;
    const credRef = acc.credentialRef ?? '';
    const cred = creds[credRef];
    jobs.push((async () => {
      const row = { provider: acc.provider, label: q.label, account: acc.nickname ?? acc.id };
      if (!cred) { row.error = '凭据未配置'; rows.push(row); return; }
      try { Object.assign(row, await q.fn(cred)); }
      catch (e) { row.error = String(e?.message ?? e).slice(0, 120); }
      rows.push(row);
    })());
  }
  await Promise.all(jobs);

  // 累计当天消耗并附 back todayConsumed
  const newLastTotals = {};
  for (const row of rows) {
    newLastTotals[row.provider] = row.total == null ? lastTotals[row.provider] : row.total;
    if (row.total != null) {
      const prev = lastTotals[row.provider];
      const delta = typeof prev === 'number' ? Math.max(0, prev - row.total) : 0;
      daily.totals[row.provider] = Math.round(((daily.totals[row.provider] || 0) + delta) * 100) / 100;
      row.todayConsumed = daily.totals[row.provider];
    } else {
      row.todayConsumed = daily.totals[row.provider] || 0;
    }
  }
  daily.lastTotals = newLastTotals;
  saveDailyTotals(daily);

  rows.sort((a, b) => a.provider.localeCompare(b.provider));
  const result = { at: new Date().toISOString(), rows };
  const text = JSON.stringify(result, null, 1);
  if (outFile) writeFileSync(outFile, text, 'utf8');
  console.log(text);
}
await main();
