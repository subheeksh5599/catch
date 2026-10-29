// How concentrated is open notional by position? Positions only (no health reads).
//   node scripts/concentration.mjs [pool]
import { NETWORKS, publicClient, bankAbi } from "../src/chain.mjs";
const net = NETWORKS.hideki, c = publicClient(net), bank = net.addresses.marginBank;
const pool = process.argv[2] || "0x4181dd08E73BbCdd1Ba3E615A18f6abD941b94C0";
const t0 = Date.now();
const blockNumber = await c.getBlockNumber();
const all = [];
for (const isLong of [true, false]) for (let s = 0n; ; s += 1000n) {
  const p = await c.readContract({ address: bank, abi: bankAbi, functionName: "getSideHoldersPaginated", args: [pool, isLong, s, 1000n], blockNumber });
  all.push(...p); if (p.length < 1000) break;
}
const calls = all.map((a) => ({ address: bank, abi: bankAbi, functionName: "getPosition", args: [a, pool] }));
const sizes = [];
for (let i = 0; i < calls.length; i += 800) {
  const r = await c.multicall({ contracts: calls.slice(i, i + 800), allowFailure: true, blockNumber, batchSize: 0 });
  for (const x of r) if (x.status === "success") sizes.push(Number(x.result.size < 0n ? -x.result.size : x.result.size));
}
sizes.sort((a, b) => b - a);
const tot = sizes.reduce((a, b) => a + b, 0);
let acc = 0; const at = {};
sizes.forEach((v, i) => { acc += v; for (const k of [250, 500, 1000, 2000, 3000]) if (i + 1 === k) at[k] = ((acc / tot) * 100).toFixed(1) + "%"; });
console.log("positions", sizes.length, "read in", (Date.now() - t0) / 1000, "s; share of size held by top N:", JSON.stringify(at));
process.exit(0);
