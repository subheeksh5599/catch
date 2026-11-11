// Share cards. Every number on a card is read from the vault's records or from the chain at
// request time; the URL only says which catch, which vault or which address, never a figure.
//   /api/share?kind=catch&id=<liquidation tx>     a liquidation the vault caught
//   /api/share?kind=vault&id=v4                   a vault's result for its depositors
//   /api/share?kind=depositor&id=<address>        one holder's position in the live vault
// /api/share serves the page X reads for the link preview; &post=1 redirects to an X post with
// the text prefilled; /api/og renders the 1200x630 image the page points at.
import { loadDeployment, loadRetired } from "../engine/src/service.mjs";
import { NETWORKS, publicClient, vaultAbi } from "../engine/src/chain.mjs";

const NET = process.env.NETWORK || "hideki";
const TAG = "@DreamDEXSomnia";
const isAddr = (s) => /^0x[0-9a-fA-F]{40}$/.test(s || "");
const isHash = (s) => /^0x[0-9a-fA-F]{64}$/.test(s || "");
const fmt = (n, d = 2) => Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const signed = (n, d = 1) => `${n >= 0 ? "+" : "−"}${fmt(Math.abs(n), d)}`;

export async function shareData(kind, id) {
  const dep = loadDeployment(NET);
  if (kind === "catch") {
    const catches = (dep?.evidence || []).filter((e) => e.kind === "catch" && e.status === "proven");
    const e = (isHash(id) && catches.find((x) => x.txs?.some((t) => t.tx.toLowerCase() === id.toLowerCase()))) || catches[0];
    if (!e) return null;
    const size = Math.abs(Number(e.size));
    return {
      kind,
      id: e.txs?.[0]?.tx,
      eyebrow: "Liquidation caught",
      headline: `${e.base} ${e.side} · ${size} at ${e.price}`,
      sub: "A real trader's position was force-closed into Catch's resting order. Somnia Reactivity took the position and re-offered it in the same block.",
      stats: [["Block", fmt(e.block, 0)], ["Liquidated", `${e.liquidatedAccount?.slice(0, 6)}…`], ["Vault", e.vaultTag || "live"]],
      text: `A liquidated ${e.base} ${e.side} on ${TAG} landed in Catch's resting order at ${e.price}. Somnia Reactivity took the position and offered it back in the same block, block ${e.block}.`,
    };
  }
  if (kind === "vault") {
    const r = loadRetired(NET).find((x) => x.tag === id);
    const p = r?.performance;
    if (!p || !p.deposited) return null;
    const pct = (p.result / p.deposited) * 100;
    const closes = (r.trades || []).filter((t) => t.newSize === 0);
    const wins = closes.filter((t) => t.realizedPnl > 0).length;
    return {
      kind,
      id,
      eyebrow: `Catch ${id}, retired`,
      headline: `${signed(pct)}% for depositors`,
      sub: `${fmt(p.deposited)} USDso in. Every figure is the sum of the vault's own Deposited and Redeemed events, plus what is still inside.`,
      stats: [["Result", `${signed(p.result, 2)} USDso`], ["Closed trades", closes.length ? `${wins} of ${closes.length} in profit` : "none"], ["Share price", fmt(p.lastSharePrice, 4)]],
      text: `Catch ${id} on ${TAG}: ${signed(pct)}% for its depositors. A vault that buys liquidations at the price they land, re-checked by Somnia Reactivity every block.`,
    };
  }
  if (kind === "depositor") {
    if (!isAddr(id) || !dep?.vault) return null;
    const client = publicClient(NETWORKS[NET]);
    const rd = (functionName, args = []) => client.readContract({ address: dep.vault, abi: vaultAbi, functionName, args });
    const [shares, assets, supply] = await Promise.all([rd("balanceOf", [id]), rd("totalAssets"), rd("totalSupply")]);
    if (shares === 0n) return null;
    const value = Number((shares * assets) / supply) / 1e18;
    // shares are minted at 1,000 per USDso at launch, so the price per 1,000 shares starts at 1.0000
    const price = supply ? (Number(assets) / Number(supply)) * 1000 : 1;
    return {
      kind,
      id,
      eyebrow: "My Catch position",
      headline: `${fmt(value)} USDso`,
      sub: "Backing the orders that catch dreamDEX liquidations. Read from the vault on chain just now.",
      stats: [["Share price", fmt(price, 4)], ["Since launch", `${signed((price - 1) * 100, 2)}%`], ["Holder", `${id.slice(0, 6)}…${id.slice(-4)}`]],
      text: `I'm backing Catch on ${TAG}: a vault that rests orders where liquidations land, so a forced close finds a buyer. Share price ${fmt(price, 4)} (${signed((price - 1) * 100, 2)}% since launch).`,
    };
  }
  return null;
}

export function origin(req) {
  const host = req.headers["x-forwarded-host"] || req.headers.host || "catch-backstop.vercel.app";
  const proto = req.headers["x-forwarded-proto"] || (host.startsWith("127.") || host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}
