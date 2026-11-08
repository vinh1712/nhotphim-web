#!/usr/bin/env node
/* =====================================================================
   gen-movie-pages.mjs — Sinh HTML TĨNH cho từng link phim
   ---------------------------------------------------------------------
   GitHub Pages không có rewrite: /phim/<ten>/tap-1/sv3 nếu không có file
   thật sẽ trả 404 -> crawler (Messenger/Facebook/Zalo) chỉ đọc được 404.html
   (og-tag chung của site). Script này tạo file index.html cho TỪNG đường
   dẫn phim với og:title / og:description / og:image riêng của phim đó.

   Chạy:   node gen-movie-pages.mjs
   Output: thư mục phim/ cạnh file này (xóa cũ, sinh mới hoàn toàn)

   - Slug, format tiêu đề/mô tả SAO Y hệt router.js + share-og trong index.html
     -> link tĩnh và link trong app luôn trùng nhau.
   - Ảnh og:image kiểm tra bằng UA facebookexternalhit: backdrop -> poster ->
     og-image.png (bỏ qua URL hỏng để Facebook không bị lỗi tải ảnh).
   - Trình duyệt mở file tĩnh -> nhảy sang #/phim/... -> router.js mở phim rồi
     tự chuyển lại URL thật. Crawler KHÔNG chạy JS nên chỉ thấy các thẻ og:.

   Sau khi thêm/sửa phim ở trang quản lí: chạy lại script này rồi push. */
import { writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SITE = "https://nhotphim.online";
const SB = "https://tlbumpjugtltznzuwqwt.supabase.co";
// Key anon PUBLIC — cũng nằm nguyên trong index.html của trang web.
const KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRsYnVtcGp1Z3RsdHpuenV3cXd0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgyNjc0NDksImV4cCI6MjA5Mzg0MzQ0OX0.EMgx5_nREnfjZaIaLwU9q_KknbnqdxA2fbic_G_Xfdc";
const OG_FALLBACK = SITE + "/og-image.png";
const SVS = ["sv1", "sv2", "sv3", "m3u8"]; // 4 tên server trên URL (router.js SV_OUT)
const IMG_UA = "facebookexternalhit/1.1";

/* ================= tiện ích text (sao y index.html) ================= */
const plain = (s) =>
  String(s || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
const clip = (s, n) =>
  s.length > n ? s.slice(0, n - 1).replace(/[\s,.;:|/-]+$/, "") + "…" : s;
const esc = (s) =>
  String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/* ================= slug (sao y router.js) ================= */
function normalizeStr(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}
function slug(str) {
  return normalizeStr(String(str || ""))
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
function slugIndex(all) {
  const raw = new Array(all.length),
    cnt = Object.create(null),
    cntY = Object.create(null);
  let i, s, k, m, r;
  for (i = 0; i < all.length; i++) {
    s = slug(all[i].title);
    raw[i] = s;
    if (s) {
      cnt[s] = (cnt[s] || 0) + 1;
      k = s + "\u0000" + typeof all[i].year + all[i].year;
      cntY[k] = (cntY[k] || 0) + 1;
    }
  }
  const byId = Object.create(null);
  for (i = 0; i < all.length; i++) {
    m = all[i];
    s = raw[i];
    if (!s) r = String(m.id);
    else if (cnt[s] <= 1) r = s;
    else if (m.year && cntY[s + "\u0000" + typeof m.year + m.year] <= 1) r = s + "-" + m.year;
    else r = s + (m.year ? "-" + m.year : "") + "-" + m.id;
    byId[m.id] = r;
  }
  return byId;
}

/* ================= tiện ích chung ================= */
async function mapLimit(arr, limit, fn) {
  const out = new Array(arr.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, arr.length) }, async () => {
    while (next < arr.length) {
      const idx = next++;
      out[idx] = await fn(arr[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

/* ================= tải danh sách phim ================= */
async function fetchMovies() {
  const all = [];
  const head = `${SB}/rest/v1/movies?select=*&order=created_at.desc,id.desc&limit=1000`;
  for (let page = 0; page < 50; page++) {
    const r = await fetch(`${head}&offset=${all.length}`, {
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
    });
    if (!r.ok) throw new Error(`Supabase lỗi ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) break;
    all.push(...rows);
    if (rows.length < 1000) break;
  }
  return all;
}

/* ================= ánh xạ y hệt index.html (loadMovies) ================= */
const normQ = (v) => {
  const s = String(v || "").trim().toUpperCase();
  if (!s) return "";
  return s.indexOf("4K") !== -1 ? "4K" : "HD";
};
const smallImg = (u, size) =>
  typeof u === "string"
    ? u.replace("image.tmdb.org/t/p/original/", "image.tmdb.org/t/p/" + (size || "w780") + "/")
    : u;
function parseEpisodes(raw) {
  try {
    const e = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(e) ? e : [];
  } catch (_) {
    return [];
  }
}

/* ================= kiểm tra ảnh (UA của Facebook) ================= */
async function isImage(u) {
  if (!u || !/^https:\/\//i.test(u)) return false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 15000);
      const r = await fetch(u, {
        headers: { "User-Agent": IMG_UA, Accept: "image/*,*/*;q=0.8" },
        redirect: "follow",
        signal: ctl.signal,
      });
      clearTimeout(timer);
      const ct = (r.headers.get("content-type") || "").toLowerCase();
      const ok =
        r.status === 200 &&
        (ct.startsWith("image/") || ct.includes("octet-stream") || ct.includes("application/image"));
      try {
        if (r.body) await r.body.cancel();
      } catch (_) {}
      if (ok) return true;
    } catch (_) {}
  }
  return false;
}
async function pickImage(m) {
  const cands = [];
  if (m.backdrop) cands.push(m.backdrop); // backdrop đã qua _smallImg (giống og trong app)
  if (m.backdropHD && m.backdropHD !== m.backdrop) cands.push(m.backdropHD);
  if (m.poster) cands.push(m.poster);
  for (const u of cands) if (await isImage(u)) return u;
  return OG_FALLBACK;
}

/* ================= format og (sao y share-og trong index.html) ================= */
function ogFor(m, ep) {
  const en = m.titleEn && m.titleEn !== m.title ? " (" + m.titleEn + ")" : "";
  const name = (m.title || "") + en + (m.year ? " - " + m.year : "");
  const tag = [m.quality === "4K" || m.quality === "HD" ? m.quality : "", m.sub || ""]
    .filter(Boolean)
    .join(", ");
  const epPart = ep ? " - Tập " + ep : "";
  const lead = "Xem phim " + name + epPart + (tag ? " - " + tag : "") + ". ";
  const title = clip(name + epPart + " | Nhót Phim", 90);
  const desc = clip(lead + plain(m.desc), 200) || lead;
  return { title, desc };
}

/* ================= mẫu HTML ================= */
function pageHTML({ title, desc, img, url }) {
  return `<!doctype html>
<html lang="vi">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1.0" />
    <title>${esc(title)}</title>
    <meta name="description" content="${esc(desc)}" />
    <meta name="theme-color" content="#0d0d0d" />
    <meta property="og:site_name" content="Nhót Phim" />
    <meta property="og:type" content="video.movie" />
    <meta property="og:locale" content="vi_VN" />
    <meta property="og:url" content="${esc(url)}" />
    <meta property="og:title" content="${esc(title)}" />
    <meta property="og:description" content="${esc(desc)}" />
    <meta property="og:image" content="${esc(img)}" />
    <meta property="og:image:secure_url" content="${esc(img)}" />
    <meta property="og:image:alt" content="${esc(title)}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${esc(title)}" />
    <meta name="twitter:description" content="${esc(desc)}" />
    <meta name="twitter:image" content="${esc(img)}" />
    <link rel="canonical" href="${esc(url)}" />
    <!-- Crawler (Messenger / Facebook / Zalo) KHÔNG chạy JavaScript nên chỉ đọc
         các thẻ og: ở trên. Trình duyệt: nhảy sang #/phim/... -> router.js mở
         đúng phim rồi tự chuyển lại URL thật (replaceState), không tải lại trang. -->
    <script>
      (function () {
        var p = (location.pathname || "/").replace(/\\/+$/, "") + (location.search || "");
        location.replace("/#" + p);
      })();
    </script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body { background: #0d0d0d; color: #e8e8e8; font-family: "Be Vietnam Pro", system-ui, sans-serif; min-height: 100vh; display: flex; align-items: center; justify-content: center; text-align: center; padding: 24px; }
      .box { max-width: 460px; }
      .logo { font-size: 40px; margin-bottom: 12px; }
      h1 { font-size: 20px; font-weight: 800; background: linear-gradient(135deg, #ffe580, #f5a623 50%, #ff6b35); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; margin-bottom: 8px; }
      p { color: #888; font-size: 14px; line-height: 1.7; margin-bottom: 20px; }
      a { display: inline-block; background: linear-gradient(135deg, #f5a623, #ff7a1a); color: #000; font-weight: 800; font-size: 14px; padding: 12px 28px; border-radius: 50px; text-decoration: none; }
    </style>
  </head>
  <body>
    <div class="box">
      <div class="logo">🍅</div>
      <h1>${esc(title)}</h1>
      <p>Đang mở phim trên Nhót Phim…<br />Nếu không tự chuyển, bấm nút bên dưới.</p>
      <a href="${SITE}/">Về trang chủ</a>
      <noscript><p style="margin-top:16px">Hãy bật JavaScript để xem phim.</p></noscript>
    </div>
  </body>
</html>
`;
}

/* ================= main ================= */
async function main() {
  console.log("[1/4] Tải danh sách phim từ Supabase…");
  const rows = await fetchMovies();
  const visible = rows
    .filter((r) => r.hidden !== true)
    .map((row) => ({
      id: row.id,
      title: row.title || "",
      titleEn: row.titleen || "",
      year: row.year || "",
      type: row.type || "movie",
      quality: normQ(row.quality),
      sub: row.sub || "Vietsub",
      poster: row.poster || "",
      backdrop: smallImg(row.backdrop, "w1280") || null,
      backdropHD: row.backdrop || null,
      desc: row.description || "",
      episodes: parseEpisodes(row.episodes),
      totalEp: row.totalep || null,
    }));
  console.log(`      ${rows.length} phim trong bảng, ${visible.length} phim hiển thị (ẩn: ${rows.length - visible.length})`);

  console.log("[2/4] Tính slug (giống router.js)…");
  const byId = slugIndex(visible);
  // Trùng slug sau xử lý: trang web mở phim ĐẦU TIÊN (bySlug) -> giữ phim đầu,
  // bỏ các phim sau để file tĩnh luôn khớp với trang web.
  const usedSlug = new Map();
  const movies = [];
  const skipped = [];
  for (const m of visible) {
    const s = byId[m.id] || slug(m.title) || String(m.id);
    if (usedSlug.has(s)) {
      skipped.push(`#${m.id} "${m.title}" -> trùng slug "${s}" với #${usedSlug.get(s)}`);
      continue;
    }
    usedSlug.set(s, m.id);
    movies.push({ ...m, slug: s });
  }
  if (skipped.length) console.log("      Cảnh báo trùng slug:", skipped);

  console.log("[3/4] Kiểm tra ảnh og:image (UA facebookexternalhit)…");
  let fallbackCount = 0;
  const fallbackList = [];
  await mapLimit(movies, 10, async (m) => {
    m.ogImage = await pickImage(m);
    if (m.ogImage === OG_FALLBACK && (m.backdrop || m.poster)) {
      fallbackCount++;
      fallbackList.push(`#${m.id} "${m.title}"`);
    }
  });
  console.log(`      xong. ${fallbackCount} phim phải dùng ảnh dự phòng og-image.png`);
  if (fallbackList.length) fallbackList.forEach((x) => console.log("        - " + x));

  console.log("[4/4] Sinh file HTML tĩnh…");
  const phimDir = path.join(ROOT, "phim");
  await rm(phimDir, { recursive: true, force: true });

  let files = 0,
    bytes = 0,
    seriesCount = 0,
    episodeCount = 0;
  for (const m of movies) {
    const base = `phim/${m.slug}`;
    const isSeries = m.type === "series";
    const epCount = isSeries
      ? Math.max(1, m.totalEp || 0, m.episodes.length || 0)
      : 0;
    if (isSeries) {
      seriesCount++;
      episodeCount += epCount;
    }

    const jobs = [{ rel: base, ep: 0 }];
    for (let n = 1; n <= epCount; n++) {
      jobs.push({ rel: `${base}/tap-${n}`, ep: n });
      for (const sv of SVS) jobs.push({ rel: `${base}/tap-${n}/${sv}`, ep: n });
    }
    for (const job of jobs) {
      const og = ogFor(m, job.ep || null);
      const url = `${SITE}/${job.rel}`;
      const html = pageHTML({ title: og.title, desc: og.desc, img: m.ogImage, url });
      const abs = path.join(ROOT, job.rel, "index.html");
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, html, "utf8");
      files++;
      bytes += Buffer.byteLength(html);
    }
  }

  console.log("");
  console.log("=== XONG ===");
  console.log(`Phim: ${movies.length} (${seriesCount} phim bộ, ${movies.length - seriesCount} phim lẻ)`);
  console.log(`Tổng tập (phim bộ): ${episodeCount}`);
  console.log(`File HTML đã sinh: ${files} (~${(bytes / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`Thư mục: ${phimDir}`);
}

main().catch((e) => {
  console.error("LỖI:", e);
  process.exit(1);
});
