/* =====================================================================
   router.js — Định tuyến bằng hash (#/...) cho Nhót Phim
   Đặt file này cạnh index.html và thêm ngay trước </body>:
       <script src="router.js"></script>

   Các đường dẫn:
     (không có đuôi)                      Trang chủ
     #phim/<id>/<ten-phim>/tap-<n>        Đang xem một phim (tập n)
     #/duyet-tim?loai=series&quoc-gia=kr&the-loai=action&nam=2025&sx=rating&trang=2
                                          Trang duyệt / lọc (mọi tham số đều tùy chọn)
     #/tim-kiem/<tu-khoa>?trang=2         Kết quả tìm kiếm
     #/tai-khoan  #/yeu-thich  #/danh-sach  #/xem-tiep     Trang cá nhân

   Dùng hash nên chạy được trên GitHub Pages / Live Server (đường dẫn thật như
   /phim/abc sẽ 404 khi F5) và không đụng tới ?code= / #access_token= của đăng nhập Google.
   Không cần sửa gì khác trong index.html: file tự "bọc" các hàm có sẵn
   (openPlayer, closeDetail, showHome, showBrowse, filterBy..., doSearch, goPg, openMe).
   ===================================================================== */
(function () {
  "use strict";

  /* ---------- lớp phủ chống nháy trang chủ khi F5 ở trang phim ---------- */
  var bootCover = null;
  function uncover() {
    if (!bootCover) return;
    var c = bootCover; bootCover = null;
    try { c.style.opacity = "0"; setTimeout(function () { if (c.parentNode) c.parentNode.removeChild(c); }, 250); } catch (e) {}
  }
  function uncoverWhenOpen(tries) {
    if (!bootCover) return;
    if (shown("detail-page") || (tries || 0) > 60) { setTimeout(uncover, 300); return; }
    setTimeout(function () { uncoverWhenOpen((tries || 0) + 1); }, 100);
  }
  if (/^#\/*phim\//.test(location.hash || "")) {
    try {
      bootCover = document.createElement("div");
      bootCover.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:#0d0d0d;color:#aaa;" +
        "display:flex;align-items:center;justify-content:center;font:15px sans-serif;transition:opacity .25s";
      bootCover.textContent = "Đang tải...";
      document.documentElement.appendChild(bootCover);
      setTimeout(uncover, 15000); // an toàn: tối đa 15 giây
    } catch (e) { bootCover = null; }
  }

  var baseTitle = document.title;
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
    ["loai", "f-type"], ["quoc-gia", "f-country"], ["the-loai", "f-genre"], ["nam", "f-year"], ["sx", "f-sort"]
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
  // URL mới: #phim/414/ten-phim/tap-3 (không còn "/" sau dấu #). Link cũ #/phim/... vẫn đọc được.
  function currentRoute() {
    var h = (location.hash || "").replace(/^#\/*/, "");
    return h ? "/" + h : "";
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

  // Tập đang xem: app lưu chỉ số (từ 0) ở window._seriesCurrentEpIndex -> số tập = chỉ số + 1
  function getEp() {
    var m = findMovie(typeof _currentWatchMovieId !== "undefined" ? _currentWatchMovieId : null);
    if (!m || m.type !== "series") return null;
    var i = window._seriesCurrentEpIndex;
    return (typeof i === "number" && i >= 0) ? i + 1 : null;
  }
  // Chuyển tới tập n bằng playEpisode(kind, idx) của app. Trả về true nếu thành công.
  function setEp(n) {
    if (typeof playEpisode !== "function" || typeof EP_KINDS === "undefined") return false;
    var idx = n - 1, kinds = Object.keys(EP_KINDS), order = [];
    // ưu tiên server đang hiển thị
    var vis = document.querySelector('#dp-episodes [id^="ep-list-"]:not([style*="display: none"])');
    if (vis) { var k0 = vis.id.replace("ep-list-", ""); if (EP_KINDS[k0]) order.push(k0); }
    kinds.forEach(function (k) { if (order.indexOf(k) < 0) order.push(k); });
    for (var i = 0; i < order.length; i++) {
      var k = EP_KINDS[order[i]], arr = (k.arr && k.arr()) || [];
      if (arr[idx] && arr[idx][k.field]) {
        try { if (playEpisode(order[i], idx)) return true; } catch (e) {}
      }
    }
    return false;
  }
  function watchRoute(m, ep) {
    return "/phim/" + encodeURIComponent(m.id) + "/" + slug(m.title) + (ep ? "/tap-" + ep : "");
  }
  function applyEpWhenReady(n, tries) {
    if (!n) { pendingEp = null; return; }
    tries = tries || 0;
    if (getEp() === n || setEp(n) || tries > 20) { setTimeout(function () { pendingEp = null; }, 800); return; }
    setTimeout(function () { applyEpWhenReady(n, tries + 1); }, 500);
  }
  // Khi người xem đổi tập -> cập nhật URL (thay thế, không thêm lịch sử)
  setInterval(function () {
    if (booting || applying || pendingEp || !detailOpen()) return;
    var m = findMovie(typeof _currentWatchMovieId !== "undefined" ? _currentWatchMovieId : null);
    if (!m) return;
    var ep = getEp(), route = watchRoute(m, ep);
    if (currentRoute() !== route && currentRoute().indexOf("/phim/") === 0) {
      navigate(route, "replace", { d: !!(history.state && history.state.d) });
      try { document.title = (m.title || "") + (ep ? " - Tập " + ep : "") + " - " + baseTitle; } catch (e) {}
    }
  }, 700);

  /* ---------- ghi lịch sử trình duyệt ---------- */
  function setRoute(route, mode, extra) {
    route = route || "";
    if (currentRoute() === route && (route || !location.hash)) return;
    var state = { np: route };
    if (extra && extra.d) state.d = 1;
    try {
      var url = location.pathname + location.search + (route ? "#" + route.replace(/^\/+/, "") : "");
      if (mode === "push") history.pushState(state, "", url);
      else history.replaceState(state, "", url);
    } catch (e) { /* trình duyệt chặn history API -> bỏ qua, app vẫn chạy bình thường */ }
  }
  function navigate(route, mode, extra) {
    if (booting || applying) return;
    setRoute(route, mode, extra);
  }

  /* ---------- dựng đường dẫn ---------- */
  function browseRoute(f, page) {
    var q = [];
    FILTERS.forEach(function (p) {
      var v = f && f[p[0]];
      if (v && !(p[0] === "sx" && v === "default")) q.push(p[0] + "=" + encodeURIComponent(v));
    });
    if (page > 1) q.push("trang=" + page);
    return "/duyet-tim" + (q.length ? "?" + q.join("&") : "");
  }
  function searchRoute(q, page) {
    return "/tim-kiem/" + encodeURIComponent(q) + (page > 1 ? "?trang=" + page : "");
  }
  function filtersFromSelects() {
    var f = {};
    FILTERS.forEach(function (p) { var e = $(p[1]); f[p[0]] = e ? e.value : ""; });
    return f;
  }

  /* ---------- đánh dấu mục menu đang chọn ---------- */
  function syncNav(kind, query) {
    var label = null;
    if (kind === "home") label = "Trang Chủ";
    else if (kind === "browse" && query) {
      var keys = Object.keys(query).filter(function (k) {
        return k !== "trang" && query[k] && !(k === "sx" && query[k] === "default");
      });
      if (keys.length === 1) {
        if (keys[0] === "loai") label = query.loai === "movie" ? "Phim Lẻ" : query.loai === "series" ? "Phim Bộ" : null;
        else if (keys[0] === "the-loai") label = NAV_GENRE_LABEL[query["the-loai"]] || null;
      }
    }
    var found = null;
    Array.prototype.forEach.call(document.querySelectorAll(".nav-link"), function (l) {
      if (label && l.textContent.trim() === label) found = l;
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
    pageTitle = ((t && t.textContent) || "Duyệt Tìm") + " - " + baseTitle;
    try { document.title = pageTitle; } catch (e) {}
    navigate(route, "push");
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
    browseState = { q: null, f: f, page: 1 };
    baseRoute = browseRoute(f, 1);
    if (!applying && shown("page-browse")) navigate(baseRoute, "replace");
  });
  // Chuyển trang kết quả
  wrap("goPg", null, function () {
    if (!browseState) return;
    browseState.page = (typeof bPage !== "undefined") ? bPage : 1;
    baseRoute = browseState.q != null ? searchRoute(browseState.q, browseState.page) : browseRoute(browseState.f, browseState.page);
    navigate(baseRoute, "push");
  });

  // Trang nền: tài khoản / yêu thích / danh sách / xem tiếp
  wrap("openMe", null, function (section) {
    if (!shown("page-me")) return; // chưa đăng nhập -> hàm gốc đã bật khung đăng nhập
    var route = ME_PATHS[section || "account"] || ME_PATHS.account;
    baseRoute = route;
    pageTitle = (section === "favs" ? "Yêu thích" : section === "list" ? "Danh sách" : section === "continue" ? "Xem tiếp" : "Tài khoản") + " - " + baseTitle;
    try { document.title = pageTitle; } catch (e) {}
    navigate(route, "push");
  });

  // Mở phim
  wrap("_openPlayerCore", function (id) {
    var m = findMovie(id);
    if (!m) return;
    try { document.title = (m.title || "") + " - " + baseTitle; } catch (e) {}
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
    if (detailPushed) { detailPushed = false; history.back(); }   // quay lại đúng mục lịch sử trước đó
    else navigate(baseRoute, "replace");                          // vào thẳng bằng link / F5 -> chỉ thay URL
  });

  /* ---------- áp dụng URL lên giao diện ---------- */
  function openDetailFromRoute(idStr, tries, ep) {
    var m = findMovie(idStr);
    if (m) {
      if (detailOpen() && String(_currentWatchMovieId) === String(m.id)) {
        if (ep && getEp() !== ep) { pendingEp = ep; applyEpWhenReady(ep); }
        return;
      }
      expectId = m.id;
      expectPushed = !!(history.state && history.state.d);
      clearTimeout(expectTimer);
      expectTimer = setTimeout(function () { expectId = null; }, 10000);
      pendingEp = ep || null;
      window.openPlayer(m.id);
      uncoverWhenOpen(0);
      if (ep) setTimeout(function () { applyEpWhenReady(ep); }, 400);
      return;
    }
    // Danh sách phim chưa có (đang dùng bản lưu cũ / mạng chậm): thử lại vài lần
    if ((tries || 0) < 3) { setTimeout(function () { openDetailFromRoute(idStr, (tries || 0) + 1, ep); }, 2500); return; }
    uncover();
    setRoute("", "replace"); // không tìm thấy phim (đã xóa?) -> bỏ đuôi, ở lại trang chủ
  }

  function restoreBrowse(query) {
    var f = {};
    FILTERS.forEach(function (p) { f[p[0]] = query[p[0]] || ""; });
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
  function restoreSearch(q, trang) {
    var d = $("search-input"), m = $("search-overlay-input");
    if (d) d.value = q;
    if (m) m.value = q;
    window.doSearch();
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
      var em = /^tap-(\d+)$/.exec(parts[3] || "");
      openDetailFromRoute(parts[1], 0, em ? +em[1] : null);
      return;
    }
    applying++;
    try {
      if (detailOpen()) { detailPushed = false; expectId = null; window.closeDetail(); }
      if (route === baseRoute) return; // trang nền đang hiển thị đúng rồi
      var ok = true;
      if (head === "duyet-tim") { restoreBrowse(p.query); syncNav("browse", p.query); }
      else if (head === "tim-kiem" && parts[1]) { restoreSearch(parts[1], p.query.trang); syncNav("search"); }
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

  /* ---------- nút Back / Forward ---------- */
  window.addEventListener("popstate", function () {
    if (booting) return;
    try { applyRoute(currentRoute()); } catch (e) { console.error("[router] lỗi popstate:", e); }
  });

  /* ---------- khôi phục URL sau khi app tải xong ---------- */
  function ready() {
    if (!booting) return;
    booting = false;
    if (!currentRoute() && location.hash) setRoute("", "replace"); // "#" / "#/" thừa -> xóa
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
