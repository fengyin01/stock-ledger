// 基金（ETF/LOF）分红快照抓取：东方财富天天基金 F10 分红送配页
// 输出 fund_dividends.json，含权益登记日 / 除息日 / 每10份派现 / 分红发放日
// 用法：node fetch_fund_dividends.js
const fs = require("fs");
const path = require("path");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const OUT = path.join(__dirname, "fund_dividends.json");

// 持仓基金列表：优先从现有快照的 funds 键读取，保证新增基金时只需手工加一行
function loadCodes() {
  try {
    const old = JSON.parse(fs.readFileSync(OUT, "utf8"));
    const codes = Object.keys(old.funds || {});
    if (codes.length) return codes.map(c => ({ code: c, name: (old.funds[c] || {}).name || "" }));
  } catch (e) { /* 首次运行无快照 */ }
  return ["563020", "513530", "513630", "512890"].map(c => ({ code: c, name: "" }));
}

// 解析 fhsp_{code}.html 的「分红送配详情」表格
function parseFhsp(html) {
  const rows = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = trRe.exec(html))) {
    const tds = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)]
      .map(x => x[1].replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim());
    if (tds.length < 5) continue;
    if (!/^\d{4}年$/.test(tds[0])) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tds[1])) continue;
    const pm = /派现金([\d.]+)元/.exec(tds[3]);
    const per10 = pm ? parseFloat(pm[1]) : null;
    rows.push({
      year: tds[0].slice(0, 4),
      recordDate: tds[1],
      exDate: tds[2],
      per10: per10,
      payDate: /^\d{4}-\d{2}-\d{2}$/.test(tds[4]) ? tds[4] : null,
      perUnit: per10 != null ? +(per10 / 10).toFixed(6) : null
    });
  }
  return rows;
}

function parseFundName(html) {
  const m = /<title>([^(_]+)\((\d{6})\)/.exec(html);
  return m ? m[1].trim() : "";
}

async function fetchFund(code, attempt = 1) {
  const url = `https://fundf10.eastmoney.com/fhsp_${code}.html`;
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, "Referer": url } });
    const html = await r.text();
    return { name: parseFundName(html), records: parseFhsp(html) };
  } catch (e) {
    if (attempt < 3) {
      await new Promise(s => setTimeout(s, 2000 * attempt));
      return fetchFund(code, attempt + 1);
    }
    throw e;
  }
}

(async () => {
  const targets = loadCodes();
  const out = { updatedAt: new Date().toISOString().slice(0, 10), source: "eastmoney fundf10 fhsp", funds: {} };
  for (const t of targets) {
    try {
      const r = await fetchFund(t.code);
      out.funds[t.code] = { name: r.name || t.name, records: r.records };
      console.log(`${t.code} ${r.name || t.name} 分红记录 ${r.records.length} 条，最近 ${r.records[0] ? r.records[0].recordDate + " 登记 / " + r.records[0].exDate + " 除息" : "无"}`);
    } catch (e) {
      console.log(`${t.code} 抓取失败：${e.message}，保留旧数据`);
      try {
        const old = JSON.parse(fs.readFileSync(OUT, "utf8"));
        if (old.funds && old.funds[t.code]) out.funds[t.code] = old.funds[t.code];
      } catch (e2) { /* ignore */ }
    }
    await new Promise(s => setTimeout(s, 800));
  }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log(`已写入 ${OUT}`);
})();
