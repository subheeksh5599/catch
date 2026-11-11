// Every trade each Catch vault made, with the venue's own realized PnL for it.
// Reads the receipt of every taker and liquidation transaction the keeper recorded as a fill,
// and takes the MarginBank PositionUpdated log for the vault from it: new size, average entry
// and realizedPnl as the venue booked them. Writes `trades` into each retired record, and the
// live vault's into <network>.trades.json (the keeper rewrites the live record while it runs).
//   node scripts/live/trades.mjs [network]
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { parseEventLogs, formatUnits } from "viem";
import { SomniaMarkets } from "@somnia-chain/markets-sdk";
import { NETWORKS, publicClient, bankAbi, poolAbi } from "../../src/chain.mjs";

const netKey = process.argv[2] || "hideki";
const net = NETWORKS[netKey];
const client = publicClient(net);
const dir = new URL("../../../deployments/", import.meta.url);
const files = readdirSync(dir).filter((f) => f === `${netKey}.json` || new RegExp(`^${netKey}-v\\d+\\.json$`).test(f));

const ex = new SomniaMarkets({ chain: net.chain, addresses: net.addresses, indexerUrl: net.indexerUrl });
const markets = Object.values(await ex.loadMarkets());
const symbolOf = new Map(markets.filter((m) => m.info?.poolAddress).map((m) => [m.info.poolAddress.toLowerCase(), m.base]));
const decimalsOf = new Map(markets.filter((m) => m.info?.poolAddress).map((m) => [m.info.poolAddress.toLowerCase(), m.info.baseDecimals]));

// Evidence is carried forward into later records (tagged with the vault that made it), so
// gather every recorded fill once, attribute it to its own vault, then match logs to that vault.
const tagOf = (f) => (f === `${netKey}.json` ? "current" : f.match(/-(v\d+)\.json$/)[1]);
const recs = new Map(files.map((f) => [tagOf(f), { f, path: new URL(f, dir), rec: JSON.parse(readFileSync(new URL(f, dir), "utf8")) }]));
const owned = new Map(); // tag -> Map(tx -> kind)
for (const [tag, { rec }] of recs) {
  for (const e of rec.evidence || []) {
    if (!["fill", "catch"].includes(e.kind)) continue;
    const owner = e.vault && recs.has(e.vault) ? e.vault : tag;
    if (!owned.has(owner)) owned.set(owner, new Map());
    for (const t of e.txs || []) if (/taker|liquidation/i.test(t.label)) owned.get(owner).set(t.tx, e.kind);
  }
}

// position sizes are in each pool's own base unit
const oneBase = new Map();
async function baseUnit(pool) {
  const k = pool.toLowerCase();
  if (!oneBase.has(k)) {
    // the pool's own figure; if the pool reverts on reads, the indexer's base decimals
    const s = await client.readContract({ address: pool, abi: poolAbi, functionName: "getHealthSnapshot" }).catch(() => null);
    oneBase.set(k, s ? s.oneBase : 10n ** BigInt(decimalsOf.get(k) ?? 18));
  }
  return oneBase.get(k);
}

let total = 0;
for (const [tag, { f, path, rec }] of recs) {
  const vault = rec.vault.toLowerCase();
  const trades = [];
  for (const [hash, kind] of owned.get(tag) ?? []) {
    const r = await client.getTransactionReceipt({ hash }).catch(() => null);
    if (!r) continue;
    const logs = parseEventLogs({ abi: bankAbi, logs: r.logs.filter((l) => l.address.toLowerCase() === net.addresses.marginBank.toLowerCase()), eventName: "PositionUpdated" });
    for (const l of logs) {
      if (l.args.account.toLowerCase() !== vault) continue;
      const unit = await baseUnit(l.args.perpPool);
      trades.push({
        block: Number(r.blockNumber),
        tx: hash,
        kind: kind === "catch" ? "liquidation" : "taker",
        pool: l.args.perpPool,
        base: symbolOf.get(l.args.perpPool.toLowerCase()) ?? null,
        newSize: Number(l.args.newSize) / Number(unit),
        avgEntry: Number(formatUnits(l.args.avgEntryPrice, 18)),
        realizedPnl: Number(formatUnits(l.args.realizedPnl, 18)),
      });
    }
  }
  trades.sort((a, b) => a.block - b.block);
  if (tag === "current") {
    // the keeper holds the live record in memory and rewrites it; keep trades beside it
    writeFileSync(new URL(`${netKey}.trades.json`, dir), JSON.stringify({ vault: rec.vault, readAt: new Date().toISOString(), trades }, null, 2) + "\n");
  } else {
    rec.trades = trades;
    writeFileSync(path, JSON.stringify(rec, null, 2) + "\n");
  }
  const pnl = trades.reduce((s, t) => s + t.realizedPnl, 0);
  total += pnl;
  console.log(f, rec.vault, `${trades.length} trades`, `realized ${pnl.toFixed(4)} USDso`);
}
console.log("all vaults realized", total.toFixed(4), "USDso");
process.exit(0);
