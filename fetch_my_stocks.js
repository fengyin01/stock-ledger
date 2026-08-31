const fs = require('fs');
const { execSync } = require('child_process');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
// CI 模式下 GitHub runner IP 不受东方财富限流，缩短间隔加速
const FAST = process.env.GH_ACTIONS === '1';
const baseDelay = () => FAST ? 1500 + Math.random() * 1500 : 5000 + Math.random() * 4000;

// 从 index.html 提取全部预置股票
const html = fs.readFileSync('index.html', 'utf8');
const re = /\["(\d{6})","([^"]+)","([^"]+)"\]/g;
const seen = new Set();
const targets = [];
let m;
while ((m = re.exec(html))) {
  if (!seen.has(m[1])) { seen.add(m[1]); targets.push({ code: m[1], name: m[2] }); }
}

// 读取现有快照（保留已有真实数据）
let out = { updatedAt: new Date().toISOString().slice(0, 10), source: 'eastmoney RPT_SHAREBONUS_DET (snapshot)', stocks: {} };
try {
  const old = JSON.parse(fs.readFileSync('stock_dividends.json', 'utf8'));
  Object.assign(out.stocks, old.stocks || {});
} catch (e) { /* ignore */ }

// CI 模式全量重抓（含已有数据，捕捉新公告）；本地模式只补缺失
const todo = FAST ? targets.slice() : targets.filter(t => !(out.stocks[t.code] && out.stocks[t.code].records && out.stocks[t.code].records.length));
console.log(`预置 ${targets.length} 只 | ${FAST ? 'CI 全量重抓' : '本地补缺失(已有 ' + (targets.length - todo.length) + ')'} | 待抓 ${todo.length} 只`);

function normalize(rec) {
  const dateOnly = v => (v ? String(v).slice(0, 10) : null);
  return {
    ps: rec.PRETAX_BONUS_RMB != null && !isNaN(rec.PRETAX_BONUS_RMB) ? rec.PRETAX_BONUS_RMB / 10 : null,
    planText: rec.IMPL_PLAN_PROFILE || '',
    planDate: dateOnly(rec.PLAN_NOTICE_DATE),
    recordDate: dateOnly(rec.EQUITY_RECORD_DATE),
    exDate: dateOnly(rec.EX_DIVIDEND_DATE),
    progress: rec.ASSIGN_PROGRESS || '',
    reportDate: dateOnly(rec.REPORT_DATE),
    divYield: rec.DIVIDENT_RATIO != null && !isNaN(rec.DIVIDENT_RATIO) ? rec.DIVIDENT_RATIO * 100 : null
  };
}

function fetchCurl(code) {
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_SHAREBONUS_DET&columns=ALL&filter=(SECURITY_CODE="${code}")&pageSize=30&pageNumber=1&sortColumns=REPORT_DATE&sortTypes=-1&source=WEB&client=WEB`;
  const out = execSync(`curl -s --max-time 30 -H "User-Agent: ${UA}" "${url}"`, { encoding: 'utf8', timeout: 35000 });
  const j = JSON.parse(out);
  const data = (j && j.result && j.result.data) || [];
  return data.filter(rec => rec.EX_DIVIDEND_DATE).map(normalize);
}

async function fetchOne(s, attempt = 1) {
  const delay = baseDelay() + (attempt - 1) * 6000; // 退避
  await sleep(delay);
  try {
    return fetchCurl(s.code);
  } catch (e) {
    if (attempt < 4) { console.log(`  retry ${attempt}: ${e.message}`); return fetchOne(s, attempt + 1); }
    console.log(`  FAIL: ${e.message}`);
    return [];
  }
}

(async () => {
  const BATCH = 20;
  for (let i = 0; i < todo.length; i++) {
    const s = todo[i];
    process.stdout.write(`[${i + 1}/${todo.length}] ${s.code} ${s.name} ... `);
    const recs = await fetchOne(s);
    out.stocks[s.code] = { name: (out.stocks[s.code] && out.stocks[s.code].name) || s.name, records: recs };
    console.log(recs.length + ' records');
    if ((i + 1) % BATCH === 0) { console.log(`--- 批次冷却 ${FAST ? 20 : 60}s (${i + 1}/${todo.length}) ---`); await sleep(FAST ? 20000 : 60000); }
  }
  out.updatedAt = new Date().toISOString().slice(0, 10);
  fs.writeFileSync('stock_dividends.json', JSON.stringify(out, null, 2));
  console.log('DONE. 总股票', Object.keys(out.stocks).length, '只');
})();
