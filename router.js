/* =====================================================================
   router.js — Định tuyến bằng đường dẫn thật (không dùng #) cho Nhót Phim
   Đặt file này cạnh index.html / web2.html và thêm ngay trước </body>:
       <script src="router.js"></script>

   Các đường dẫn:
     /                                    Trang chủ
     /phim/<ten-phim>/tap-<n>/sv<k>       Đang xem một phim (tập n, server k: sv1 sv2 sv3 m3u8)
     /phim-le  /phim-bo                   Phim lẻ / phim bộ
     /the-loai/<the-loai>                 vd /the-loai/hanh-dong
     /quoc-gia/<quoc-gia>                 vd /quoc-gia/han-quoc
     /nam/<nam>  /ngon-ngu/<ngon-ngu>     vd /nam/2025, /ngon-ngu/phu-de
     /phim-bo?quoc-gia=kr&sx=rating&trang=2
                                          Bộ lọc còn lại và số trang nằm ở query (mọi tham số tùy chọn)
                                          ngon-ngu = sub | tm | dub ; sx = default | updated | rating
     /duyet-tim?...                       Kiểu cũ, vẫn đọc được
     /tim-kiem/<tu-khoa>?loai=...&trang=2 Kết quả tìm kiếm (có thể lọc thêm bằng các tham số trên)
     /tai-khoan  /yeu-thich  /danh-sach  /xem-tiep     Trang cá nhân

   Vì là đường dẫn thật nên khi F5 ngay ở /phim/... máy chủ phải trả về chính trang
   xem phim (SPA fallback), ví dụ Netlify/Cloudflare Pages: /*  /web2.html  200
   (xem README cạnh file này). Mở file trực tiếp bằng file:// thì trình duyệt chặn
   history API -> URL không đổi được, trang vẫn chạy bình thường.

   Link kiểu cũ có # (#/phim/..., #phim/...) vẫn được đọc và tự chuyển sang đường dẫn thật.
   Không đụng tới ?code= / #access_token= của đăng nhập Google.
   Không cần sửa gì khác trong trang: file tự "bọc" các hàm có sẵn
   (openPlayer, closeDetail, showHome, showBrowse, filterBy..., doSearch, goPg, openMe).
   ===================================================================== */
(function () {
  "use strict";

  /* ---------- giữ màn hình tải của app khi F5 ở trang phim ----------
     index.html (trong <head>) đặt window.__npHold = true khi link là #phim/..., và hideLoadingScreen()
     sẽ không ẩn màn tải cho tới khi __npRelease() được gọi (ở đây: sau khi phim đã mở xong). */
  function uncover() { try { if (window.__npRelease) window.__npRelease(); } catch (e) {} }
  function uncoverWhenOpen(tries) {
    if (!window.__npHold) return;
    if (shown("detail-page") || (tries || 0) > 60) { setTimeout(uncover, 300); return; }
    setTimeout(function () { uncoverWhenOpen((tries || 0) + 1); }, 100);
  }

  var baseTitle = document.title;
  // Tên ngắn để ghép vào tiêu đề phụ (trang chủ giữ đủ "Nhót Phim - Phim hay chín hết cả mùa")
  var brandShort = (baseTitle.split(" - ")[0] || baseTitle).trim();
  var pageTitle = baseTitle;   // tiêu đề của trang nền (khi không mở phim)
  var booting = true;          // chưa khôi phục xong -> chưa được ghi đè URL
  var applying = 0;            // đang áp dụng URL -> các hàm bọc không ghi lịch sử
  var baseRoute = "";          // đường dẫn của trang nền đang hiển thị (chủ / duyệt / tài khoản)
  var detailPushed = false;    // trang phim đang mở có 1 mục lịch sử riêng (nút ← sẽ dùng history.back)
  var expectId = null;         // phim đang được mở theo URL (để không ghi đè lịch sử)
  var expectPushed = false;
  var expectTimer = null;
  var pendingSearch = null;    // từ khóa của lần tìm kiếm đang chạy
  var pendingBrowse = null;    // bộ lọc của lần bấm lọc đang chạy
  var browseState = null;      // {q, f, page} của trang duyệt hiện tại

  var FILTERS = [
    ["loai", "f-type"], ["quoc-gia", "f-country"], ["the-loai", "f-genre"], ["ngon-ngu", "f-lang"], ["nam", "f-year"], ["sx", "f-sort"]
  ];
  var ME_ROUTES = { "tai-khoan": "account", "yeu-thich": "favs", "danh-sach": "list", "xem-tiep": "continue" };
  var ME_PATHS = { account: "/tai-khoan", favs: "/yeu-thich", list: "/danh-sach", continue: "/xem-tiep" };
  var NAV_GENRE_LABEL = { action: "Hành Động", romance: "Tình Cảm", horror: "Kinh Dị", comedy: "Hài Hước" };

  /* ---------- tiện ích ---------- */
  function $(id) { return document.getElementById(id); }
  function shown(id) { var e = $(id); return !!e && e.style.display !== "none" && e.style.display !== ""; }
  function detailOpen() { return shown("detail-page"); }
  function dec(s) { try { return decodeURIComponent(String(s).replace(/\+/g, " ")); } catch (e) { return s; } }
  function slug(str) {
    return normalizeStr(String(str || "")).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  }
  function findMovie(idStr) {
    return (typeof MOVIES !== "undefined" ? MOVIES : []).find(function (x) { return String(x.id) === String(idStr); });
  }
  // Tên phim trên URL: slug của tên; nếu trùng tên với phim khác thì thêm năm, vẫn trùng thì thêm id.
  // Dựng bảng tra 1 lần cho cả danh sách (trước đây mỗi lần tìm lại slug() toàn bộ danh sách -> chậm theo bình phương
  // khi có nhiều phim, nút Back/Forward vào trang phim bị đơ).
  var slugIdx = null;
  function slugIndex(force) {
    var all = typeof MOVIES !== "undefined" ? MOVIES : [];
    if (!force && slugIdx && slugIdx.ref === all && slugIdx.n === all.length) return slugIdx;
    var raw = new Array(all.length), cnt = Object.create(null), cntY = Object.create(null), i, s, k, m, r;
    for (i = 0; i < all.length; i++) {
      s = slug(all[i].title); raw[i] = s;
      if (s) {
        cnt[s] = (cnt[s] || 0) + 1;
        k = s + "\u0000" + typeof all[i].year + all[i].year;
        cntY[k] = (cntY[k] || 0) + 1;
      }
    }
    var out = { ref: all, n: all.length, byId: Object.create(null), bySlug: Object.create(null) };
    for (i = 0; i < all.length; i++) {
      m = all[i]; s = raw[i];
      if (!s) r = String(m.id);
      else if (cnt[s] <= 1) r = s;
      else if (m.year && cntY[s + "\u0000" + typeof m.year + m.year] <= 1) r = s + "-" + m.year;
      else r = s + (m.year ? "-" + m.year : "") + "-" + m.id;
      out.byId[m.id] = r;
      if (!(r in out.bySlug)) out.bySlug[r] = m;
    }
    slugIdx = out;
    return out;
  }
  function movieSlug(m) {
    var ix = slugIndex(), r = ix.byId[m.id];
    if (r === undefined) { ix = slugIndex(true); r = ix.byId[m.id]; }
    return r !== undefined ? r : (slug(m.title) || String(m.id));
  }
  // Tìm phim theo tên trên URL (link cũ dùng id số vẫn đọc được)
  function findMovieBySlug(sl) {
    var ix = slugIndex(), m = ix.bySlug[sl];
    if (!m) { ix = slugIndex(true); m = ix.bySlug[sl]; }
    return m || findMovie(sl);
  }
  /* ---------- đường dẫn thật (không dùng #) ----------
     router.js nằm cạnh trang nên thư mục chứa nó là gốc site (BASE):
     BASE + /phim/..., BASE + /duyet-tim?... Trang chủ là BASE (hoặc đúng tên file đang mở).
     Hash cũ (#/phim/...) vẫn đọc được để link đã chia sẻ không bị chết. */
  var BASE = (function () {
    var b = null;
    try {
      var s = document.currentScript && document.currentScript.src;
      if (s) b = new URL(s, location.href).pathname.replace(/[^\/]*$/, "");
    } catch (e) {}
    if (b == null) b = (location.pathname || "/").replace(/[^\/]*$/, "");
    return b || "/";
  })();
  var HOME_FILE = (function () {
    var m = /\/([^\/]+\.html?)$/i.exec(location.pathname || "");
    return m ? m[1] : "";   // đang mở /web2.html -> trang chủ giữ nguyên tên file đó
  })();
  var ROUTE_HEADS = /^(?:phim|duyet-tim|tim-kiem|tai-khoan|yeu-thich|danh-sach|xem-tiep)(?:[\/?]|$)/;
  function hashRoute() {
    var h = (location.hash || "").replace(/^#\/?/, "");
    return ROUTE_HEADS.test(h) ? "/" + h : "";
  }
  function pathRoute() {
    var p = location.pathname || "/";
    if (BASE !== "/" && p.indexOf(BASE) === 0) p = "/" + p.slice(BASE.length);
    var rel = p.replace(/^\/+/, "").replace(/\/+$/, "");
    if (!rel || /^index\.html?$/i.test(rel) || (HOME_FILE && rel.toLowerCase() === HOME_FILE.toLowerCase())) return "";
    return "/" + rel + (location.search || "");
  }
  function currentRoute() { return hashRoute() || pathRoute(); }
  function urlFor(route) {
    return BASE + (route ? String(route).replace(/^\/+/, "") : HOME_FILE);
  }
  function migrateHash() {
    var h = hashRoute();
    if (!h) return;
    try { history.replaceState(history.state || null, "", urlFor(h)); } catch (e) {}
  }
  function parse(route) {
    var qi = route.indexOf("?");
    var path = qi < 0 ? route : route.slice(0, qi);
    var query = {};
    if (qi >= 0) {
      route.slice(qi + 1).split("&").forEach(function (pair) {
        if (!pair) return;
        var i = pair.indexOf("=");
        query[dec(i < 0 ? pair : pair.slice(0, i))] = i < 0 ? "" : dec(pair.slice(i + 1));
      });
    }
    return { parts: path.split("/").filter(Boolean).map(dec), query: query };
  }

  /* ---------- số tập (đọc / chọn tập) ---------- */
  var pendingEp = null;
  var pendingKind = null;      // server cần chọn khi khôi phục từ URL (m3u8 | embed | embed2 | embed3)
  var restoring = false;       // đang mở phim theo URL (chưa hiện xong)
  var closingUntil = 0;        // vừa đóng phim: chờ history.back() xử lý xong
  // Tên server trên URL: Server 1 -> sv1, Server 2 -> sv2, Server 3 -> sv3, Server M3U8 -> m3u8
  var SV_OUT = { m3u8: "m3u8", embed: "sv1", embed2: "sv2", embed3: "sv3" };
  var SV_IN = { m3u8: "m3u8", sv1: "embed", sv2: "embed2", sv3: "embed3" };
  function visibleKind() {
    var ls = document.querySelectorAll('#dp-episodes [id^="ep-list-"]');
    for (var i = 0; i < ls.length; i++) {
      try { if (getComputedStyle(ls[i]).display !== "none") return ls[i].id.replace("ep-list-", ""); } catch (e) {}
    }
    return null;
  }
  function getSv() { var k = visibleKind(); return k && SV_OUT[k] ? SV_OUT[k] : null; }

  // Tập đang xem: app lưu chỉ số (từ 0) ở window._seriesCurrentEpIndex -> số tập = chỉ số + 1
  function getEp() {
    var m = findMovie(typeof _currentWatchMovieId !== "undefined" ? _currentWatchMovieId : null);
    if (!m || m.type !== "series") return null;
    var i = window._seriesCurrentEpIndex;
    return (typeof i === "number" && i >= 0) ? i + 1 : null;
  }
  // Chuyển tới tập n bằng playEpisode(kind, idx) của app. Trả về true nếu thành công.
  function setEp(n, want) {
    if (typeof playEpisode !== "function" || typeof EP_KINDS === "undefined") return false;
    var idx = n - 1, kinds = Object.keys(EP_KINDS), order = [];
    if (want && EP_KINDS[want] && visibleKind() !== want && document.getElementById("srv-tab-" + want) && typeof switchSeriesTab === "function") {
      try { switchSeriesTab(want); } catch (e) {}
    }
    if (want && EP_KINDS[want]) order.push(want);
    // ưu tiên server đang hiển thị
    var vis = document.querySelector('#dp-episodes [id^="ep-list-"]:not([style*="display: none"])');
    if (vis) { var k0 = vis.id.replace("ep-list-", ""); if (EP_KINDS[k0] && order.indexOf(k0) < 0) order.push(k0); }
    kinds.forEach(function (k) { if (order.indexOf(k) < 0) order.push(k); });
    for (var i = 0; i < order.length; i++) {
      var k = EP_KINDS[order[i]], arr = (k.arr && k.arr()) || [];
      if (arr[idx] && arr[idx][k.field]) {
        try { if (playEpisode(order[i], idx)) return true; } catch (e) {}
      }
    }
    return false;
  }
  function watchRoute(m, ep, sv) {
    return "/phim/" + encodeURIComponent(movieSlug(m)) + (ep ? "/tap-" + ep + (sv ? "/" + sv : "") : "");
  }
  function setTitle(m, ep) {
    try { document.title = (m && m.title ? m.title : "") + (ep ? " - Tập " + ep : "") + " - " + brandShort; } catch (e) {}
  }
  function applyEpWhenReady(n, tries) {
    if (!n) { pendingEp = null; pendingKind = null; return; }
    tries = tries || 0;
    if ((getEp() === n && (!pendingKind || visibleKind() === pendingKind)) || setEp(n, pendingKind) || tries > 20) {
      setTitle(findMovie(typeof _currentWatchMovieId !== "undefined" ? _currentWatchMovieId : null), n);
      setTimeout(function () { pendingEp = null; pendingKind = null; }, 800);
      return;
    }
    setTimeout(function () { applyEpWhenReady(n, tries + 1); }, 500);
  }
  // Khi người xem đổi tập -> cập nhật URL (thay thế, không thêm lịch sử)
  setInterval(function () {
    if (booting || applying) return;
    if (!detailOpen()) {
      // Phim đã đóng mà link vẫn là #phim/... (vd. history.back() không có chỗ để lùi) -> trả link về trang nền
      if (!restoring && !pendingEp && Date.now() > closingUntil && currentRoute().indexOf("/phim/") === 0) {
        detailPushed = false; expectId = null;
        try { document.title = pageTitle; } catch (e) {}
        navigate(baseRoute, "replace");
      }
      return;
    }
    restoring = false;
    if (pendingEp) return;
    var m = findMovie(typeof _currentWatchMovieId !== "undefined" ? _currentWatchMovieId : null);
    if (!m) return;
    var ep = getEp(), sv = ep ? getSv() : null, route = watchRoute(m, ep, sv);
    if (currentRoute() !== route && currentRoute().indexOf("/phim/") === 0) {
      navigate(route, "replace", { d: !!(history.state && history.state.d) });
      setTitle(m, ep);
    }
  }, 700);

  /* ---------- ghi lịch sử trình duyệt ---------- */
  function setRoute(route, mode, extra) {
    route = route || "";
    if (currentRoute() === route) return;
    var state = { np: route };
    if (extra && extra.d) state.d = 1;
    try {
      var url = urlFor(route);
      if (mode === "push") history.pushState(state, "", url);
      else history.replaceState(state, "", url);
    } catch (e) { /* trình duyệt chặn history API (file://) -> bỏ qua, app vẫn chạy bình thường */ }
  }
  function navigate(route, mode, extra) {
    if (booting || applying) return;
    setRoute(route, mode, extra);
  }

  /* ---------- dựng đường dẫn ----------
     Bộ lọc chính thành đường dẫn đọc được: /phim-le, /phim-bo, /the-loai/hanh-dong,
     /quoc-gia/han-quoc, /nam/2025, /ngon-ngu/phu-de; các bộ lọc còn lại + số trang ở query.
     Nhãn lấy từ chính các ô chọn trong trang nên thêm thể loại/quốc gia mới là tự có. */
  var SLUGS = null;
  function slugMaps() {
    var ids = { "the-loai": "f-genre", "quoc-gia": "f-country", "ngon-ngu": "f-lang", "sx": "f-sort" };
    if (SLUGS) return SLUGS;
    var maps = { bySlug: {}, byValue: {} };
    Object.keys(ids).forEach(function (k) {
      maps.bySlug[k] = {}; maps.byValue[k] = {};
      var el = $(ids[k]);
      if (!el) return;
      Array.prototype.forEach.call(el.options, function (o) {
        if (!o.value) return;
        var s = slug(o.textContent) || o.value;
        maps.bySlug[k][s] = o.value;
        maps.byValue[k][o.value] = s;
      });
    });
    SLUGS = maps;
    return maps;
  }
  function valOf(key, slugStr) {
    var m = slugMaps();
    if (m.bySlug[key] && m.bySlug[key][slugStr]) return m.bySlug[key][slugStr];
    return slugStr;   // người dùng gõ thẳng mã (action, kr...) vẫn nhận
  }
  function browseRoute(f, page) {
    var m = slugMaps(), path = "/duyet-tim", used = null;
    function take(key, fn) {
      if (used || !f || !f[key]) return;
      var p = fn(f[key]);
      if (!p) return;
      path = p; used = key;
    }
    take("loai", function (v) { return v === "movie" ? "/phim-le" : v === "series" ? "/phim-bo" : null; });
    take("the-loai", function (v) { return "/the-loai/" + encodeURIComponent(m.byValue["the-loai"][v] || v); });
    take("quoc-gia", function (v) { return "/quoc-gia/" + encodeURIComponent(m.byValue["quoc-gia"][v] || v); });
    take("nam", function (v) { return "/nam/" + encodeURIComponent(v); });
    take("ngon-ngu", function (v) { return "/ngon-ngu/" + encodeURIComponent(m.byValue["ngon-ngu"][v] || v); });
    var q = [];
    FILTERS.forEach(function (p) {
      if (p[0] === used) return;
      var v = f && f[p[0]];
      if (v && !(p[0] === "sx" && v === "default")) q.push(p[0] + "=" + encodeURIComponent(v));
    });
    if (page > 1) q.push("trang=" + page);
    return path + (q.length ? "?" + q.join("&") : "");
  }
  // Gộp bộ lọc lấy từ đường dẫn (/phim-le -> loai=movie) với query còn lại
  function qWith(base, query) {
    var o = {}, k;
    for (k in query) o[k] = query[k];
    for (k in base) o[k] = base[k];
    return o;
  }
  // Bộ lọc suy ra từ một đường dẫn (dùng để đánh dấu lại menu sau khi bấm "Xem tất cả")
  function filtersOfRoute(route) {
    var p = parse(route || ""), parts = p.parts, head = parts[0] || "", q = qWith({}, p.query);
    if (head === "phim-le") q.loai = "movie";
    else if (head === "phim-bo") q.loai = "series";
    else if ((head === "the-loai" || head === "quoc-gia" || head === "ngon-ngu") && parts[1]) q[head] = valOf(head, parts[1]);
    else if (head === "nam" && parts[1]) q.nam = parts[1];
    return q;
  }
  function searchRoute(q, page, f) {
    var qs = [];
    FILTERS.forEach(function (p) {
      var v = f && f[p[0]];
      if (v && !(p[0] === "sx" && v === "default")) qs.push(p[0] + "=" + encodeURIComponent(v));
    });
    if (page > 1) qs.push("trang=" + page);
    return "/tim-kiem/" + encodeURIComponent(q) + (qs.length ? "?" + qs.join("&") : "");
  }
  function hasFilters(f) {
    return FILTERS.some(function (p) { var v = f && f[p[0]]; return v && !(p[0] === "sx" && v === "default"); });
  }
  function filtersFromSelects() {
    var f = {};
    FILTERS.forEach(function (p) { var e = $(p[1]); f[p[0]] = e ? e.value : ""; });
    return f;
  }

  /* ---------- đánh dấu mục menu đang chọn ---------- */
  function syncNav(kind, query) {
    var labels = [];
    if (kind === "home") labels = ["Đề Xuất", "Trang Chủ"];
    else if (kind === "browse" && query) {
      var keys = Object.keys(query).filter(function (k) {
        return k !== "trang" && query[k] && !(k === "sx" && query[k] === "default");
      });
      if (keys.length === 1) {
        var k = keys[0];
        if (k === "loai") labels = [query.loai === "movie" ? "Phim Lẻ" : query.loai === "series" ? "Phim Bộ" : ""];
        else if (k === "the-loai") labels = [NAV_GENRE_LABEL[query[k]] || "", "Thể Loại"];
        else if (k === "quoc-gia") labels = ["Quốc Gia"];
      }
    }
    var found = null;
    Array.prototype.forEach.call(document.querySelectorAll(".nav-link"), function (l) {
      if (found) return;
      if (labels.indexOf(l.textContent.trim()) !== -1) found = l;
    });
    try { if (typeof setNav === "function") setNav(found); } catch (e) {}
  }

  /* ---------- bọc các hàm có sẵn (không cần sửa index.html) ---------- */
  function wrap(name, before, after) {
    var orig = window[name];
    if (typeof orig !== "function") { console.warn("[router] không tìm thấy hàm", name); return; }
    window[name] = function () {
      var args = arguments;
      if (before) { try { before.apply(null, args); } catch (e) { console.warn("[router]", name, e); } }
      try { return orig.apply(this, args); }
      finally { if (after) { try { after.apply(null, args); } catch (e) { console.warn("[router]", name, e); } } }
    };
  }

  // Trang nền: chủ
  wrap("showHome", null, function () {
    baseRoute = ""; browseState = null; pageTitle = baseTitle;
    try { document.title = baseTitle; } catch (e) {}
    navigate("", "push");
    setTimeout(function () { syncNav("home"); }, 0);
  });

  // Trang nền: duyệt / lọc / tìm kiếm
  wrap("showBrowse", null, function () {
    var route;
    if (pendingSearch != null) {
      browseState = { q: pendingSearch, f: null, page: 1 };
      route = searchRoute(pendingSearch, 1);
    } else {
      var f = pendingBrowse || filtersFromSelects();
      browseState = { q: null, f: f, page: 1 };
      route = browseRoute(f, 1);
    }
    pendingSearch = pendingBrowse = null;
    baseRoute = route;
    var t = $("browse-title");
    pageTitle = ((t && t.textContent) || "Duyệt Tìm") + " - " + brandShort;
    try { document.title = pageTitle; } catch (e) {}
    navigate(route, "push");
    // App tự đặt lại menu khi mở trang duyệt -> đánh dấu lại sau đó để "Xem tất cả"
    // ở các hàng (Phim Bộ, Phim Hàn, Thể Loại...) sáng đúng mục tương ứng.
    setTimeout(function () {
      syncNav(route.indexOf("/tim-kiem") === 0 ? "search" : "browse", filtersOfRoute(route));
    }, 0);
  });
  function clearPending() { pendingSearch = pendingBrowse = null; }
  wrap("filterByGenre", function (g) { pendingBrowse = { "the-loai": g }; }, clearPending);
  wrap("filterByType", function (t) { pendingBrowse = { loai: t }; }, clearPending);
  wrap("filterByCountry", function (c) { pendingBrowse = { "quoc-gia": c }; }, clearPending);
  wrap("doSearch", function () {
    var d = $("search-input"), m = $("search-overlay-input"), ov = $("search-overlay");
    var open = !!ov && ov.classList.contains("show");
    var raw = (open ? ((m && m.value) || "") : ((d && d.value) || (m && m.value) || "")).trim();
    pendingSearch = raw || null;
  }, clearPending);
  // Đổi bộ lọc bằng ô chọn: chỉ thay URL (không thêm mục lịch sử)
  wrap("applyFilter", null, function () {
    var f = filtersFromSelects();
    var q = (browseState && browseState.q != null) ? browseState.q : null; // đang xem kết quả tìm kiếm -> giữ từ khoá
    browseState = { q: q, f: f, page: 1 };
    baseRoute = q != null ? searchRoute(q, 1, f) : browseRoute(f, 1);
    if (!applying && shown("page-browse")) navigate(baseRoute, "replace");
    var rr = baseRoute;
    setTimeout(function () { syncNav("browse", filtersOfRoute(rr)); }, 0);
  });
  // Chuyển trang kết quả
  wrap("goPg", null, function () {
    if (!browseState) return;
    browseState.page = (typeof bPage !== "undefined") ? bPage : 1;
    baseRoute = browseState.q != null ? searchRoute(browseState.q, browseState.page, browseState.f) : browseRoute(browseState.f, browseState.page);
    navigate(baseRoute, "push");
  });

  // Trang nền: tài khoản / yêu thích / danh sách / xem tiếp
  wrap("openMe", null, function (section) {
    if (!shown("page-me")) return; // chưa đăng nhập -> hàm gốc đã bật khung đăng nhập
    var route = ME_PATHS[section || "account"] || ME_PATHS.account;
    baseRoute = route;
    pageTitle = (section === "favs" ? "Yêu thích" : section === "list" ? "Danh sách" : section === "continue" ? "Xem tiếp" : "Tài khoản") + " - " + brandShort;
    try { document.title = pageTitle; } catch (e) {}
    navigate(route, "push");
  });

  // Mở phim
  wrap("_openPlayerCore", function (id) {
    var m = findMovie(id);
    if (!m) return;
    try { document.title = (m.title || "") + " - " + brandShort; } catch (e) {}
    if (expectId != null && String(expectId) === String(m.id)) {
      // đang mở theo URL (F5 / Back / Forward): URL đã đúng, không ghi lịch sử
      detailPushed = expectPushed;
      expectId = null;
      return;
    }
    var route = watchRoute(m, null);
    if (detailOpen()) navigate(route, "replace", { d: detailPushed });   // đổi phần / phim khác khi đang mở sẵn
    else { navigate(route, "push", { d: true }); detailPushed = true; }
  });

  // Đóng phim (nút ←, phím Esc)
  wrap("closeDetail", function () {
    if (!detailOpen()) return; // Esc ở trang khác: không làm gì với URL
    expectId = null;
    try { document.title = pageTitle; } catch (e) {}
    if (booting || applying) return;
    closingUntil = Date.now() + 1500;
    if (detailPushed) { detailPushed = false; history.back(); }   // quay lại đúng mục lịch sử trước đó
    else navigate(baseRoute, "replace");                          // vào thẳng bằng link / F5 -> chỉ thay URL
  });

  /* ---------- áp dụng URL lên giao diện ---------- */
  function openDetailFromRoute(idStr, tries, ep, kind) {
    restoring = true;
    setTimeout(function () { restoring = false; }, 25000);
    var m = findMovieBySlug(idStr);
    if (m) {
      if (detailOpen() && String(_currentWatchMovieId) === String(m.id)) {
        if (ep && (getEp() !== ep || (kind && visibleKind() !== kind))) { pendingEp = ep; pendingKind = kind || null; applyEpWhenReady(ep); }
        return;
      }
      expectId = m.id;
      expectPushed = !!(history.state && history.state.d);
      clearTimeout(expectTimer);
      expectTimer = setTimeout(function () { expectId = null; }, 10000);
      pendingEp = ep || null;
      pendingKind = kind || null;
      window.openPlayer(m.id);
      uncoverWhenOpen(0);
      if (ep) setTimeout(function () { applyEpWhenReady(ep); }, 400);
      return;
    }
    // Danh sách phim chưa có (đang dùng bản lưu cũ / mạng chậm): thử lại vài lần
    if ((tries || 0) < 3) { setTimeout(function () { openDetailFromRoute(idStr, (tries || 0) + 1, ep, kind); }, 2500); return; }
    uncover();
    restoring = false;
    setRoute("", "replace"); // không tìm thấy phim (đã xóa?) -> bỏ đuôi, ở lại trang chủ
  }

  function restoreBrowse(query) {
    var f = {};
    FILTERS.forEach(function (p) { f[p[0]] = query[p[0]] || ""; });
    if (typeof resetFilterFields === "function") resetFilterFields();   // xoá bộ lọc + từ khoá tìm kiếm cũ
    try { _browseQuery = ""; } catch (e) {}
    var active = FILTERS.map(function (p) { return p[0]; }).filter(function (k) { return f[k] && !(k === "sx" && f[k] === "default"); });
    if (!active.length) window.showBrowse("Duyệt Tìm");
    else if (active.length === 1 && active[0] === "the-loai") window.filterByGenre(f["the-loai"]);
    else if (active.length === 1 && active[0] === "loai" && (f.loai === "movie" || f.loai === "series")) window.filterByType(f.loai);
    else if (active.length === 1 && active[0] === "quoc-gia") window.filterByCountry(f["quoc-gia"]);
    else {
      FILTERS.forEach(function (p) {
        var e = $(p[1]);
        if (e) e.value = f[p[0]] || (p[0] === "sx" ? "default" : "");
      });
      window.applyFilter();
      window.showBrowse("Duyệt Tìm", true);
    }
    gotoPage(query.trang);
  }
  function restoreSearch(q, trang, query) {
    var d = $("search-input"), m = $("search-overlay-input");
    if (d) d.value = q;
    if (m) m.value = q;
    window.doSearch();
    var f = {};
    FILTERS.forEach(function (p) { f[p[0]] = (query && query[p[0]]) || ""; });
    if (hasFilters(f)) {
      FILTERS.forEach(function (p) {
        var e = $(p[1]);
        if (e) e.value = f[p[0]] || (p[0] === "sx" ? "default" : "");
      });
      window.applyFilter();               // giữ từ khoá, lọc thêm theo URL
      try { if (typeof fpSync === "function") fpSync(); } catch (e) {}
    }
    gotoPage(trang);
  }
  function gotoPage(trang) {
    var pg = parseInt(trang, 10);
    if (!(pg > 1)) return;
    if (typeof bList !== "undefined" && typeof PER !== "undefined") pg = Math.min(pg, Math.ceil(bList.length / PER) || 1);
    if (pg > 1) window.goPg(pg);
  }

  function applyRoute(route) {
    var p = parse(route), parts = p.parts, head = parts[0] || "";
    if (head === "phim" && parts[1]) {
      // mới: phim/<ten>/tap-n/svk ; cũ: phim/<id>/<ten>/tap-n/svk
      var legacy = parts.length > 2 && !/^tap-\d+$/.test(parts[2]);
      var o = legacy ? 3 : 2;
      var em = /^tap-(\d+)$/.exec(parts[o] || "");
      openDetailFromRoute(parts[1], 0, em ? +em[1] : null, em ? (SV_IN[parts[o + 1]] || null) : null);
      return;
    }
    applying++;
    try {
      if (detailOpen()) { detailPushed = false; expectId = null; window.closeDetail(); }
      if (route === baseRoute) return; // trang nền đang hiển thị đúng rồi
      var ok = true;
      if (head === "phim-le" || head === "phim-bo") {
        var q1 = qWith({ loai: head === "phim-le" ? "movie" : "series" }, p.query);
        restoreBrowse(q1); syncNav("browse", q1);
      } else if ((head === "the-loai" || head === "quoc-gia" || head === "ngon-ngu") && parts[1]) {
        var q2 = qWith({}, p.query);
        q2[head] = valOf(head, parts[1]);
        restoreBrowse(q2); syncNav("browse", q2);
      } else if (head === "nam" && parts[1]) {
        var q3 = qWith({ nam: parts[1] }, p.query);
        restoreBrowse(q3); syncNav("browse", q3);
      } else if (head === "duyet-tim") { restoreBrowse(p.query); syncNav("browse", p.query); }
      else if (head === "tim-kiem" && parts[1]) { restoreSearch(parts[1], p.query.trang, p.query); syncNav("search"); }
      else if (ME_ROUTES[head]) {
        if (typeof isLoggedIn === "function" && isLoggedIn()) { window.openMe(ME_ROUTES[head]); syncNav("me"); }
        else { ok = false; window.showHome(); syncNav("home"); setRoute("", "replace"); } // chưa đăng nhập
      } else {
        window.showHome(); syncNav("home");
        if (route) { ok = false; setRoute("", "replace"); } // đường dẫn lạ -> về trang chủ
      }
      if (ok) baseRoute = route || "";
    } finally { applying--; }
  }

  /* ---------- mở link kiểu cũ có # khi trang đang mở sẵn ---------- */
  window.addEventListener("hashchange", function () {
    if (booting) return;
    var h = hashRoute();
    if (!h) return;                       // #access_token=... của Google vẫn để yên
    migrateHash();
    try { applyRoute(h); } catch (e) { console.error("[router] lỗi hashchange:", e); }
  });

  /* ---------- nút Back / Forward ---------- */
  window.addEventListener("popstate", function () {
    if (booting) return;
    try { applyRoute(currentRoute()); } catch (e) { console.error("[router] lỗi popstate:", e); }
  });

  /* ---------- khôi phục URL sau khi app tải xong ---------- */
  function ready() {
    if (!booting) return;
    booting = false;
    migrateHash();  // link kiểu cũ #/phim/... -> /phim/...
    try { applyRoute(currentRoute()); } catch (e) { console.error("[router] lỗi khôi phục URL:", e); uncover(); }
    if (currentRoute().indexOf("/phim/") !== 0) uncover();
  }
  var origInit = window.initApp;
  if (typeof origInit === "function") {
    // nếu initApp chưa chạy xong khi router nạp, đợi nó hoàn tất rồi mới khôi phục
    window.initApp = function () {
      var r = origInit.apply(this, arguments);
      Promise.resolve(r).then(ready, ready);
      return r;
    };
  }
  // Dự phòng: initApp có thể đã được gọi trước khi router.js nạp -> theo dõi trạng thái thực tế
  var waited = 0;
  (function waitReady() {
    if (!booting) return;
    var ls = $("loading-screen");
    var gone = !ls || ls.classList.contains("hide") || ls.style.display === "none";
    if ((typeof MOVIES !== "undefined" && MOVIES.length > 1 && gone) || waited > 30000) { ready(); return; }
    waited += 250;
    setTimeout(waitReady, 250);
  })();
})();
