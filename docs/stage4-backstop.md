# Stage-4 backstop: Catch as a registered bidder

**Status:** built and tested against the real LiquidationEngine; waiting on one owner transaction.
Read it live: `isBidder(0x8d457dd604a7a386e9766f51bb45f9d5faa4431a)` on the engine
`0xA66d3C24Ad4a389d863846905D8173e1017e9F4D`.

## What stage 4 is

When the engine can't close a liquidated position into the book, it offers the whole position to
its registered bidders. Each bidder quotes a price, and the winning bidder takes the position over
at that price (`PositionTakenOver`). Two bidders are registered on Hideki today, and they took over
positions as large as 89 ETH. Without a bidder, the waterfall goes on to auto-deleveraging, which
closes positions held by other traders.

## What Catch does there

The engine calls each bidder with selector `0x6627a0db`:

```
(address account, address pool, int256 size, uint256 markPrice) -> (bool accept, uint256 price)
```

This is read from a real takeover. In tx `0x08f6988a…4cfe` (block 45,209,705) the engine sent
`(0x734d…bf74, BTC pool, 6162000, 73,898.53…)` and the bidder answered `(true, 73,076.68…)`,
the same price as in the event. The name behind the selector isn't published, so Catch answers
it from `fallback` and pins it as `TAKEOVER_QUOTE_SELECTOR`.

Catch's answer (`takeoverQuote`, a public view anyone can call):

| Rule | Same rule as for a book order |
|---|---|
| Price: 100 bps under the mark for a long, over it for a short, clamped into the engine's own [min, max] spread (50–500 bps on Hideki) | — |
| Says no while the mark is more than 1.5% off the oracle index, or the index is older than 120 s | ✅ |
| Says no above 25% of vault assets in one takeover | ✅ |
| Says no above 50% of assets on one market, or 2% of that market's open interest | ✅ |
| Says no unless the vault can post the initial margin | ✅ |
| Says no to a restricted or unknown market, a zero size, or its own position | ✅ |
| Only the engine can ask (`OnlyEngine`); any other unknown call reverts | — |

A "no" is `(false, 0)`, not a revert, so a declined quote never stops the engine's waterfall.
After a takeover, the vault's own `PositionUpdated` reaches its Reactivity handler, which offers the
position back at or past entry, the same as after a book fill.

## Proof against the real engine

`contracts/test/CatchVault.takeover.fork.t.sol` forks Hideki at block 45,209,704, the block before
that takeover, and runs the engine's deployed bytecode:

1. An outsider calling registration reverts with `OwnableUnauthorizedAccount`.
2. The owner registers Catch with the call the owner made for the live bidder `0x0040…fb99`
   (tx `0xe5572646…c738`). The only difference is the tier list: that bidder covers tier 5,
   Catch covers 1–5 (BTC is tier 1).
3. The test replays the original liquidation transaction byte for byte.
4. **With Catch registered on its own, the engine hands it the BTC long at 73,159.55.**
5. **With both bidders registered, the engine picks Catch.** Its price is better for the
   liquidated trader than the 73,076.68 the live bidder got on chain for the same position.

```bash
python3 contracts/script/hideki-fork-rpc.py 8547 &   # read-only shim: the Hideki RPC rejects EIP-1898 block objects
cd contracts && HIDEKI_RPC=http://127.0.0.1:8547 forge test --match-contract TakeoverFork -vv
```

Mock-venue unit tests for every rule above: `contracts/test/CatchVault.takeover.t.sol`
(13 tests, the fuzz test at 2,000 runs).

## The one transaction it needs

Registration is owner-only: the engine is `Ownable`, owned by
`0xd58596620Ee6951B2958a931949e4ff7ce6222be`. From that address, to the engine:

```
0x1abb67d50000000000000000000000008d457dd604a7a386e9766f51bb45f9d5faa4431a000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000021e19e0c9bab24000000000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000000500000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000300000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000005
```

The arguments are (bidder = Catch v6, `0`, `10,000e18`, tiers `[1,2,3,4,5]`). The two middle
values are the ones the owner used for the live bidder. Simulated from the owner address on the
live chain, it succeeds; from any other address it reverts. To remove Catch later:
`removeBidder(0x8d457dd604a7a386e9766f51bb45f9d5faa4431a)`.
