// The keeper: reads the map, proposes the best cluster per side on the busiest markets, and
// asks the vault to rest an order there. The vault re-derives every number on-chain, so the
// keeper holds no authority; it only pays gas. Also re-checks live slots.
//   node scripts/live/keeper.mjs [network] [--deposit 10000] [--markets 4] [--once]
import { readFileSync, writeFileSync } from "node:fs";
import { parseEther, BaseError, ContractFunctionRevertedError } from "viem";
import { NETWORKS, publicClient, vaultAbi, erc20Abi, systemAbi, engineAbi, bankAbi, poolAbi } from "../../src/chain.mjs";
import { loadAccount, walletFor } from "../../src/signer.mjs";
import { snapshotPool } from "../../src/reader.mjs";
import { bestCluster, sizeOrder } from "../../src/math.mjs";
import { reconcile, POSITION_UPDATED } from "../../src/subscriptions.mjs";
import { pad } from "viem";

const argv = process.argv.slice(2);
const netKey = argv.find((a) => !a.startsWith("--") && !/^\d/.test(a)) || "hideki";
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const once = argv.includes("--once");
const net = NETWORKS[netKey];
const recPath = new URL(`../../../deployments/${netKey}.json`, import.meta.url);
const rec = JSON.parse(readFileSync(recPath, "utf8"));
const vault = rec.vault;
const account = loadAccount();
const client = publicClient(net), wallet = walletFor(net, account);
const save = () => writeFileSync(recPath, JSON.stringify(rec, null, 2) + "\n");
const log = (...a) => console.log(new Date().toISOString(), ...a);
const rd = (functionName, args = []) => client.readContract({ address: vault, abi: vaultAbi, functionName, args });

async function send(kind, functionName, args, extra = {}) {
  try {
    const { request } = await client.simulateContract({ account, address: vault, abi: vaultAbi, functionName, args });
    const gas = await client.estimateContractGas({ account, address: vault, abi: vaultAbi, functionName, args });
    const hash = await wallet.writeContract({ ...request, gas: (gas * 15n) / 10n });
    const r = await client.waitForTransactionReceipt({ hash });
    rec.txs.push({ kind, tx: hash, block: Number(r.blockNumber), status: r.status, ...extra });
    save();
    log(kind, r.status, hash);
    return r;
  } catch (e) {
    const rev = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : null;
    log(kind, "refused", rev?.data?.errorName ?? (e.shortMessage || e.message).slice(0, 200), rev?.data?.args?.map(String).join(",") ?? "");
    // a refusal by the contract's own rule is evidence too: keep the error and its numbers
    if (rev?.data?.errorName) {
      rec.refusals ??= [];
      rec.refusals.push({ at: new Date().toISOString(), kind, error: rev.data.errorName, args: rev.data.args?.map(String) ?? [], ...extra });
      rec.refusals = rec.refusals.slice(-300);
      save();
    }
    return null;
  }
}

async function deposit(amountText) {
  const amount = parseEther(amountText);
  const asset = await rd("ASSET");
  const allowance = await client.readContract({ address: asset, abi: erc20Abi, functionName: "allowance", args: [account.address, vault] });
  if (allowance < amount) {
    // Somnia storage writes cost far more than mainnet EVM; size gas from the node's estimate
    const g = await client.estimateContractGas({ account, address: asset, abi: erc20Abi, functionName: "approve", args: [vault, amount] });
    const h = await wallet.writeContract({ address: asset, abi: erc20Abi, functionName: "approve", args: [vault, amount], gas: (g * 15n) / 10n });
    const ar = await client.waitForTransactionReceipt({ hash: h });
    if (ar.status !== "success") throw new Error(`approve reverted ${h}`);
    rec.txs.push({ kind: "approve", tx: h });
    log("approve", h);
  }
  const { request } = await client.simulateContract({ account, address: vault, abi: vaultAbi, functionName: "deposit", args: [amount, account.address] });
  const dg = await client.estimateContractGas({ account, address: vault, abi: vaultAbi, functionName: "deposit", args: [amount, account.address] });
  const h = await wallet.writeContract({ ...request, gas: (dg * 15n) / 10n });
  const r = await client.waitForTransactionReceipt({ hash: h });
  rec.txs.push({ kind: "deposit", tx: h, block: Number(r.blockNumber), status: r.status, amount: amountText });
  save();
  log("deposit", r.status, h);
}

/** Keep one order at the edge of `backer`'s catch window nearest the mark: the price where
 *  the engine starts closing that position. Window and position are read from the vault and
 *  the bank, so the order is exactly what the contract will accept. */
async function followBacker(pool, backer, slots, capNotional) {
  const pos = await client.readContract({ address: net.addresses.marginBank, abi: bankAbi, functionName: "getPosition", args: [backer, pool] });
  if (pos.size === 0n) { log(pool, "followed account is flat"); return; }
  const isBid = pos.size > 0n; // a long is sold into bids
  if (slots.some((x) => !x.unwind && x.isBid === isBid && x.backers.some((b) => b.toLowerCase() === backer.toLowerCase()))) return;
  const [snap, book, win] = await Promise.all([
    client.readContract({ address: pool, abi: poolAbi, functionName: "getHealthSnapshot" }),
    client.readContract({ address: pool, abi: poolAbi, functionName: "getOrderBookParameters" }),
    rd("catchWindow", [backer, pool]),
  ]);
  const [lo, hi] = win;
  const t = book.tickSize;
  let price = isBid ? (hi / t) * t : ((lo + t - 1n) / t) * t;
  if (isBid && price >= snap.markPrice) price = ((snap.markPrice - 1n) / t) * t;
  if (!isBid && price <= snap.markPrice) price = ((snap.markPrice + t) / t) * t;
  const size = pos.size > 0n ? pos.size : -pos.size;
  const q = sizeOrder({ size, price, oneBase: snap.oneBase, lotSize: book.lotSize, minQuantity: book.minQuantity, capNotional });
  if (q === 0n) { log(pool, "followed order below venue minimum"); return; }
  await send("place", "place", [pool, isBid, price, q, [backer]], { pool, isBid, price: price.toString(), quantity: q.toString(), backers: 1, followed: backer });
}

async function pass(engineSpread, pools) {
  const assets = await rd("totalAssets");
  const ccap = await rd("CLUSTER_CAP_BPS");
  const capNotional = (assets * ccap) / 10_000n;
  for (const pool of pools) {
    // one market that fails a read (a venue revert, an RPC timeout) is skipped for this pass;
    // it must never stop the other markets, the subscriptions or the evidence from updating
    try {
    const live = await rd("liveSlots", [pool]);
    const slots = await Promise.all(live.map((id) => rd("getSlot", [id])));
    const followed = follow.get(pool.toLowerCase());
    if (followed) {
      for (const who of followed) await followBacker(pool, who, slots, capNotional);
      if (live.length && passNo % Number(opt("refresh-every", 90)) === 0) await send("refreshPool", "refreshPool", [pool], { pool });
      continue;
    }
    const open = [true, false].filter((isBid) => !slots.some((x) => !x.unwind && x.isBid === isBid));
    // a full snapshot reads every holder's health; skip it while both sides are quoted, and
    // retry a market whose clusters were below the venue minimum only every `retry-every` passes
    const skipKey = pool.toLowerCase();
    if (!open.length || (belowMin.get(skipKey) ?? -1e9) > passNo - Number(opt("retry-every", 30))) {
      if (live.length && passNo % Number(opt("refresh-every", 90)) === 0) await send("refreshPool", "refreshPool", [pool], { pool });
      continue;
    }
    const s = await snapshotPool(client, { bank: net.addresses.marginBank, pool });
    if (passNo === 0) log(pool, "snapshot", s.positions.length, "positions");
    let idle = false;
    for (const isBid of open) {
      // every cited backer needs its own reactivity subscription, so cite only the largest few
      const c = bestCluster(s.positions, { markPrice: s.markPrice, tickSize: s.tickSize, isBid, spreadBps: engineSpread, maxBackers: Number(opt("backers", 2)) });
      if (!c) { idle = true; continue; } // nothing reachable on this side right now
      const q = sizeOrder({ size: c.size, price: c.price, oneBase: s.oneBase, lotSize: s.lotSize, minQuantity: s.minQuantity, capNotional });
      if (q === 0n) { log(pool, isBid ? "bid" : "ask", "below venue minimum"); idle = true; continue; }
      await send("place", "place", [pool, isBid, c.price, q, c.backers], { pool, isBid, price: c.price.toString(), quantity: q.toString(), backers: c.backers.length });
    }
    if (idle) belowMin.set(skipKey, passNo);
    if (live.length && passNo % Number(opt("refresh-every", 90)) === 0) await send("refreshPool", "refreshPool", [pool], { pool });
    } catch (e) {
      const msg = (e.shortMessage || e.message || String(e)).split("\n")[0];
      if (skipped.get(pool.toLowerCase()) !== msg) log(pool, "skipped this pass:", msg);
      skipped.set(pool.toLowerCase(), msg);
      continue;
    }
    skipped.delete(pool.toLowerCase());
  }
  if (!argv.includes("--no-subs")) await reconcile({ net, client, wallet, rec, save, log });
  await recordEvidence();
  await recordNav();
}

/** Append the vault's assets and supply to rec.navHistory (read at head), at most every
 *  `nav-every` seconds or whenever either moved, so the dashboard's share-price line is a
 *  series of real reads rather than a reconstruction. */
async function recordNav() {
  const [assets, supply, block] = await Promise.all([rd("totalAssets"), rd("totalSupply"), client.getBlockNumber()]);
  rec.navHistory ??= [];
  const last = rec.navHistory.at(-1);
  const due = !last || Date.now() - Date.parse(last.at) > Number(opt("nav-every", 600)) * 1000;
  if (!due && last.totalAssets === assets.toString() && last.totalSupply === supply.toString()) return;
  rec.navHistory.push({ at: new Date().toISOString(), block: Number(block), totalAssets: assets.toString(), totalSupply: supply.toString() });
  rec.navHistory = rec.navHistory.slice(-2000);
  save();
}

/** Scan recent vault events and append on-chain proofs to rec.evidence: every Caught (a forced
 *  close filled into the vault), Unwinding, and every Released emitted by a reactivity callback
 *  (a validator system tx calling onEvent, selector 0x53edf33d). */
/** The transaction in `block` that changed the vault's own position, and whether it was a
 *  liquidation (sent to, or logging from, the venue's liquidation engine). */
async function fillTrigger(block) {
  const logs = await client.getLogs({ address: net.addresses.marginBank, fromBlock: block, toBlock: block });
  const mine = logs.find((x) => x.topics[0] === POSITION_UPDATED && x.topics[1]?.toLowerCase() === pad(vault, { size: 32 }).toLowerCase());
  if (!mine) return null;
  const [tx, rc] = await Promise.all([client.getTransaction({ hash: mine.transactionHash }), client.getTransactionReceipt({ hash: mine.transactionHash })]);
  const engine = cfg.liquidationEngine.toLowerCase();
  const liquidation = tx.to?.toLowerCase() === engine || rc.logs.some((x) => x.address.toLowerCase() === engine);
  return { tx: mine.transactionHash, liquidation };
}

async function recordEvidence() {
  const head = await client.getBlockNumber();
  const from = BigInt(rec.evidenceCursor ?? rec.deployBlock ?? Number(head) - 3000);
  rec.evidence ??= [];
  // CatchVault release codes, as named in the contract
const RELEASE_REASON = ["", "filled", "a backer moved out of the window", "replaced by a larger cluster", "freed for a redemption", "repriced", "mark off the index"];
  const known = new Set(rec.evidence.flatMap((e) => (e.txs || []).map((t) => t.tx)));
  for (let a = from; a <= head; a += 1000n) {
    const b = a + 999n > head ? head : a + 999n;
    const logs = await client.getContractEvents({ address: vault, abi: vaultAbi, fromBlock: a, toBlock: b });
    for (const l of logs) {
      if (known.has(l.transactionHash)) continue;
      const tx = await client.getTransaction({ hash: l.transactionHash });
      const byCallback = tx.input.startsWith("0x53edf33d");
      const at = Number(l.blockNumber);
      if (l.eventName === "Caught") {
        const trigger = await fillTrigger(l.blockNumber);
        const forced = trigger && trigger.liquidation;
        rec.evidence.push({
          kind: forced ? "catch" : "fill",
          title: forced ? "A liquidation filled into a vault order" : "A resting order filled and the callback took the position",
          status: "proven", block: at,
          detail: `${forced ? "The liquidation engine's forced close" : "An ordinary taker order"} filled the vault on ${l.args.pool}; the vault's position became ${Number(l.args.newSize) / 1e18} at an average entry of ${Number(l.args.avgEntryPrice) / 1e18}, recorded by the reactivity callback in the same block.`,
          txs: [...(trigger ? [{ label: forced ? "Liquidation" : "Taker order", tx: trigger.tx }] : []), { label: byCallback ? "Reactivity callback (onEvent)" : "Transaction", tx: l.transactionHash }],
        });
      } else if (l.eventName === "Unwinding") {
        rec.evidence.push({ kind: "unwind", title: "Caught position offered back at or beyond entry", status: "proven", block: at, detail: `${l.args.isBid ? "Bid" : "Ask"} at ${l.args.price} for ${l.args.quantity}.`, txs: [{ label: byCallback ? "Reactivity callback (onEvent)" : "Transaction", tx: l.transactionHash }] });
      } else if (l.eventName === "Released" && byCallback) {
        rec.evidence.push({ kind: "auto-cancel", title: "Order cancelled by the reactivity callback", status: "proven", block: at, detail: `Slot ${l.args.slotId} released (${RELEASE_REASON[Number(l.args.reason)] ?? `reason ${l.args.reason}`}) in a validator-issued onEvent call after a backer's position changed.`, txs: [{ label: "Reactivity callback (onEvent)", tx: l.transactionHash }] });
      } else continue;
      known.add(l.transactionHash);
      log("evidence", l.eventName, l.transactionHash);
    }
  }
  rec.evidenceCursor = Number(head) + 1;
  save();
}
let passNo = 0;
const belowMin = new Map();
const skipped = new Map(); // pool -> last read error, logged once per change

const cfg = await client.readContract({ address: net.addresses.marginBank, abi: systemAbi, functionName: "getSystemConfig" });
const spread = await client.readContract({ address: cfg.liquidationEngine, abi: engineAbi, functionName: "getMaxLiquidationSpreadBps" });

if (opt("deposit")) await deposit(opt("deposit"));
const pools = (opt("pools") || "").split(",").filter(Boolean);
const { SomniaMarkets } = await import("@somnia-chain/markets-sdk");
const ex = new SomniaMarkets({ chain: net.chain, addresses: net.addresses, indexerUrl: net.indexerUrl });
// the market list comes from the venue's indexer; an empty or failed answer is retried, never
// taken as "no markets" (that would leave a fresh vault quoting nothing until a restart)
let all = [];
for (let attempt = 1; !all.length; attempt++) {
  try {
    all = Object.values(await ex.loadMarkets()).filter((x) => x.type === "swap" && x.perpStatus?.restricted === false);
  } catch (e) {
    log("market list failed:", e.shortMessage || e.message);
  }
  if (!all.length) await new Promise((r) => setTimeout(r, Math.min(60, 5 * attempt) * 1000));
}
all.sort((a, b) => Number(b.info.openInterest) * Number(b.info.markPrice) - Number(a.info.openInterest) * Number(a.info.markPrice));
// --follow HYPE=0xabc,ETH=0xdef : on those markets, quote only that account's window
const follow = new Map();
for (const pair of (opt("follow") || "").split(",").filter(Boolean)) {
  const [base, who] = pair.split("=");
  const m = all.find((x) => x.base === base);
  if (!m) throw new Error(`unknown market ${base}`);
  const k = m.info.poolAddress.toLowerCase();
  follow.set(k, [...(follow.get(k) || []), who]);
}
// the busiest markets, plus any market the vault already holds (it must keep re-checking those)
const top = all.slice(0, Number(opt("markets", all.length))).map((x) => x.info.poolAddress);
for (const p of pools) if (!top.some((x) => x.toLowerCase() === p.toLowerCase())) top.push(p);
for (const p of follow.keys()) if (!top.some((x) => x.toLowerCase() === p)) top.unshift(p);
log("keeper on", net.label, "vault", vault, "markets", top.length, "engine spread bps", spread);
for (;;) {
  try { await pass(spread, top); } catch (e) { log("pass failed", e.shortMessage || e.message); }
  passNo++;
  if (once) break;
  await new Promise((r) => setTimeout(r, Number(opt("every", 30)) * 1000));
}
process.exit(0);
