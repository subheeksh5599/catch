// The share card image, 1200x630, drawn from shareData (see _share.mjs).
import { ImageResponse } from "@vercel/og";
import { shareData } from "./_share.mjs";

const C = { bg: "#000814", card: "#010d1e", fg: "#ffffff", muted: "#8d9198", primary: "#1c6cff", border: "#11263b", up: "#22c55e", down: "#ff5c4d" };
const MARK =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#1c6cff" fill-rule="evenodd" d="M 21.76 0 C 25.344 0 27.137 0 28.506 0.697 C 29.71 1.311 30.689 2.29 31.303 3.494 C 32 4.863 32 6.656 32 10.24 L 32 21.76 C 32 25.344 32 27.137 31.303 28.506 C 30.689 29.71 29.71 30.689 28.506 31.303 C 27.137 32 25.344 32 21.76 32 L 10.24 32 C 6.656 32 4.863 32 3.494 31.303 C 2.29 30.689 1.311 29.71 0.697 28.506 C 0 27.137 0 25.344 0 21.76 L 0 10.24 C 0 6.656 0 4.863 0.697 3.494 C 1.311 2.29 2.29 1.311 3.494 0.697 C 4.863 0 6.656 0 10.24 0 Z M 8 14 L 8 19 C 8 23.4 11.6 26 16 26 C 20.4 26 24 23.4 24 19 L 24 14 L 20.8 14 L 20.8 19 C 20.8 21.6 18.6 22.8 16 22.8 C 13.4 22.8 11.2 21.6 11.2 19 L 11.2 14 Z M 18.5 9 A 2.5 2.5 0 0 0 13.5 9 A 2.5 2.5 0 0 0 18.5 9 Z"/></svg>',
  );

const h = (type, style, children) => ({ type, props: { style: { display: "flex", ...style }, children } });

function card(d) {
  const tone = d.headline.startsWith("+") ? C.up : d.headline.startsWith("−") ? C.down : C.fg;
  return h("div", { width: "100%", height: "100%", background: C.bg, color: C.fg, flexDirection: "column", padding: "56px 64px", fontFamily: "sans-serif" }, [
    h("div", { alignItems: "center", gap: 16 }, [
      { type: "img", props: { src: MARK, width: 44, height: 44 } },
      h("div", { fontSize: 30, fontWeight: 700, letterSpacing: 6 }, "CATCH"),
      h("div", { marginLeft: "auto", fontSize: 22, color: C.muted }, "dreamDEX perps · Somnia"),
    ]),
    h("div", { marginTop: 56, fontSize: 26, color: C.primary, textTransform: "uppercase", letterSpacing: 3 }, d.eyebrow),
    h("div", { marginTop: 14, fontSize: 76, fontWeight: 700, color: tone, lineHeight: 1.05 }, d.headline),
    h("div", { marginTop: 22, fontSize: 26, color: C.muted, lineHeight: 1.35, maxWidth: 1040 }, d.sub),
    h(
      "div",
      { marginTop: "auto", gap: 18 },
      d.stats.map(([k, v]) =>
        h("div", { flexDirection: "column", flex: 1, background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, padding: "16px 22px" }, [
          h("div", { fontSize: 20, color: C.muted }, k),
          h("div", { fontSize: 32, fontWeight: 600, marginTop: 6 }, v),
        ]),
      ),
    ),
  ]);
}

function empty() {
  return h("div", { width: "100%", height: "100%", background: C.bg, color: C.fg, alignItems: "center", justifyContent: "center", gap: 24, fontFamily: "sans-serif" }, [
    { type: "img", props: { src: MARK, width: 72, height: 72 } },
    h("div", { fontSize: 64, fontWeight: 700, letterSpacing: 8 }, "CATCH"),
  ]);
}

export default async function handler(req, res) {
  try {
    const u = new URL(req.url, "http://x");
    const d = await shareData(u.searchParams.get("kind"), u.searchParams.get("id")).catch(() => null);
    const img = new ImageResponse(d ? card(d) : empty(), { width: 1200, height: 630 });
    const buf = Buffer.from(await img.arrayBuffer());
    res.statusCode = 200;
    res.setHeader("content-type", "image/png");
    res.setHeader("cache-control", d?.kind === "depositor" ? "public, s-maxage=300" : "public, s-maxage=3600, stale-while-revalidate=86400");
    res.end(buf);
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "text/plain");
    res.end(String(e?.message || e).slice(0, 300));
  }
}
