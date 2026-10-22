import { service, cached, send, fail, mapAll } from "./_lib.mjs";
export default async function handler(req, res) {
  try {
    const s = await service();
    await cached("markets", 30_000, () => s.refreshMarkets());
    await cached("maps", 60_000, () => mapAll(s));
    send(res, s.marketsSummary(), 60);
  } catch (e) { fail(res, e); }
}
