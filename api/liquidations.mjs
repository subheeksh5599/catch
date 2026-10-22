import { service, cached, send, fail } from "./_lib.mjs";
export default async function handler(req, res) {
  try {
    const s = await service();
    await cached("liquidations", 20_000, () => s.refreshLiquidations());
    send(res, s.liquidations, 30);
  } catch (e) { fail(res, e); }
}
