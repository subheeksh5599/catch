// Inspect the largest positions' bands on one market.
import { NETWORKS, publicClient } from "../src/chain.mjs";
import { snapshotPool } from "../src/reader.mjs";
const net = NETWORKS[process.argv[2] || "hideki"];
const pool = process.argv[3] || "0x4181dd08E73BbCdd1Ba3E615A18f6abD941b94C0";
const s = await snapshotPool(publicClient(net), { bank: net.addresses.marginBank, pool });
const f = (x) => (x == null ? null : Number(x) / 1e18);
const abs = (x) => (x < 0n ? -x : x);
const top = [...s.positions].sort((a, b) => (abs(b.size) > abs(a.size) ? 1 : -1)).slice(0, 15);
console.log("mark", f(s.markPrice));
for (const p of top) console.log(p.account.slice(0, 10), "size", f(p.size), "entry", f(p.entry), "liq", f(p.liq), "bk", f(p.bankruptcy), "eq", f(p.equity));
const sizes = s.positions.map((p) => f(abs(p.size))).sort((a, b) => a - b);
console.log("median size", sizes[sizes.length >> 1], "p90", sizes[Math.floor(sizes.length * 0.9)], "minQ", f(s.minQuantity));
process.exit(0);
