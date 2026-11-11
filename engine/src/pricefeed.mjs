// Somnia Price Feeds: Somnia Agents subcommittees price each pair across exchanges every 500 ms
// on the Tokyo subchain and write the median on chain (spot, plus an EMA mark). The venue's own
// index reads this same contract; the keeper reads it directly, with a much shorter freshness
// bound than the vault's on-chain index-age limit, before it quotes a market.
import { parseAbi } from "viem";

export const PRICE_FEED = "0x1998C88D54a240b8C671493f27f58eC416b81D7F"; // same proxy on Tokyo mainnet and testnet

export const FEED_RULES = {
  // the feed ticks every 500 ms but its writes stall for 20-40 s at times (feedHealth reports
  // failures); 15 s refuses through a stall without stopping on every late tick
  maxAgeMs: 15_000,
  minValidators: 2, // agents that backed the median
  maxGapBps: 150, // venue mark vs the agents' price
};

const abi = parseAbi([
  "function latestWithQuality(string symbol) view returns (uint256 price, uint256 markPrice, uint256 updatedAtMs, uint256 sourceUpdatedAtMs, uint256 validatorCount, uint256 medianControlCount, uint256 flags)",
]);

/** The agents' price for a market's base asset: the perpetual composite when the feed tracks
 *  one (closest to what a perp mark should be), else spot. Null when the feed has neither. */
export async function readFeed(client, base) {
  for (const pair of [`${base}/USDC:PERP`, `${base}/USDC`]) {
    const r = await client.readContract({ address: PRICE_FEED, abi, functionName: "latestWithQuality", args: [pair] }).catch(() => null);
    if (r && r[0] > 0n) {
      return { pair, price: r[0], mark: r[1], updatedAtMs: Number(r[2]), sourceUpdatedAtMs: Number(r[3]), validators: Number(r[4]) };
    }
  }
  return null;
}

/** Whether the keeper may quote a market whose venue mark is `venueMark`. Pure, for tests. */
export function feedCheck(feed, venueMark, nowMs, rules = FEED_RULES) {
  if (!feed) return { ok: false, reason: "no agent price for this market" };
  const ageMs = nowMs - feed.updatedAtMs;
  if (ageMs > rules.maxAgeMs) return { ok: false, reason: `agent price ${(ageMs / 1000).toFixed(1)} s old`, ageMs };
  if (feed.validators < rules.minValidators) return { ok: false, reason: `${feed.validators} agent(s) behind the price`, ageMs };
  const ref = feed.mark > 0n ? feed.mark : feed.price;
  const gap = venueMark > ref ? venueMark - ref : ref - venueMark;
  const gapBps = Number((gap * 10_000n) / ref);
  if (gapBps > rules.maxGapBps) return { ok: false, reason: `venue mark ${(gapBps / 100).toFixed(2)}% from the agents' price`, ageMs, gapBps };
  return { ok: true, ageMs, gapBps };
}
