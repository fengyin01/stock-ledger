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

const server = http.createServer((req, res) => {
  // CORS 预检
  if (req.method === "OPTIONS") { sendJSON(res, 204, {}); return; }

  const url = new URL(req.url, "http://localhost");
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
