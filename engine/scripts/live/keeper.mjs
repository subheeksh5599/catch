// The keeper: reads the map, proposes the best cluster per side on the busiest markets, and
// asks the vault to rest an order there. The vault re-derives every number on-chain, so the
// keeper holds no authority; it only pays gas. Also re-checks live slots.
//   node scripts/live/keeper.mjs [network] [--deposit 10000] [--markets 4] [--once]
import { readFileSync, writeFileSync } from "node:fs";
import { parseEther, BaseError, ContractFunctionRevertedError } from "viem";
import { NETWORKS, publicClient, vaultAbi, erc20Abi, systemAbi, engineAbi } from "../../src/chain.mjs";
import { loadAccount, walletFor } from "../../src/signer.mjs";
import { snapshotPool } from "../../src/reader.mjs";
import { bestCluster, sizeOrder } from "../../src/math.mjs";

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

async function pass(engineSpread, pools) {
  const assets = await rd("totalAssets");
  const ccap = await rd("CLUSTER_CAP_BPS");
  const capNotional = (assets * ccap) / 10_000n;
  for (const pool of pools) {
    const s = await snapshotPool(client, { bank: net.addresses.marginBank, pool });
    const live = await rd("liveSlots", [pool]);
    const slots = await Promise.all(live.map((id) => rd("getSlot", [id])));
    for (const isBid of [true, false]) {
      const c = bestCluster(s.positions, { markPrice: s.markPrice, tickSize: s.tickSize, isBid, spreadBps: engineSpread });
      if (!c) continue;
      if (slots.some((x) => !x.unwind && x.isBid === isBid)) continue; // one cluster order per side per pool
      const q = sizeOrder({ size: c.size, price: c.price, oneBase: s.oneBase, lotSize: s.lotSize, minQuantity: s.minQuantity, capNotional });
      if (q === 0n) { log(pool, isBid ? "bid" : "ask", "below venue minimum"); continue; }
      await send("place", "place", [pool, isBid, c.price, q, c.backers], { pool, isBid, price: c.price.toString(), quantity: q.toString(), backers: c.backers.length });
    }
    if (live.length) await send("refreshPool", "refreshPool", [pool], { pool });
  }
}

const cfg = await client.readContract({ address: net.addresses.marginBank, abi: systemAbi, functionName: "getSystemConfig" });
const spread = await client.readContract({ address: cfg.liquidationEngine, abi: engineAbi, functionName: "getMaxLiquidationSpreadBps" });

if (opt("deposit")) await deposit(opt("deposit"));
const pools = (opt("pools") || "").split(",").filter(Boolean);
const top = pools.length ? pools : await (async () => {
  const { SomniaMarkets } = await import("@somnia-chain/markets-sdk");
  const ex = new SomniaMarkets({ chain: net.chain, addresses: net.addresses, indexerUrl: net.indexerUrl });
  const m = Object.values(await ex.loadMarkets()).filter((x) => x.type === "swap" && x.perpStatus?.tradeable);
  m.sort((a, b) => Number(b.info.openInterest) * Number(b.info.markPrice) - Number(a.info.openInterest) * Number(a.info.markPrice));
  return m.slice(0, Number(opt("markets", 4))).map((x) => x.info.poolAddress);
})();
log("keeper on", net.label, "vault", vault, "markets", top.length, "engine spread bps", spread);
for (;;) {
  try { await pass(spread, top); } catch (e) { log("pass failed", e.shortMessage || e.message); }
  if (once) break;
  await new Promise((r) => setTimeout(r, Number(opt("every", 30)) * 1000));
}
process.exit(0);
