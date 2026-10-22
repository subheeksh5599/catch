// Chain reader: builds one market's liquidation snapshot from head state, pinned to one block.
import { bankAbi, poolAbi } from "./chain.mjs";
import { liquidationPrice } from "./math.mjs";

const PAGE = 1000n;
const BATCH = Number(process.env.READ_BATCH || 800);

async function holders(client, bank, pool, isLong, blockNumber) {
  const out = [];
  for (let start = 0n; ; start += PAGE) {
    const page = await client.readContract({
      address: bank, abi: bankAbi, functionName: "getSideHoldersPaginated",
      args: [pool, isLong, start, PAGE], blockNumber,
    });
    out.push(...page);
    if (BigInt(page.length) < PAGE) return out;
  }
}

const CONCURRENCY = Number(process.env.READ_CONCURRENCY || 10);

async function multicall(client, contracts, blockNumber) {
  const chunks = [];
  for (let i = 0; i < contracts.length; i += BATCH) chunks.push(contracts.slice(i, i + BATCH));
  const out = new Array(chunks.length);
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const i = next++;
      out[i] = await client.multicall({ contracts: chunks[i], allowFailure: true, blockNumber, batchSize: 0 });
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker));
  return out.flat();
}

/** Every open position on `pool` with its liquidation and bankruptcy price. */
export async function snapshotPool(client, { bank, pool }) {
  const blockNumber = await client.getBlockNumber();
  const [snap, book] = await Promise.all([
    client.readContract({ address: pool, abi: poolAbi, functionName: "getHealthSnapshot", blockNumber }),
    client.readContract({ address: pool, abi: poolAbi, functionName: "getOrderBookParameters", blockNumber }),
  ]);
  const [longs, shorts] = await Promise.all([
    holders(client, bank, pool, true, blockNumber),
    holders(client, bank, pool, false, blockNumber),
  ]);
  const accounts = [...new Set([...longs, ...shorts])];
  // pass 1: position + health for everyone
  const calls = [];
  for (const a of accounts) {
    calls.push({ address: bank, abi: bankAbi, functionName: "getPosition", args: [a, pool] });
    calls.push({ address: bank, abi: bankAbi, functionName: "getAccountHealth", args: [a] });
  }
  const res = await multicall(client, calls, blockNumber);
  const positions = [];
  let unpriced = 0;
  for (let i = 0; i < accounts.length; i++) {
    const [pos, health] = res.slice(i * 2, i * 2 + 2);
    if (pos.status !== "success" || pos.result.size === 0n) continue;
    const size = pos.result.size;
    let liq = null;
    if (health.status === "success") {
      const [equity, , mmReq] = health.result;
      liq = liquidationPrice({ size, equity, mmReq, markPrice: snap.markPrice, oneBase: snap.oneBase, maintenanceMarginBps: snap.maintenanceMarginBps });
    } else unpriced++;
    positions.push({ account: accounts[i], size, entry: pos.result.avgEntryPrice, liq, bankruptcy: null, equity: health.status === "success" ? health.result[0] : null });
  }
  // pass 2: bankruptcy price only where a catch window can matter (liquidation within 20% of mark)
  const near = positions.filter((p) => p.liq != null && (p.liq > snap.markPrice ? p.liq - snap.markPrice : snap.markPrice - p.liq) * 5n <= snap.markPrice);
  const bk = await multicall(client, near.map((p) => ({ address: bank, abi: bankAbi, functionName: "getBankruptcyPrice", args: [p.account, pool] })), blockNumber);
  near.forEach((p, i) => { if (bk[i].status === "success") p.bankruptcy = bk[i].result; });
  return {
    pool,
    blockNumber,
    markPrice: snap.markPrice,
    oneBase: snap.oneBase,
    maintenanceMarginBps: snap.maintenanceMarginBps,
    tickSize: book.tickSize,
    lotSize: book.lotSize,
    minQuantity: book.minQuantity,
    holders: { long: longs.length, short: shorts.length },
    unpriced,
    positions,
  };
}
