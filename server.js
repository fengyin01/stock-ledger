// 股票记账 · 多端实时同步后端（零依赖 Node.js）
// 同时托管前端静态文件与 /api/<room>/sync 同步接口。
// 运行： node server.js   （PORT 环境变量可改，默认 3000）
// 部署： 推到 Render / Railway / Fly.io 等任意 Node 平台即可获得公网地址。

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, ".sync-data");
const DATA_FILE = path.join(DATA_DIR, "rooms.json");

// ---------- 房间数据持久化 ----------
function loadRooms() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch (e) { return {}; }
}
let rooms = loadRooms();
let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify(rooms));
    } catch (e) { console.error("persist error:", e.message); }
  }, 300);
}

// ---------- LWW 合并（按 id，updatedAt 大者胜）----------
function mergeArr(a, b) {
  const m = new Map();
  (a || []).forEach(r => m.set(r.id, r));
  (b || []).forEach(r => {
    const cur = m.get(r.id);
    const rt = r.updatedAt || 0;
    const ct = cur ? (cur.updatedAt || 0) : -1;
    if (!cur || rt > ct) m.set(r.id, r);
  });
  return Array.from(m.values());
}
function mergeRoom(room, incoming) {
  const deleted = Array.from(new Set([...(room.deleted || []), ...(incoming.deleted || [])]));
  const stocks = mergeArr(room.stocks, incoming.stocks).filter(r => !deleted.includes(r.id));
  const trades = mergeArr(room.trades, incoming.trades).filter(r => !deleted.includes(r.id));
  return { stocks, trades, deleted };
}

// ---------- 工具 ----------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(body);
}

// ---------- 分红预测数据代理 ----------
// 上游 API（慢慢变富后端）存在 CORS 白名单，仅放行 www.manmanbianfu.top；
// 本服务端转发时伪造该 Origin，前端以同源 /api/div/stockPrice 访问即可。
const DIV_API = "https://vercel-dividend-d8faqegf03442b6c.service.tcloudbase.com/stockPrice";
function proxyDiv(req, res, url) {
  const target = DIV_API + (url.search || "");
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), 25000) : null;
  const doFetch = typeof fetch === "function"
    ? () => fetch(target, {
        headers: {
          "Origin": "https://www.manmanbianfu.top",
          "Referer": "https://www.manmanbianfu.top/",
          "User-Agent": req.headers["user-agent"] || "Mozilla/5.0",
          "Accept": req.headers["accept"] || "*/*"
        },
        signal: controller ? controller.signal : undefined
      })
    : null;
  if (!doFetch) { res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify({ error: "proxy unavailable" })); return; }
  doFetch()
    .then(async (up) => {
      if (timer) clearTimeout(timer);
      const buf = Buffer.from(await up.arrayBuffer());
      res.writeHead(up.status, {
        "Content-Type": up.headers.get("content-type") || "application/octet-stream",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store"
      });
      res.end(buf);
    })
    .catch(() => {
      if (timer) clearTimeout(timer);
      res.writeHead(502, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "upstream unavailable" }));
    });
}

// ---------- 分红预测点赞计数（自建持久化，种子与参考站当前值对齐）----------
const LIKE_FILE = path.join(DATA_DIR, "likes.json");
const LIKE_SEED = 17; // 2026-08-31 参考站当前点赞数
function loadLikes() {
  try {
    const o = JSON.parse(fs.readFileSync(LIKE_FILE, "utf8"));
    return typeof o.dividendForecastCount === "number" ? o.dividendForecastCount : LIKE_SEED;
  } catch { return LIKE_SEED; }
}
let divLikes = loadLikes();
function persistLikes() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(LIKE_FILE, JSON.stringify({ dividendForecastCount: divLikes, updatedAt: Date.now() }));
  } catch (e) { console.error("persistLikes error:", e.message); }
}

const server = http.createServer((req, res) => {
  // CORS 预检
  if (req.method === "OPTIONS") { sendJSON(res, 204, {}); return; }

  const url = new URL(req.url, "http://localhost");

  // 分红预测数据代理（GET）
  if (req.method === "GET" && url.pathname === "/api/div/stockPrice") {
    proxyDiv(req, res, url);
    return;
  }

  // 分红预测点赞计数
  if (url.pathname === "/api/div/like") {
    if (req.method === "GET") { sendJSON(res, 200, { dividendForecastCount: divLikes }); return; }
    if (req.method === "POST") {
      divLikes += 1;
      persistLikes();
      sendJSON(res, 200, { dividendForecastCount: divLikes });
      return;
    }
    sendJSON(res, 405, { error: "method not allowed" });
    return;
  }

  const m = url.pathname.match(/^\/api\/([^/]+)\/sync$/);
  if (m) {
    const roomId = decodeURIComponent(m[1]);
    if (!rooms[roomId]) rooms[roomId] = { updatedAt: 0, stocks: [], trades: [], deleted: [] };
    const room = rooms[roomId];

    if (req.method === "GET") {
      sendJSON(res, 200, { updatedAt: room.updatedAt, state: { stocks: room.stocks, trades: room.trades, deleted: room.deleted } });
      return;
    }
    if (req.method === "POST") {
      let body = "";
      req.on("data", d => body += d);
      req.on("end", () => {
        try {
          const data = JSON.parse(body || "{}");
          const incoming = data.state || {};
          const merged = mergeRoom({ stocks: room.stocks, trades: room.trades, deleted: room.deleted }, incoming);
          room.stocks = merged.stocks;
          room.trades = merged.trades;
          room.deleted = merged.deleted;
          room.updatedAt = Date.now();
          persist();
          sendJSON(res, 200, { updatedAt: room.updatedAt, state: { stocks: room.stocks, trades: room.trades, deleted: room.deleted } });
        } catch (e) {
          sendJSON(res, 400, { error: "bad json" });
        }
      });
      return;
    }
    sendJSON(res, 405, { error: "method not allowed" });
    return;
  }

  // 已下线页面显式 404（沙箱增量部署不清理远端旧文件）
  if (url.pathname === "/sectors.html") {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found"); return;
  }

  // 静态文件托管
  let p = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(ROOT, p));
  if (!filePath.startsWith(ROOT) || filePath.includes(".sync-data")) {
    res.writeHead(403); res.end("forbidden"); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found"); return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log("股票记账同步服务已启动: http://localhost:" + PORT);
});
