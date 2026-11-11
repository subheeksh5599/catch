// The page a shared link opens: X reads its tags for the preview card; a person sees the card
// and a way into the dashboard. &post=1 redirects to an X post with the text and link prefilled.
import { shareData, origin } from "./_share.mjs";

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export default async function handler(req, res) {
  const u = new URL(req.url, "http://x");
  const kind = u.searchParams.get("kind");
  const d = await shareData(kind, u.searchParams.get("id")).catch(() => null);
  const base = origin(req);
  if (!d) {
    res.statusCode = 302;
    res.setHeader("location", `${base}/app/`);
    return res.end();
  }
  const q = `kind=${encodeURIComponent(d.kind)}&id=${encodeURIComponent(d.id)}`;
  const page = `${base}/api/share?${q}`;
  if (u.searchParams.get("post")) {
    res.statusCode = 302;
    res.setHeader("location", `https://x.com/intent/post?text=${encodeURIComponent(d.text)}&url=${encodeURIComponent(page)}`);
    return res.end();
  }
  const img = `${base}/api/og?${q}`;
  const title = `${d.eyebrow}: ${d.headline}`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Catch</title>
<meta name="description" content="${esc(d.sub)}">
<meta property="og:type" content="website"><meta property="og:site_name" content="Catch">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(d.sub)}">
<meta property="og:url" content="${esc(page)}"><meta property="og:image" content="${esc(img)}">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(d.sub)}"><meta name="twitter:image" content="${esc(img)}">
<link rel="icon" href="/app/mark.svg">
<style>body{margin:0;background:#000814;color:#fff;font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh}
main{max-width:760px;padding:24px}img{width:100%;border-radius:14px;border:1px solid #11263b}
.row{display:flex;gap:12px;margin-top:18px;flex-wrap:wrap}a{color:#fff;text-decoration:none;padding:10px 16px;border-radius:10px;background:#1c6cff}
a.alt{background:transparent;border:1px solid #11263b}</style></head>
<body><main><img src="${esc(img)}" alt="${esc(title)}">
<div class="row"><a href="${esc(base)}/app/#/vault">Open Catch</a><a class="alt" href="${esc(page)}&amp;post=1">Post on X</a></div></main></body></html>`;
  res.statusCode = 200;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", d.kind === "depositor" ? "public, s-maxage=300" : "public, s-maxage=3600, stale-while-revalidate=86400");
  res.end(html);
}
