/* 首页 / 自选页顶部指数栏：上证指数、科创50、创业50
 * 自包含模块（IIFE），不依赖页面其它脚本，可直接被 index.html / watchlist.html 引用。
 * 行情来源：腾讯 qt.gtimg.cn（JSONP，免 CORS）。实时数值按当前时间刷新。 */
(function () {
  "use strict";

  var INDICES = [
    { code: "sh000001", name: "上证指数" },
    { code: "sh000688", name: "科创50" },
    { code: "sz399673", name: "创业50" }
  ];

  /* ---------- 时钟校准：用行情服务器 Date 头修正设备时间/时区误差 ---------- */
  var clockSkew = 0;                 // 服务器时间 - 本地时间(ms)
  function nowTs() { return Date.now() + clockSkew; }
  function syncClock() {
    function probe(url, opt) {
      var t0 = Date.now();
      return fetch(url, opt).then(function (r) {
        var d = r.headers.get("Date");
        if (!d) throw new Error("no date");
        var t = new Date(d).getTime();
        if (isNaN(t)) throw new Error("bad date");
        var t1 = Date.now();
        clockSkew = Math.round(t + (t1 - t0) / 2 - t1);
        return true;
      });
    }
    try {
      return probe("https://qt.gtimg.cn/q=sh000001&r=" + Date.now(), { cache: "no-store" })
        .catch(function () { return probe(location.href, { method: "HEAD", cache: "no-store" }); })
        .catch(function () {});
    } catch (e) { return Promise.resolve(); }
  }

  /* ---------- 交易时段（北京时间 UTC+8） ---------- */
  function zoneParts() {
    var now = new Date(nowTs());
    var p = {};
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Shanghai", hour12: false, weekday: "short",
      hour: "2-digit", minute: "2-digit", second: "2-digit"
    }).formatToParts(now).forEach(function (x) { p[x.type] = x.value; });
    return { wd: p.weekday, h: (+p.hour) % 24, mi: +p.minute, s: +p.second };
  }
  function marketOpenBJ() {
    var p = zoneParts();
    if (p.wd === "Sat" || p.wd === "Sun") return false;
    var t = p.h * 60 + p.mi;
    return (t >= 9 * 60 + 30 && t <= 11 * 60 + 30) || (t >= 13 * 60 && t <= 15 * 60);
  }

  /* ---------- 拉取行情（批量 JSONP） ---------- */
  function fetchQuotes(codes) {
    if (!codes.length) return Promise.resolve(0);
    return new Promise(function (resolve) {
      var sc = document.createElement("script");
      var done = false;
      function finish(ok) {
        if (done) return; done = true;
        try { sc.remove(); } catch (e) {}
        resolve(ok);
      }
      sc.charset = "GBK";
      sc.onload = function () { finish(true); };
      sc.onerror = function () { finish(false); };
      sc.src = "https://qt.gtimg.cn/q=" + codes.join(",") + "&r=" + Date.now();
      setTimeout(function () { finish(false); }, 8000);
      document.head.appendChild(sc);
    }).then(function (ok) {
      if (!ok) return 0;
      var n = 0;
      codes.forEach(function (code) {
        var raw = window["v_" + code];
        if (typeof raw !== "string" || !raw) return;
        var f = raw.replace(/^"+/, "").replace(/"+$/, "").split("~");
        var price = parseFloat(f[3]);
        var prev = parseFloat(f[4]);
        if (isNaN(price) || price <= 0 || isNaN(prev) || prev <= 0) return;
        var pct = parseFloat(f[32]);
        if (isNaN(pct)) pct = (price - prev) / prev * 100;
        var abs = price - prev;
        var bar = document.querySelector('[data-idx="' + code + '"]');
        if (!bar) return;
        var valEl = bar.querySelector(".idx-val");
        var chgEl = bar.querySelector(".idx-chg");
        var absEl = bar.querySelector(".idx-abs");
        if (valEl) { valEl.textContent = price.toFixed(2); }
        if (chgEl) {
          var cls = pct > 0 ? "up" : (pct < 0 ? "down" : "flat");
          chgEl.className = "idx-chg " + cls;
          chgEl.textContent = (pct > 0 ? "+" : "") + pct.toFixed(2) + "%";
        }
        if (absEl) {
          var absCls = abs > 0 ? "up" : (abs < 0 ? "down" : "flat");
          absEl.className = "idx-abs " + absCls;
          absEl.textContent = (abs > 0 ? "+" : "") + abs.toFixed(2);
        }
        n++;
      });
      return n;
    });
  }

  /* ---------- 渲染结构 ---------- */
  function renderBar(bar) {
    bar.classList.add("indices-bar");
    bar.innerHTML = INDICES.map(function (it) {
      return '<div class="idx-item" data-idx="' + it.code + '">' +
        '<span class="idx-name">' + it.name + '</span>' +
        '<span class="idx-val">—</span>' +
        '<span class="idx-chg flat">—</span>' +
        '<span class="idx-abs flat">—</span>' +
        '</div>';
    }).join("");
  }
  function updateClock(bar) {
    if (!bar) return;
    var p = zoneParts();
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    var timeEl = bar.querySelector(".idx-time");
    if (timeEl) timeEl.textContent = "北京时间 " + pad(p.h) + ":" + pad(p.mi) + ":" + pad(p.s);
  }

  /* ---------- 自动刷新调度 ---------- */
  var timer = null;
  function schedule() {
    if (timer) clearTimeout(timer);
    // 交易时段 10 秒一刷，非交易时段降频到 30 秒
    var delay = marketOpenBJ() ? 10000 : 30000;
    timer = setTimeout(function () {
      fetchQuotes(INDICES.map(function (i) { return i.code; })).then(schedule, schedule);
    }, delay);
  }

  function init() {
    var bars = document.querySelectorAll("[data-indices-bar]");
    if (!bars.length) return;
    Array.prototype.forEach.call(bars, function (bar) {
      renderBar(bar);
      var time = document.createElement("span");
      time.className = "idx-time";
      bar.appendChild(time);
      updateClock(bar);
    });
    syncClock()
      .then(function () {
        Array.prototype.forEach.call(bars, updateClock);
        return fetchQuotes(INDICES.map(function (i) { return i.code; }));
      })
      .then(schedule, schedule);
    setInterval(function () { Array.prototype.forEach.call(bars, updateClock); }, 1000);
    // 回到前台立刻补一次（手机锁屏会挂起定时器）
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) return;
      syncClock().then(function () {
        return fetchQuotes(INDICES.map(function (i) { return i.code; }));
      }).then(schedule, schedule);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else { init(); }
})();
