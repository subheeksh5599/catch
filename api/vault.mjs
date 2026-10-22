import { service, cached, send, fail } from "./_lib.mjs";
export default async function handler(req, res) {
  try {
    const s = await service();
    await cached("vault", 10_000, () => s.refreshVault());
    send(res, { deployment: s.deployment, state: s.vault, events: s.vaultEvents ?? [] }, 10);
  } catch (e) { fail(res, e); }
}
