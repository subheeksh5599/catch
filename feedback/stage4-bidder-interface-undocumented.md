# Stage-4 bidder interface and registration are undocumented
Severity: normal
Area: docs

## Steps to reproduce
1. Read the SDK (`@somnia-chain/markets-sdk`) and the docs for how to become a stage-4 backstop bidder. The SDK reads `getBidderCount()` and `getBidders()`, and its comments say that zero bidders sends liquidations to ADL. Nothing describes what a bidder must implement or how to register.
2. Check the LiquidationEngine (`0xA66d3C24Ad4a389d863846905D8173e1017e9F4D`, implementation `0x7239a3bd…01ef`) for a registration function. Its selectors decode to `isBidder`, `removeBidder`, `getBidders` and `getBidderCount`, but no add or register function appears in any public signature database.
3. Find a real registration (tx `0xe5572646b8cd72de0bf4e523c4fc2ec4c1d8324f54c0001300b4e973fae1c738`, block 46,662,907). It calls `0x1abb67d5(address bidder, uint256 0, uint256 10000e18, uint256[] [5])`, sent by the owner.
4. Call the same function from any other address. It reverts with `OwnableUnauthorizedAccount(sender)`.
5. Trace a takeover (tx `0x08f6988aedeffe2e3e4e21b34e34d5e3d02b9674eb764f929f0c0001648a4cfe`). The engine calls the bidder with `0x6627a0db(address account, address pool, int256 size, uint256 markPrice)` and reads `(bool accept, uint256 price)`. This name isn't in any public signature database either.
6. Register a bidder with tiers `[5]` and replay a BTC liquidation on a fork. The engine never asks it, because BTC is tier 1 (`MarginBank.getPoolTier`). The last registration argument is a list of market tiers, which is also undocumented.

## Expected
Docs, or SDK types, that describe:
- the bidder callback: name, arguments, return value, and how the engine chooses between bidders;
- what registration's arguments mean (the two numbers and the tier list);
- that registration is owner-only, and how a builder applies (for example a Discord ticket).

## Actual
None of this is documented. A builder has to recover the interface from transaction traces and
calldata, and learns about the tier list only when a fork test fails without any error.

## Evidence
- Owner-only registration (Hideki, `eth_call` at latest): from `0xd58596620Ee6951B2958a931949e4ff7ce6222be` it returns `0x`; from `0x68A7Be0E0402dd17EA3CDFfA9Bff84b266F3eE9e` it reverts `0x118cdaa7…` (`OwnableUnauthorizedAccount`).
- Bidder call in the takeover trace: input `0x6627a0db` + `(0x734d…bf74, 0x4181…94c0, 6162000, 0xfa60c2ae11ce26721a0)`, output `(1, 0xf797ea9ae85415d2f68)` = 73,076.68, equal to the `PositionTakenOver` price.
- A full working bidder, tested against the deployed engine on a fork: `docs/stage4-backstop.md`, `contracts/test/CatchVault.takeover.fork.t.sol`.

## Environment
@somnia-chain/markets-sdk (engine/package.json), Somnia Hideki testnet (chain 50383), wallet 0x68A7Be0E0402dd17EA3CDFfA9Bff84b266F3eE9e
