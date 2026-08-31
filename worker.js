// 股票记账 · 多端实时同步后端（Cloudflare Workers + D1，零依赖）
// 协议与本地 server.js 完全一致：
//   GET  /api/<room>/sync  -> { updatedAt, state:{stocks,trades,deleted} }
//   POST /api/<room>/sync  body { state:{stocks,trades,deleted} }
//                       -> 合并后返回 { updatedAt, state }
// 持久化：D1(SQLite) 单表 rooms(room_id PK, state TEXT, updated_at INT)
// 合并策略：LWW（按 id，updatedAt 大者胜）；deleted 取并集并过滤。

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(code, obj) {
  return new Response(JSON.stringify(obj), {
    status: code,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}

// LWW 合并：按 id，updatedAt 大者胜
function mergeArr(a, b) {
  const m = new Map();
  (a || []).forEach((r) => m.set(r.id, r));
  (b || []).forEach((r) => {
    const cur = m.get(r.id);
    const rt = r.updatedAt || 0;
    const ct = cur ? cur.updatedAt || 0 : -1;
    if (!cur || rt > ct) m.set(r.id, r);
  });
  return Array.from(m.values());
}

function mergeRoom(room, incoming) {
  const deleted = Array.from(
    new Set([...(room.deleted || []), ...(incoming.deleted || [])])
  );
  const stocks = mergeArr(room.stocks, incoming.stocks).filter(
    (r) => !deleted.includes(r.id)
  );
  const trades = mergeArr(room.trades, incoming.trades).filter(
    (r) => !deleted.includes(r.id)
  );
  return { stocks, trades, deleted };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    const m = url.pathname.match(/^\/api\/([^/]+)\/sync$/);
    if (!m) return json(404, { error: "not found" });

    const roomId = decodeURIComponent(m[1]);
    const now = Date.now();

    if (request.method === "GET") {
      const row = await env.DB.prepare(
        "SELECT state, updated_at FROM rooms WHERE room_id = ?"
      )
        .bind(roomId)
        .first();
      if (!row) {
        return json(200, {
          updatedAt: 0,
          state: { stocks: [], trades: [], deleted: [] },
        });
      }
      let state = {};
      try {
        state = JSON.parse(row.state || "{}");
      } catch (e) {
        state = {};
      }
      return json(200, { updatedAt: row.updated_at || 0, state });
    }

    if (request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return json(400, { error: "bad json" });
      }
      const incoming = body.state || {};
      const row = await env.DB.prepare(
        "SELECT state FROM rooms WHERE room_id = ?"
      )
        .bind(roomId)
        .first();
      let existing = { stocks: [], trades: [], deleted: [] };
      if (row) {
        try {
          existing = JSON.parse(row.state || "{}");
        } catch (e) {}
      }
      const merged = mergeRoom(existing, incoming);
      const stateStr = JSON.stringify(merged);
      await env.DB.prepare(
        "INSERT INTO rooms (room_id, state, updated_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(room_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at"
      )
        .bind(roomId, stateStr, now)
        .run();
      return json(200, { updatedAt: now, state: merged });
    }

    return json(405, { error: "method not allowed" });
  },
};
