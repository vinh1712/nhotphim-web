/* =====================================================================
   router.js — Định tuyến bằng hash (#/...) cho Nhót Phim
   - Mở phim      -> #/phim/<id>/<ten-phim>   (F5 vẫn ở lại đúng phim)
   - Trang duyệt  -> #/duyet-tim
   - Trang chủ    -> (không có đuôi)
   Cách dùng: đặt file này cạnh index.html và thêm DÒNG NÀY ngay trước </body>:
       <script src="router.js"></script>
   Không cần sửa gì khác trong index.html: file tự "bọc" các hàm openPlayer/closeDetail/
   showHome/showBrowse đã có sẵn. Dùng hash nên chạy được trên GitHub Pages/Live Server
   (đường dẫn thật như /phim/abc sẽ 404 khi F5), và không đụng #access_token của đăng nhập Google.
   ===================================================================== */
(function () {
  "use strict";

  var booting = true;       // chưa khôi phục xong -> chưa được ghi đè URL
  var restoreMode = false;  // lần mở phim kế tiếp là khôi phục từ URL -> không push thêm lịch sử
  var baseTitle = document.title;

  function slug(str) {
    return normalizeStr(String(str || "")).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  }
  function currentRoute() {
    var h = location.hash || "";
    return h.indexOf("#/") === 0 ? h.slice(1) : "";
  }
  function setRoute(path, mode) {
    if (booting) return;
    path = path || "";
    if (currentRoute() === path) return;
    try {
      var url = location.pathname + location.search + (path ? "#" + path : "");
      if (mode === "push") history.pushState({ np: path }, "", url);
      else history.replaceState({ np: path }, "", url);
    } catch (e) { /* trình duyệt chặn history API -> bỏ qua, app vẫn chạy bình thường */ }
  }
  function detailOpen() {
    var dp = document.getElementById("detail-page");
    return !!dp && dp.style.display !== "none" && dp.style.display !== "";
  }
  function findMovie(idStr) {
    return (typeof MOVIES !== "undefined" ? MOVIES : []).find(function (x) { return String(x.id) === String(idStr); });
  }
  function routeWatch(m) {
    var mode = (restoreMode || detailOpen()) ? "replace" : "push"; // đang mở sẵn phim khác -> chỉ thay URL
    restoreMode = false;
    setRoute("/phim/" + encodeURIComponent(m.id) + "/" + slug(m.title), mode);
    try { document.title = (m.title || "") + " - " + baseTitle; } catch (e) {}
  }
  function unwatch() {
    if (booting) return;
    try { document.title = baseTitle; } catch (e) {}
    if (currentRoute().indexOf("/phim/") === 0) setRoute("", "replace");
  }

  // Mở lại phim theo URL; nếu danh sách phim chưa có (đang dùng cache cũ) thì thử lại vài lần.
  function openFromRoute(idStr, tries) {
    var m = findMovie(idStr);
    if (m) {
      restoreMode = true;
      setTimeout(function () { restoreMode = false; }, 10000);
      openPlayer(m.id);
      return;
    }
    if ((tries || 0) < 3) { setTimeout(function () { openFromRoute(idStr, (tries || 0) + 1); }, 2500); return; }
    setRoute("", "replace"); // không tìm thấy phim (đã xóa?) -> bỏ đuôi, ở lại trang chủ
  }
  function restoreRoute() {
    booting = false;
    var parts = currentRoute().split("/").filter(Boolean);
    if (!parts.length) return;
    if (parts[0] === "phim" && parts[1]) openFromRoute(decodeURIComponent(parts[1]), 0);
    else if (parts[0] === "duyet-tim") showBrowse("Duyệt Tìm");
  }

  // ---- Bọc các hàm có sẵn (không cần sửa index.html) ----
  function wrap(name, before) {
    var orig = window[name];
    if (typeof orig !== "function") { console.warn("[router] không tìm thấy hàm", name); return; }
    window[name] = function () {
      try { before.apply(null, arguments); } catch (e) { console.warn("[router]", name, e); }
      return orig.apply(this, arguments);
    };
  }
  wrap("_openPlayerCore", function (id) { var m = findMovie(id); if (m) routeWatch(m); });
  wrap("closeDetail", function () { unwatch(); });
  wrap("showHome", function () { setRoute("", "push"); });
  wrap("showBrowse", function () { setRoute("/duyet-tim", "push"); });

  // Nút Back/Forward của trình duyệt
  window.addEventListener("popstate", function () {
    if (booting) return;
    var parts = currentRoute().split("/").filter(Boolean);
    if (parts[0] === "phim" && parts[1]) {
      var id = decodeURIComponent(parts[1]);
      if (!detailOpen() || String(_currentWatchMovieId) !== String(id)) openFromRoute(id, 0);
      return;
    }
    if (detailOpen()) closeDetail();
    var br = document.getElementById("page-browse");
    var browseShown = !!br && br.style.display !== "none";
    if (parts[0] === "duyet-tim" && !browseShown) showBrowse("Duyệt Tìm");
    else if (!parts.length && browseShown) showHome();
  });

  // Chờ app tải xong danh sách phim + tắt màn hình loading rồi mới khôi phục từ URL (tối đa ~30s).
  var waited = 0;
  (function waitReady() {
    var ls = document.getElementById("loading-screen");
    var loadingGone = !ls || ls.classList.contains("hide") || ls.style.display === "none";
    var hasMovies = typeof MOVIES !== "undefined" && MOVIES.length > 0;
    if ((hasMovies && loadingGone) || waited > 30000) {
      try { restoreRoute(); } catch (e) { booting = false; console.error("[router] lỗi khôi phục URL:", e); }
      return;
    }
    waited += 250;
    setTimeout(waitReady, 250);
  })();
})();
