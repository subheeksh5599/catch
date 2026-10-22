import { test } from "node:test";
import assert from "node:assert/strict";
import { perpLiquidationPrice } from "@somnia-chain/markets-sdk";
import { liquidationPrice, binMap, atRisk, bestCluster, sizeOrder, depthBetween, catchWindow } from "../src/math.mjs";

const E18 = 10n ** 18n;
const base = { markPrice: 60_000n * E18, oneBase: E18, maintenanceMarginBps: 250n };

test("liquidation price matches the venue SDK for longs and shorts", () => {
  const cases = [
    { size: E18, equity: 975n * E18, mmReq: 0n },
    { size: -E18, equity: 1_025n * E18, mmReq: 0n },
    { size: 3n * E18, equity: 12_345n * E18, mmReq: 4_500n * E18 },
    { size: -7n * E18 / 10n, equity: 900n * E18, mmReq: 1_050n * E18 },
  ];
  for (const c of cases) {
    const a = liquidationPrice({ ...base, ...c });
    const b = perpLiquidationPrice({ ...base, ...c });
    assert.equal(a, b);
  }
});

test("liquidation price: the contract's worked examples", () => {
  assert.equal(liquidationPrice({ ...base, size: E18, equity: 975n * E18, mmReq: 0n }), 59_000n * E18);
  assert.equal(liquidationPrice({ ...base, size: -E18, equity: 1_025n * E18, mmReq: 0n }), 61_000n * E18);
  assert.equal(liquidationPrice({ ...base, size: 0n, equity: 1n, mmReq: 0n }), null);
});

test("bins put longs below the mark and shorts above", () => {
  const pos = [
    { size: E18, liq: 59_000n * E18 },
    { size: -E18, liq: 61_000n * E18 },
    { size: E18, liq: 10_000n * E18 }, // outside the range
  ];
  const m = binMap(pos, { markPrice: base.markPrice, oneBase: E18, binBps: 50n, rangeBps: 1000n });
  const longBin = m.bins.find((b) => b.long > 0n);
  const shortBin = m.bins.find((b) => b.short > 0n);
  assert.ok(longBin.price < base.markPrice && shortBin.price > base.markPrice);
  assert.equal(longBin.long, 59_000n * E18);
  assert.equal(m.outside, 1);
});

test("at-risk counts only positions inside the move", () => {
  const pos = [
    { size: E18, liq: 59_500n * E18 },
    { size: E18, liq: 50_000n * E18 },
    { size: -E18, liq: 60_400n * E18 },
  ];
  const r = atRisk(pos, { markPrice: base.markPrice, oneBase: E18 }, 100n); // 1%
  assert.equal(r.accounts, 2);
  assert.equal(r.long, 59_500n * E18);
  assert.equal(r.short, 60_400n * E18);
});

test("best cluster finds the price inside the most bands", () => {
  const T = 10n ** 16n;
  const pos = [
    { account: "0x0000000000000000000000000000000000000003", size: E18, liq: 59_000n * E18, bankruptcy: 58_500n * E18 },
    { account: "0x0000000000000000000000000000000000000001", size: 2n * E18, liq: 58_900n * E18, bankruptcy: 58_600n * E18 },
    { account: "0x0000000000000000000000000000000000000002", size: E18, liq: 57_000n * E18, bankruptcy: 56_000n * E18 },
    { account: "0x0000000000000000000000000000000000000009", size: -E18, liq: 61_000n * E18, bankruptcy: 61_500n * E18 },
  ];
  const c = bestCluster(pos, { markPrice: base.markPrice, tickSize: T, isBid: true, spreadBps: 500n });
  assert.equal(c.size, 3n * E18);
  assert.ok(c.price >= 58_600n * E18 && c.price <= 58_900n * E18);
  assert.deepEqual(c.backers, ["0x0000000000000000000000000000000000000001", "0x0000000000000000000000000000000000000003"]);
  const s = bestCluster(pos, { markPrice: base.markPrice, tickSize: T, isBid: false, spreadBps: 500n });
  assert.equal(s.size, E18);
  assert.ok(s.price >= 61_000n * E18 && s.price <= 61_500n * E18);
});

test("best cluster never sits on the aggressive side of the mark", () => {
  const T = 10n ** 16n;
  const pos = [{ account: "0x01", size: E18, liq: 60_100n * E18, bankruptcy: 59_900n * E18 }]; // already liquidatable
  const c = bestCluster(pos, { markPrice: base.markPrice, tickSize: T, isBid: true, spreadBps: 500n });
  assert.ok(c.price < base.markPrice);
});

test("best cluster caps backers", () => {
  const pos = Array.from({ length: 12 }, (_, i) => ({
    account: "0x" + (i + 1).toString(16).padStart(40, "0"),
    size: BigInt(i + 1) * E18,
    liq: 59_000n * E18,
    bankruptcy: 58_000n * E18,
  }));
  const c = bestCluster(pos, { markPrice: base.markPrice, tickSize: 10n ** 16n, isBid: true, spreadBps: 500n, maxBackers: 8 });
  assert.equal(c.backers.length, 8);
  assert.equal(c.accountsInBand, 12);
  assert.equal(c.size, (5n + 6n + 7n + 8n + 9n + 10n + 11n + 12n) * E18);
});

test("order sizing respects the cap, lot and minimum", () => {
  const q = sizeOrder({ size: 5n * E18, price: 50_000n * E18, oneBase: E18, lotSize: 10n ** 15n, minQuantity: 10n ** 15n, capNotional: 10_000n * E18 });
  assert.equal(q, 2n * E18 / 10n);
  const z = sizeOrder({ size: 10n ** 14n, price: 50_000n * E18, oneBase: E18, lotSize: 10n ** 15n, minQuantity: 10n ** 15n, capNotional: 10_000n * E18 });
  assert.equal(z, 0n);
});

test("depth inside a window", () => {
  assert.equal(depthBetween([[10, 2], [9, 1], [5, 100]], 8, 10), 29);
});

test("catch window mirrors the contract's worked examples", () => {
  const w = (o) => catchWindow({ spreadBps: 500n, ...o });
  assert.deepEqual(w({ size: E18, liq: 59_000n * E18, bankruptcy: 58_500n * E18 }), { lo: 58_500n * E18, hi: 59_000n * E18 });
  assert.deepEqual(w({ size: E18, liq: 59_000n * E18, bankruptcy: 50_000n * E18 }), { lo: 56_050n * E18, hi: 59_000n * E18 });
  assert.deepEqual(w({ size: -E18, liq: 61_000n * E18, bankruptcy: 60_000n * E18 }), { lo: 61_000n * E18, hi: 64_050n * E18 });
  assert.deepEqual(w({ size: -E18, liq: 61_000n * E18, bankruptcy: 61_500n * E18 }), { lo: 61_000n * E18, hi: 61_500n * E18 });
  assert.equal(w({ size: 0n, liq: 1n }), null);
});

test("best cluster ignores levels beyond the distance limit", () => {
  const pos = [
    { account: "0x01", size: 100n * E18, liq: 30_000n * E18, bankruptcy: 29_000n * E18 }, // -50%
    { account: "0x02", size: E18, liq: 58_000n * E18, bankruptcy: 57_500n * E18 },
  ];
  const c = bestCluster(pos, { markPrice: base.markPrice, tickSize: 10n ** 16n, isBid: true, spreadBps: 500n, maxDistanceBps: 1500n });
  assert.equal(c.size, E18);
  assert.deepEqual(c.backers, ["0x02"]);
});

test("best cluster prefers a reachable level over a bigger, distant one", () => {
  const pos = [
    { account: "0x01", size: 3n * E18, liq: 52_000n * E18, bankruptcy: 51_500n * E18 }, // -13%
    { account: "0x02", size: 2n * E18, liq: 58_800n * E18, bankruptcy: 58_000n * E18 }, // -2%
  ];
  const c = bestCluster(pos, { markPrice: base.markPrice, tickSize: 10n ** 16n, isBid: true, spreadBps: 500n });
  assert.deepEqual(c.backers, ["0x02"]);
  assert.equal(c.price, 58_800n * E18, "at the edge nearest the mark");
});
