// "Is anyone waiting under my liquidation?" for one account, read live.
// For every open dreamDEX perp position of the account: its liquidation price (the venue's
// single-market solve), the window the engine may close it in, what the public book holds
// inside that window right now, and how much of that is Catch. Nothing is estimated from
// history; every figure is a read at request time.
import { parseAbi } from "viem";
import { bankAbi, poolAbi, vaultAbi } from "./chain.mjs";
import { liquidationPrice, catchWindow, closeInBook } from "./math.mjs";

const engineAbi = parseAbi(["function isLiquidatable(address account) view returns (bool)"]);
const E18 = 1e18;
const num = (x, scale = E18) => (x == null ? null : Number(x) / scale);
const abs = (x) => (x < 0n ? -x : x);
/** Beyond this distance from the mark a position is listed but not judged (the map's range). */
export const FAR = 0.15;

export const isAddress = (s) => /^0x[0-9a-fA-F]{40}$/.test(s || "");

/** svc: an initialised CatchService (markets loaded, engine config read). */
export async function checkAccount(svc, account) {
  if (!isAddress(account)) throw new Error("not an address");
  const bank = svc.net.addresses.marginBank;
  const markets = [...svc.markets.values()];
  const head = await svc.client.getBlockNumber();
  const pos = await svc.client.multicall({
    contracts: markets.map((m) => ({ address: bank, abi: bankAbi, functionName: "getPosition", args: [account, m.pool] })),
    allowFailure: true,
    blockNumber: head,
  });
  const open = markets.map((m, i) => ({ m, p: pos[i].status === "success" ? pos[i].result : null })).filter((x) => x.p && x.p.size !== 0n);
  const engine = svc.system?.liquidationEngine;
  const base = { account, block: Number(head), at: Date.now(), network: svc.net.key, maxSpreadBps: svc.engine?.maxSpreadBps ?? null, vault: svc.deployment?.vault ?? null };
  if (!open.length) return { ...base, liquidatable: false, positions: [] };

  const [health, liquidatable] = await Promise.all([
    svc.client.readContract({ address: bank, abi: bankAbi, functionName: "getAccountHealth", args: [account], blockNumber: head }),
    engine ? svc.client.readContract({ address: engine, abi: engineAbi, functionName: "isLiquidatable", args: [account], blockNumber: head }).catch(() => null) : null,
  ]);
  const [equity, , mmReq] = health;
  const spreadBps = BigInt(svc.engine.maxSpreadBps);
  const vault = svc.deployment?.vault;

  const positions = await Promise.all(open.map(async ({ m, p }) => {
    const [snap, bk, book, slots] = await Promise.all([
      svc.client.readContract({ address: m.pool, abi: poolAbi, functionName: "getHealthSnapshot", blockNumber: head }),
      svc.client.readContract({ address: bank, abi: bankAbi, functionName: "getBankruptcyPrice", args: [account, m.pool], blockNumber: head }).catch(() => null),
      svc.ex.fetchOrderBook(m.symbol, 200).catch(() => ({ bids: [], asks: [] })),
      vault ? vaultSlots(svc, vault, m.pool) : [],
    ]);
    const long = p.size > 0n;
    const liq = liquidationPrice({ size: p.size, equity, mmReq, markPrice: snap.markPrice, oneBase: snap.oneBase, maintenanceMarginBps: snap.maintenanceMarginBps });
    const w = catchWindow({ size: p.size, liq, bankruptcy: bk, spreadBps });
    const size = num(abs(p.size), Number(snap.oneBase));
    const mark = num(snap.markPrice);
    const row = {
      pool: m.pool,
      symbol: m.symbol,
      base: m.base,
      side: long ? "long" : "short",
      size,
      entry: num(p.avgEntryPrice),
      mark,
      liq: num(liq),
      bankruptcy: num(bk),
      distance: liq && liq > 0n ? Math.abs(num(liq) - mark) / mark : null,
      notionalAtLiq: liq ? size * num(liq) : null,
      window: null,
      close: null,
      catch: null,
    };
    // a long whose margin covers a move to zero has no liquidation price at all
    if (!w || !liq || liq === 0n) return { ...row, verdict: "beyond-zero" };
    const window = { lo: num(w.lo), hi: num(w.hi) };
    const rows = long ? book.bids || [] : book.asks || [];
    const close = closeInBook({ side: row.side, size, window, rows });
    // Catch's own orders on the side that would take this close, inside the window
    const mine = slots.filter((s) => !s.unwind && s.isBid === long && s.price >= window.lo && s.price <= window.hi);
    const catchRow = {
      orders: mine.length,
      notional: mine.reduce((n, s) => n + s.price * s.quantity, 0),
      citesYou: mine.some((s) => s.backers.some((b) => b.toLowerCase() === account.toLowerCase())),
    };
    // further than FAR from the mark, today's book says little about the book on the day
    const far = row.distance != null && row.distance > FAR;
    const verdict = far ? "far" : close.coverage >= 0.999 ? "covered" : close.filled > 0 ? "partial" : "empty";
    return { ...row, window, close, catch: catchRow, verdict };
  }));
  positions.sort((a, b) => (a.distance ?? 9) - (b.distance ?? 9));
  return { ...base, liquidatable, equity: num(equity), maintenance: num(mmReq), positions };
}

async function vaultSlots(svc, vault, pool) {
  try {
    const ids = await svc.client.readContract({ address: vault, abi: vaultAbi, functionName: "liveSlots", args: [pool] });
    if (!ids.length) return [];
    const snap = await svc.client.readContract({ address: pool, abi: poolAbi, functionName: "getHealthSnapshot" });
    const raw = await Promise.all(ids.map((id) => svc.client.readContract({ address: vault, abi: vaultAbi, functionName: "getSlot", args: [id] })));
    return raw.map((s) => ({ isBid: s.isBid, unwind: s.unwind, price: num(s.price), quantity: num(s.quantity, Number(snap.oneBase)), backers: s.backers }));
  } catch {
    return [];
  }
}

/** The headline for a check: the position closest to liquidation. */
export function headline(r) {
  return r.positions.find((x) => ["covered", "partial", "empty"].includes(x.verdict)) ?? null;
}
