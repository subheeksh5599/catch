import { service, cached, send, fail } from "../_lib.mjs";
export default async function handler(req, res) {
  try {
    const pool = String(req.query.pool || "").toLowerCase();
    const s = await service();
    if (!s.markets.has(pool)) return res.status(404).json({ error: "unknown market" });
    await cached(`map:${pool}`, 30_000, () => s.snapshot(pool));
    send(res, s.maps.get(pool), 30);
  } catch (e) { fail(res, e); }
}
