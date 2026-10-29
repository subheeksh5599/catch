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
const HEALTH_COVER = Number(process.env.HEALTH_COVER || 0.95);
const HEALTH_MAX = Number(process.env.HEALTH_MAX || 4000);
const HEALTH_TTL_MS = Number(process.env.HEALTH_TTL_MS || 120_000);
const healthCache = new Map();

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
  // pass 1: every position (cheap)
  const pres = await multicall(client, accounts.map((a) => ({ address: bank, abi: bankAbi, functionName: "getPosition", args: [a, pool] })), blockNumber);
  const open = [];
  for (let i = 0; i < accounts.length; i++) {
    const r = pres[i];
    if (r.status !== "success" || r.result.size === 0n) continue;
    open.push({ account: accounts[i], size: r.result.size, entry: r.result.avgEntryPrice, abs: r.result.size < 0n ? -r.result.size : r.result.size });
  }
  // pass 1b: account health (a full margin walk per account, the expensive read) in size order
  // until HEALTH_COVER of open size is priced, at most HEALTH_MAX accounts. Health is
  // per account, so one read serves every market that account trades for HEALTH_TTL_MS.
  open.sort((a, b) => (b.abs > a.abs ? 1 : b.abs < a.abs ? -1 : 0));
  const total = open.reduce((n, p) => n + p.abs, 0n);
  const cover = BigInt(Math.round(HEALTH_COVER * 10_000));
  const pick = [];
  let covered = 0n;
  for (const p of open) {
    if (pick.length >= HEALTH_MAX || (total > 0n && covered * 10_000n >= total * cover)) break;
    pick.push(p);
    covered += p.abs;
  }
  const now = Date.now();
  const need = [...new Set(pick.map((p) => p.account))].filter((a) => !(healthCache.get(a)?.at > now - HEALTH_TTL_MS));
  const hres = await multicall(client, need.map((a) => ({ address: bank, abi: bankAbi, functionName: "getAccountHealth", args: [a] })), blockNumber);
  need.forEach((a, i) => { if (hres[i].status === "success") healthCache.set(a, { at: now, result: hres[i].result }); });
  const positions = [];
  let unpriced = 0, pricedSize = 0n;
  const picked = new Set(pick.map((p) => p.account));
  for (const p of open) {
    const h = picked.has(p.account) ? healthCache.get(p.account) : null;
    let liq = null, equity = null;
    if (h) {
      const [eq, , mmReq] = h.result;
      equity = eq;
      liq = liquidationPrice({ size: p.size, equity: eq, mmReq, markPrice: snap.markPrice, oneBase: snap.oneBase, maintenanceMarginBps: snap.maintenanceMarginBps });
      pricedSize += p.abs;
    } else unpriced++;
    positions.push({ account: p.account, size: p.size, entry: p.entry, liq, bankruptcy: null, equity });
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
    // share of open size whose liquidation price was read; the rest are the smallest positions
    pricedShare: total > 0n ? Number((pricedSize * 10_000n) / total) / 10_000 : 1,
    positions,
  };
}
