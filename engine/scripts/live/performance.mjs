// What a vault paid back against what it took in, from its own Deposited and Redeemed events.
// Reads the receipts of the deposit and redeem transactions listed in the record (rec.txs), and
// writes rec.performance; a deposit or redemption sent outside the scripts must be added there. Nothing is estimated: every figure is the sum of on-chain events.
//   node scripts/live/performance.mjs [network] [file-tag]   (file-tag: "" for the live record, or v4)
import { readFileSync, writeFileSync } from "node:fs";
import { parseEventLogs } from "viem";
import { NETWORKS, publicClient, vaultAbi } from "../../src/chain.mjs";

const [netKey = "hideki", tag = ""] = process.argv.slice(2);
const net = NETWORKS[netKey];
const client = publicClient(net);
const path = new URL(`../../../deployments/${netKey}${tag ? `-${tag}` : ""}.json`, import.meta.url);
const rec = JSON.parse(readFileSync(path, "utf8"));
const vault = rec.vault.toLowerCase();

const seen = new Set();
const events = [];
const add = (logs) => {
  for (const l of parseEventLogs({ abi: vaultAbi, logs: logs.filter((x) => x.address.toLowerCase() === vault) })) {
    const k = `${l.transactionHash}:${l.logIndex}`;
    if (seen.has(k) || !["Deposited", "Redeemed"].includes(l.eventName)) continue;
    seen.add(k);
    events.push({ event: l.eventName, owner: l.args.owner, assets: l.args.assets, shares: l.args.shares, block: Number(l.blockNumber), tx: l.transactionHash });
  }
};

const hashes = [...new Set((rec.txs || []).filter((t) => ["deposit", "redeem"].includes(t.kind)).map((t) => t.tx))];
for (const hash of hashes) add((await client.getTransactionReceipt({ hash })).logs);

events.sort((a, b) => a.block - b.block);
const sum = (k, kind) => events.filter((e) => e.event === kind).reduce((t, e) => t + e[k], 0n);
const deposited = sum("assets", "Deposited"), redeemed = sum("assets", "Redeemed");
const minted = sum("shares", "Deposited"), burned = sum("shares", "Redeemed");
const [assetsNow, supplyNow] = await Promise.all([
  client.readContract({ address: rec.vault, abi: vaultAbi, functionName: "totalAssets" }),
  client.readContract({ address: rec.vault, abi: vaultAbi, functionName: "totalSupply" }),
]);
const f = (x) => Number(x) / 1e18;
rec.performance = {
  deposited: f(deposited),
  redeemed: f(redeemed),
  stillInside: f(assetsNow),
  sharesOutstanding: f(supplyNow),
  // price per 1,000 shares at each deposit and each redemption, straight from the event amounts
  firstSharePrice: events.length ? (f(events[0].assets) * 1000) / f(events[0].shares) : null,
  lastSharePrice: events.length ? (f(events.at(-1).assets) * 1000) / f(events.at(-1).shares) : null,
  sharesMinted: f(minted),
  sharesBurned: f(burned),
  result: f(redeemed + assetsNow - deposited),
  events: events.map((e) => ({ ...e, assets: f(e.assets), shares: f(e.shares) })),
  readAt: new Date().toISOString(),
};
writeFileSync(path, JSON.stringify(rec, null, 2) + "\n");
console.log(JSON.stringify({ ...rec.performance, events: rec.performance.events.length }, null, 2));
