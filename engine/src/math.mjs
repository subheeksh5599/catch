// Pure functions behind the liquidation map. No I/O: everything here is unit-tested.

export const BPS = 10_000n;

const abs = (x) => (x < 0n ? -x : x);
const divFloor = (a, b) => {
  const q = a / b;
  return (a % b !== 0n && (a < 0n) !== (b < 0n)) ? q - 1n : q;
};

/** Single-market liquidation trigger, identical to the venue SDK's perpLiquidationPrice and
 *  to CatchVault._liquidationPrice. null when flat. */
export function liquidationPrice({ size, equity, mmReq, markPrice, oneBase, maintenanceMarginBps }) {
  if (size === 0n) return null;
  const long = size > 0n;
  const perUnit = long ? BPS - maintenanceMarginBps : BPS + maintenanceMarginBps;
  const delta = divFloor((equity - mmReq) * oneBase * BPS, abs(size) * perUnit);
  const liq = long ? markPrice - delta : markPrice + delta;
  return liq > 0n ? liq : 0n;
}

/** Bucket positions into price bins of `binBps` of the mark, out to `rangeBps` either side.
 *  Long liquidations land below the mark, short liquidations above it. Notional in quote units. */
export function binMap(positions, { markPrice, oneBase, binBps = 25n, rangeBps = 1500n }) {
  const width = (markPrice * binBps) / BPS;
  const lo = markPrice - (markPrice * rangeBps) / BPS;
  const hi = markPrice + (markPrice * rangeBps) / BPS;
  const n = Number((hi - lo) / width) + 1;
  const bins = Array.from({ length: n }, (_, i) => ({
    price: lo + width * BigInt(i) + width / 2n,
    long: 0n,
    short: 0n,
    longAccounts: 0,
    shortAccounts: 0,
  }));
  let outside = 0;
  let alreadyLiquidatable = 0;
  for (const p of positions) {
    if (p.liq == null) continue;
    const notional = (abs(p.size) * p.liq) / oneBase;
    if (p.size > 0n ? p.liq >= markPrice : p.liq <= markPrice) alreadyLiquidatable++;
    if (p.liq < lo || p.liq > hi) {
      outside++;
      continue;
    }
    const i = Math.min(n - 1, Number((p.liq - lo) / width));
    if (p.size > 0n) {
      bins[i].long += notional;
      bins[i].longAccounts++;
    } else {
      bins[i].short += notional;
      bins[i].shortAccounts++;
    }
  }
  return { bins, width, lo, hi, outside, alreadyLiquidatable };
}

/** Notional that liquidates if the mark moves `moveBps` against each side. */
export function atRisk(positions, { markPrice, oneBase }, moveBps) {
  const down = markPrice - (markPrice * moveBps) / BPS;
  const up = markPrice + (markPrice * moveBps) / BPS;
  let long = 0n, short = 0n, accounts = 0;
  for (const p of positions) {
    if (p.liq == null) continue;
    const notional = (abs(p.size) * p.liq) / oneBase;
    if (p.size > 0n && p.liq >= down) { long += notional; accounts++; }
    if (p.size < 0n && p.liq <= up) { short += notional; accounts++; }
  }
  return { long, short, accounts };
}

/** Where the engine can close a position into the book: [liq - maxSpread, liq] for a long,
 *  floored at the venue's bankruptcy price; [liq, liq + maxSpread] for a short, capped at the
 *  bankruptcy price when it is reported above liq. Mirrors CatchVault._window. */
export function catchWindow({ size, liq, bankruptcy, spreadBps }) {
  if (liq == null || size === 0n) return null;
  if (size > 0n) {
    let lo = (liq * (BPS - spreadBps)) / BPS;
    if (bankruptcy != null && bankruptcy < liq && bankruptcy > lo) lo = bankruptcy;
    return { lo, hi: liq };
  }
  let hi = (liq * (BPS + spreadBps)) / BPS;
  if (bankruptcy != null && bankruptcy > liq && bankruptcy < hi) hi = bankruptcy;
  return { lo: liq, hi };
}

/** The price inside the most positions' catch windows on one side, on the
 *  tick grid and strictly on the passive side of the mark. Returns the backers the vault
 *  would cite (largest first, at most maxBackers, then sorted by address as the contract
 *  requires) and the size they would force through the book.
 *  isBid=true: longs are sold into bids below the mark. */
export function bestCluster(positions, { markPrice, tickSize, isBid, spreadBps, maxBackers = 8, maxDistanceBps = 1500n }) {
  const side = positions.filter((p) => p.liq != null && (isBid ? p.size > 0n : p.size < 0n));
  const bands = [];
  for (const p of side) {
    const w = catchWindow({ ...p, spreadBps });
    let { lo, hi } = w;
    // passive side of the mark only
    if (isBid && hi >= markPrice) hi = markPrice - tickSize;
    if (!isBid && lo <= markPrice) lo = markPrice + tickSize;
    // only levels a plausible move reaches
    const floor = markPrice - (markPrice * maxDistanceBps) / BPS;
    const ceil = markPrice + (markPrice * maxDistanceBps) / BPS;
    if (isBid && lo < floor) lo = floor;
    if (!isBid && hi > ceil) hi = ceil;
    // tick grid: round inward
    lo = ((lo + tickSize - 1n) / tickSize) * tickSize;
    hi = (hi / tickSize) * tickSize;
    if (lo > hi) continue;
    bands.push({ lo, hi, p });
  }
  if (!bands.length) return null;
  // sweep: +size at lo, -size after hi; the best point is always some band's lo
  const events = [];
  for (const b of bands) {
    events.push([b.lo, 0, abs(b.p.size)]);
    events.push([b.hi, 1, -abs(b.p.size)]);
  }
  events.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
  // Score = forced size x how reachable the level is (1 at the mark, 0 at the distance limit),
  // so a heap of positions 15% away does not outrank a real cluster 3% away.
  const reach = (markPrice * maxDistanceBps) / BPS;
  const score = (size, price) => {
    const dist = price > markPrice ? price - markPrice : markPrice - price;
    return dist >= reach ? 0n : (size * (reach - dist)) / reach;
  };
  let cur = 0n, best = -1n, bestPrice = null;
  const consider = (price) => {
    const sc = score(cur, price);
    if (sc > best) { best = sc; bestPrice = price; }
  };
  for (const [price, kind, d] of events) {
    if (kind === 0) { cur += d; consider(price); }
    else { consider(price); cur += d; } // the band's own edge still counts it
  }
  if (bestPrice == null || best <= 0n) return null;
  const inside = bands.filter((b) => b.lo <= bestPrice && bestPrice <= b.hi).map((b) => b.p);
  inside.sort((a, b) => (abs(b.size) > abs(a.size) ? 1 : abs(b.size) < abs(a.size) ? -1 : 0));
  const chosen = inside.slice(0, maxBackers);
  const size = chosen.reduce((s, p) => s + abs(p.size), 0n);
  const backers = chosen.map((p) => p.account).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  return { isBid, price: bestPrice, size, backers, accountsInBand: inside.length, sizeInBand: inside.reduce((t, p) => t + abs(p.size), 0n) };
}

/** Size the vault order: cluster size, clipped to the cluster cap and the venue lot grid. */
export function sizeOrder({ size, price, oneBase, lotSize, minQuantity, capNotional }) {
  let qty = size;
  if ((qty * price) / oneBase > capNotional) qty = (capNotional * oneBase) / price;
  qty = (qty / lotSize) * lotSize;
  return qty >= minQuantity ? qty : 0n;
}

/** Resting book depth (quote notional) inside a price window, from CCXT-style [price, amount] rows. */
export function depthBetween(rows, lo, hi) {
  let n = 0;
  for (const [price, amount] of rows) if (price >= lo && price <= hi) n += price * amount;
  return n;
}
