const fs = require('fs');
const path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 低频抓取：海尔 + 一批用户最可能持有的知名股票（避开连续大量请求触发的限流）
const codes = [
  ['600690', '海尔智家'], ['600036', '招商银行'], ['000333', '美的集团'], ['000651', '格力电器'],
  ['600887', '伊利股份'], ['000858', '五粮液'], ['600519', '贵州茅台'], ['601318', '中国平安'],
  ['002594', '比亚迪'], ['300750', '宁德时代'], ['000725', '京东方A'], ['002475', '立讯精密'],
  ['002415', '海康威视'], ['601012', '隆基绿能'], ['600900', '长江电力'], ['601888', '中国中免'],
  ['603259', '药明康德'], ['600309', '万华化学'], ['600031', '三一重工'], ['002304', '洋河股份'],
  ['000568', '泸州老窖']
];
const API = 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_SHAREBONUS_DET&columns=ALL&filter=(SECURITY_CODE="CODE")&pageSize=10&pageNumber=1&sortColumns=REPORT_DATE&sortTypes=-1&source=WEB&client=WEB';

async function fetchOne(code) {
  try {
    await sleep(4000); // 低频，避免触发限流
    const r = await fetch(API.replace('CODE', code), { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const j = await r.json();
    const d = (j.result && j.result.data) || [];
    const recs = d.filter(x => x.EX_DIVIDEND_DATE).map(x => ({
      year: String(x.EX_DIVIDEND_DATE).slice(0, 4),
      recordDate: x.EQUITY_RECORD_DATE ? String(x.EQUITY_RECORD_DATE).slice(0, 10) : null,
      exDate: String(x.EX_DIVIDEND_DATE).slice(0, 10),
      planText: x.IMPL_PLAN_PROFILE || '',
      ps: x.PRETAX_BONUS_RMB != null ? x.PRETAX_BONUS_RMB / 10 : null
    }));
    if (recs.length === 0) await sleep(8000); // 空响应可能是限流，退避后继续
    return recs;
  } catch (e) {
    await sleep(8000);
    return [];
  }
}

(async () => {
  const out = { updatedAt: new Date().toISOString().slice(0, 10), source: 'eastmoney RPT_SHAREBONUS_DET (snapshot)', stocks: {} };
  for (let i = 0; i < codes.length; i++) {
    const [c, nm] = codes[i];
    const recs = await fetchOne(c);
    out.stocks[c] = { name: nm, records: recs };
    console.log(c, nm, 'recs', recs.length);
  }
  fs.writeFileSync(path.join(__dirname, 'stock_dividends.json'), JSON.stringify(out, null, 2));
  const t = Object.values(out.stocks).reduce((a, b) => a + b.records.length, 0);
  console.log('done stocks', Object.keys(out.stocks).length, 'records', t);
})();
