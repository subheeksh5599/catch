// GET /api/check?address=0x… : every open dreamDEX perp position of that account, with what the
// book holds inside the window its liquidation would be closed in. Read live, cached 15 s.
import { service, cached, send, fail } from "./_lib.mjs";
import { checkAccount, isAddress } from "../engine/src/check.mjs";

export default async function handler(req, res) {
  try {
    const a = new URL(req.url, "http://x").searchParams.get("address") || "";
    if (!isAddress(a)) {
      res.setHeader("content-type", "application/json");
      return res.status(400).end(JSON.stringify({ error: "address must be a 0x… account" }));
    }
    const s = await service();
    send(res, await cached(`check:${a.toLowerCase()}`, 15_000, () => checkAccount(s, a)), 15);
  } catch (e) { fail(res, e); }
}
