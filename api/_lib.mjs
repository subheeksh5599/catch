// Shared state for the Vercel functions. A warm instance keeps one CatchService and reuses
// results for a short time; the CDN caches responses (see each route's Cache-Control).
import { CatchService } from "../engine/src/service.mjs";

let svc = null;
let ready = null;
const memo = new Map();

export async function service() {
  if (!svc) {
    svc = new CatchService(process.env.NETWORK || "hideki", () => {});
    ready = svc.init();
  }
  await ready;
  return svc;
}

/** Run fn at most once per ttl ms per key on this instance. */
export async function cached(key, ttl, fn) {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  const pending = hit?.pending;
  if (pending) return pending;
  const p = fn().then((value) => { memo.set(key, { at: Date.now(), value }); return value; })
    .catch((e) => { memo.delete(key); throw e; });
  memo.set(key, { ...(hit || { at: 0 }), pending: p });
  return p;
}

export function send(res, body, sMaxAge = 30) {
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", `public, s-maxage=${sMaxAge}, stale-while-revalidate=86400`);
  res.setHeader("access-control-allow-origin", "*");
  res.status(200).end(JSON.stringify(body));
}

export function fail(res, e) {
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.status(502).end(JSON.stringify({ error: (e?.shortMessage || e?.message || String(e)).slice(0, 300) }));
}

/** Snapshot every market, a few at a time, busiest first, within a time budget. Markets not
 *  reached keep their previous snapshot (warm instance) and are picked up by the next request;
 *  a market already being read is never started twice. */
const inFlight = new Map();
const mappedAt = new Map();
export async function mapAll(s, { concurrency = 3, budgetMs = Number(process.env.MAP_BUDGET_MS || 200_000) } = {}) {
  // never-mapped markets first (busiest first among them), then the stalest
  const list = s.order().map((m, rank) => ({ m, rank })).sort((a, b) => (mappedAt.get(a.m.pool) ?? -1e15 + a.rank) - (mappedAt.get(b.m.pool) ?? -1e15 + b.rank)).map((x) => x.m);
  let i = 0;
  const worker = async () => {
    while (i < list.length) {
      const m = list[i++];
      if (!inFlight.has(m.pool)) {
        inFlight.set(m.pool, s.snapshot(m.pool).then(() => mappedAt.set(m.pool, Date.now())).catch((e) => s.note(`snapshot ${m.symbol}`, e)).finally(() => inFlight.delete(m.pool)));
      }
      await inFlight.get(m.pool);
    }
  };
  const all = Promise.all(Array.from({ length: concurrency }, worker));
  await Promise.race([all, new Promise((r) => setTimeout(r, budgetMs))]);
}
