import { test } from "node:test";
import assert from "node:assert/strict";
import { feedCheck, FEED_RULES } from "../src/pricefeed.mjs";

const E18 = 10n ** 18n;
const now = 1_800_000_000_000;
const feed = (over = {}) => ({ pair: "BTC/USDC:PERP", price: 73_500n * E18, mark: 73_500n * E18, updatedAtMs: now - 1_000, validators: 3, ...over });

test("a fresh agent price close to the venue mark allows quoting", () => {
  const r = feedCheck(feed(), 73_600n * E18, now);
  assert.equal(r.ok, true);
  assert.equal(r.gapBps, 13);
});

test("no agent price for the market refuses", () => {
  assert.equal(feedCheck(null, 1n, now).ok, false);
});

test("a stale agent price refuses", () => {
  const r = feedCheck(feed({ updatedAtMs: now - FEED_RULES.maxAgeMs - 1 }), 73_500n * E18, now);
  assert.equal(r.ok, false);
  assert.match(r.reason, /old/);
});

test("too few agents behind the median refuses", () => {
  assert.equal(feedCheck(feed({ validators: 1 }), 73_500n * E18, now).ok, false);
});

test("a venue mark pushed away from the agents' price refuses", () => {
  const r = feedCheck(feed(), 75_000n * E18, now); // +2.04%
  assert.equal(r.ok, false);
  assert.equal(r.gapBps, 204);
});

test("the gap is measured against the agents' mark when there is one", () => {
  const r = feedCheck(feed({ price: 70_000n * E18 }), 73_500n * E18, now);
  assert.equal(r.ok, true);
});
