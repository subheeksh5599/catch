import { service, cached, send, fail } from "./_lib.mjs";
export default async function handler(req, res) {
  try {
    const s = await service();
    await cached("head", 5_000, async () => { try { s.head = await s.client.getBlockNumber(); } catch {} });
    send(res, s.status(), 5);
  } catch (e) { fail(res, e); }
}
