// Time one live snapshot of the busiest Hideki market and print the headline numbers.
import { NETWORKS, publicClient } from "../src/chain.mjs";
import { snapshotPool } from "../src/reader.mjs";
import { binMap, atRisk, bestCluster } from "../src/math.mjs";

const net = NETWORKS[process.argv[2] || "hideki"];
const pool = process.argv[3] || "0x4181dd08E73BbCdd1Ba3E615A18f6abD941b94C0";
const client = publicClient(net);
const t = Date.now();
const s = await snapshotPool(client, { bank: net.addresses.marginBank, pool });
console.log("block", s.blockNumber, "ms", Date.now() - t, "holders", s.holders, "positions", s.positions.length, "unpriced", s.unpriced);
const f = (x) => Number(x) / 1e18;
console.log("mark", f(s.markPrice), "mmBps", s.maintenanceMarginBps, "tick", f(s.tickSize));
const m = binMap(s.positions, s);
console.log("outside", m.outside, "alreadyLiquidatable", m.alreadyLiquidatable);
for (const mv of [100n, 300n, 500n, 1000n]) {
  const r = atRisk(s.positions, s, mv);
  console.log(`within ${Number(mv) / 100}%`, "accounts", r.accounts, "long", f(r.long).toFixed(0), "short", f(r.short).toFixed(0));
}
for (const isBid of [true, false]) {
  const c = bestCluster(s.positions, { ...s, isBid });
  console.log(isBid ? "bid" : "ask", c && { price: f(c.price), size: f(c.size), backers: c.backers.length, inBand: c.accountsInBand });
}
process.exit(0);
