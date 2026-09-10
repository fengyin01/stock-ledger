// 股票记账 · 静态托管 + 分红预测数据代理（零依赖 Node.js）
// 前端的多端同步已改为 GitHub Gist（每台设备各自持有 PAT），本服务不再承担同步职责。
// 运行： node server.js   （PORT 环境变量可改，默认 3000）
// 部署： 推到 Render / Railway / Fly.io 等任意 Node 平台即可获得公网地址。

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, ".sync-data");

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

// ---------- 静态文件白名单 ----------
// 原实现把整个目录都托管出去，/server.js、/worker.js、/package.json、/render.yaml、
// /schema.sql、/fetch_*.js 都能被任意下载（实测线上确实能下到），等于把部署细节公开。
// 这里只放行前端真正需要的文件，其余一律 404（不用 403，避免暴露文件是否存在）。
const PUBLIC_EXT = new Set([".html", ".js", ".css", ".json", ".png", ".svg", ".ico"]);
const BLOCKED_FILES = new Set([
  "server.js", "worker.js", "package.json", "package-lock.json",
  "wrangler.toml", "render.yaml", "schema.sql"
]);
const BLOCKED_PREFIX = ["fetch_", "check_"];
function isPublicFile(rel) {
  if (!rel || rel.startsWith("..")) return false;
  const parts = rel.split("/");
  if (parts.length !== 1) return false;                       // 只托管根目录下的前端文件
  if (parts[0].startsWith(".")) return false;                 // .git / .github / .gitignore / .sync-data
  const name = parts[0].toLowerCase();
  if (BLOCKED_FILES.has(name)) return false;
  if (BLOCKED_PREFIX.some(p => name.startsWith(p))) return false;
  return PUBLIC_EXT.has(path.extname(name));
}

// ---------- 分红预测数据代理 ----------
// 上游是第三方接口，只放行白名单 action，避免本服务被当成任意 URL 的开放代理。
// 注意：上游存在 CORS 白名单（只放行它自己的站点），因此转发时带了上游期望的 Origin；
// 若你日后迁到自己的数据源，请用环境变量 DIV_API 覆盖，并去掉下面这两个头部。
const DIV_API = process.env.DIV_API || "https://vercel-dividend-d8faqegf03442b6c.service.tcloudbase.com/stockPrice";
const DIV_ACTIONS = new Set(["", "forecastData", "dividendPayout", "dividendHistory", "dividendCommitmentSummary", "search"]);
function proxyDiv(req, res, url) {
  const action = url.searchParams.get("action") || "";
  if (!DIV_ACTIONS.has(action)) {
    sendJSON(res, 400, { error: "unsupported action" });
    return;
  }
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

  // 旧版「房间号同步」接口：已下线，保留显式提示方便老版本前端与书签自查。
  // 原实现无任何鉴权、CORS 全开、room id 就是唯一凭据 —— 知道房间号即可读写别人的账本。
  if (/^\/api\/[^/]+\/sync$/.test(url.pathname)) {
    sendJSON(res, 410, { error: "gone", hint: "旧房间号同步已下线，请改用 GitHub Gist 同步（在页面「同步」弹窗中配置）" });
    return;
  }

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

  // 已下线页面显式 404（沙箱增量部署不清理远端旧文件）
  if (url.pathname === "/sectors.html") {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found"); return;
  }

  // 静态文件托管（仅白名单内的前端资源）
  const p = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(ROOT, decodeURIComponent(p)));
  const rel = path.relative(ROOT, filePath).replace(/\\/g, "/");
  if (!filePath.startsWith(ROOT) || !isPublicFile(rel)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found"); return;
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
  console.log("股票记账（静态托管 + 分红代理）已启动: http://localhost:" + PORT);
});
