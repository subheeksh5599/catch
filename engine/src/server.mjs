// HTTP API + static hosting for the landing page (/) and the dashboard (/app/).
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { CatchService } from "./service.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SITE = join(ROOT, "site");
const APP = join(ROOT, "app");
const PORT = Number(process.env.PORT || 8787);
const NETWORK = process.env.NETWORK || "hideki";

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ico": "image/x-icon", ".avif": "image/avif", ".mp4": "video/mp4",
};

const svc = new CatchService(NETWORK, (m) => console.log(new Date().toISOString(), m));

function send(res, code, body, type = "application/json") {
  const data = type === "application/json" ? JSON.stringify(body) : body;
  res.writeHead(code, { "content-type": type, "cache-control": "no-store", "access-control-allow-origin": "*" });
  res.end(data);
}

async function serveFile(res, base, rel) {
  const target = normalize(join(base, rel));
  if (!target.startsWith(base)) return send(res, 403, { error: "forbidden" });
  let file = target;
  try {
    const st = await stat(file);
    if (st.isDirectory()) file = join(file, "index.html");
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    send(res, 404, "not found", "text/plain");
  }
}

const routes = {
  "/api/status": () => svc.status(),
  "/api/markets": () => svc.marketsSummary(),
  "/api/liquidations": () => svc.liquidations,
  "/api/vault": () => ({ deployment: svc.deployment, state: svc.vault, events: svc.vaultEvents ?? [] }),
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  try {
    if (routes[p]) return send(res, 200, routes[p]());
    if (p.startsWith("/api/map/")) {
      const pool = p.slice("/api/map/".length).toLowerCase();
      const m = svc.maps.get(pool);
      if (!m) {
        if (!svc.markets.has(pool)) return send(res, 404, { error: "unknown market" });
        await svc.snapshot(pool);
      }
      return send(res, 200, svc.maps.get(pool));
    }
    if (p.startsWith("/api/")) return send(res, 404, { error: "no such route" });
    if (p === "/app") return res.writeHead(301, { location: "/app/" }).end();
    if (p.startsWith("/app/")) return serveFile(res, APP, p.slice(5) || "index.html");
    return serveFile(res, SITE, decodeURIComponent(p));
  } catch (e) {
    svc.note(`request ${p}`, e);
    send(res, 500, { error: e.message });
  }
});

async function loop(name, fn, everyMs) {
  for (;;) {
    try {
      await fn();
    } catch (e) {
      svc.note(name, e);
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

await svc.init();
server.listen(PORT, () => console.log(`catch engine on http://127.0.0.1:${PORT} (${svc.net.label}, ${svc.markets.size} markets)`));
loop("vault", () => svc.refreshVault(), 10_000);
loop("liquidations", () => svc.refreshLiquidations(), 20_000);
loop("markets", () => svc.refreshMarkets(), 30_000);
loop("snapshot", () => svc.snapshotNext(), 1_000);
