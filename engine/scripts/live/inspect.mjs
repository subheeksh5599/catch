// Print the vault's live slots with the venue's view of each order, and the vault's events in
// the last N blocks (default 3,000), including which transaction emitted them.
//   node scripts/live/inspect.mjs [blocks]
import { readFileSync } from "node:fs";
import { parseAbi } from "viem";
import { NETWORKS, publicClient, vaultAbi } from "../../src/chain.mjs";

const net = NETWORKS.hideki;
const c = publicClient(net);
const rec = JSON.parse(readFileSync(new URL("../../../deployments/hideki.json", import.meta.url), "utf8"));
const V = rec.vault;
const rd = (f, a = []) => c.readContract({ address: V, abi: vaultAbi, functionName: f, args: a });
const ob = parseAbi(["function getOrder(uint128) view returns ((uint128 orderId,bool isBid,address owner,uint64 userData,uint256 price,uint256 fullQuantity,uint256 quantityRemaining,uint64 expireTimestampNs))"]);
const head = await c.getBlockNumber();
console.log("vault", V, "head", head, "assets", Number(await rd("totalAssets")) / 1e18);
for (const p of await rd("pools")) {
  for (const id of await rd("liveSlots", [p])) {
    const s = await rd("getSlot", [id]);
    const o = await c.readContract({ address: p, abi: ob, functionName: "getOrder", args: [s.orderId] });
    console.log(" slot", id, p.slice(0, 10), s.unwind ? "unwind" : s.isBid ? "bid" : "ask", "price", Number(s.price) / 1e18, "qty", Number(s.quantity) / 1e18, "venue remaining", Number(o.quantityRemaining) / 1e18, "owner=vault", o.owner.toLowerCase() === V.toLowerCase());
  }
}
const span = BigInt(process.argv[2] || 3000);
const out = [];
for (let a = head - span; a <= head; a += 1000n) {
  const b = a + 999n > head ? head : a + 999n;
  out.push(...(await c.getContractEvents({ address: V, abi: vaultAbi, fromBlock: a, toBlock: b })));
}
for (const l of out) {
  const tx = await c.getTransaction({ hash: l.transactionHash });
  console.log(" event", l.eventName, "block", l.blockNumber, "tx", l.transactionHash, "from", tx.from, "to", tx.to, JSON.stringify(l.args, (k, v) => (typeof v === "bigint" ? v.toString() : v)));
}
process.exit(0);
