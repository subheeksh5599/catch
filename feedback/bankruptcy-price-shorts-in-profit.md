# getBankruptcyPrice returns the entry price (or less) for every short that is in profit
Severity: major
Area: contracts

## Steps to reproduce
1. Pick any perps pool on Somnia Hideki whose mark is below many shorts' entry, e.g. HYPE `0x63B47eD4A7DE0FdE659b0d82441dD74828b7297A`.
2. Pin one block and list holders on each side with `MarginBank.getSideHoldersPaginated(pool, isLong, 0, 8)` (MarginBank `0x478769E1177C0773c43A593DCCc4Ad15F15F1394`).
3. For each holder, at that block, read `getPosition(account, pool)`, `getAccountHealth(account)` and `getBankruptcyPrice(account, pool)`.
4. Or run the read-only script in this repo: `feedback/repro/bankruptcy-price-shorts.sh` (needs `cast`, no key).

## Expected
The SDK documents `getBankruptcyPrice` as "the price at which the position's allocated share of the account's equity is exhausted", and says a keeper pays against it. For a short with positive equity, that price is above the current mark, because a short loses money as the price rises. When the short is in profit (mark below entry), it is also above the entry price.

## Actual
For shorts in profit, the function returns exactly `avgEntryPrice` (6 of 7 accounts below), or a price below entry (1 of 7). Neither is a price at which the short's equity is exhausted. For shorts that are losing, and for every long, the value looks right: it moves with equity and sits on the correct side of the mark.

Block 46,830,751, HYPE pool, mark 71.5517:

| Side | Account | Size (base units) | Entry | getBankruptcyPrice | Equity |
|---|---|---|---|---|---|
| short (losing) | `0xb998E3312c1EB86266EE9D3745c54cA58D235160` | −76,180,000 | 70.8419 | 75.3897 | 292.44 |
| short (in profit) | `0xE9a3E9463E714e8922bE2cD570d071934f1Df81A` | −180,000 | 92.6058 | **92.6058 (= entry)** | 14.51 |
| short (in profit) | `0xb8700E8d07Bd029f7dD3CE6CC97Fe936D70c50a8` | −180,000 | 92.9000 | **90.0729 (below entry)** | 18.92 |
| short (in profit) | `0x40228f41761A79010d6964C90d2369cAC61Ad284` | −360,000 | 85.2692 | **85.2692 (= entry)** | 95.22 |
| short (in profit) | `0xe6bcDDD703F2b11003534C88b8CDEfF9B37EDCbE` | −180,000 | 93.0700 | **93.0700 (= entry)** | 6.67 |
| short (in profit) | `0x18b2069a61Dd0470CDD62e9D81441edAB87459e0` | −180,000 | 93.0300 | **93.0300 (= entry)** | 21.75 |
| short (in profit) | `0x4FD240AA70e530e72eEA8E4C524fEccc94A6CAB5` | −180,000 | 93.0400 | **93.0400 (= entry)** | 5.58 |
| short (in profit) | `0x731406b8fa10F7dF7fe6971179908926B0dd41E1` | −180,000 | 93.0600 | **93.0600 (= entry)** | 14.37 |
| long | `0x1a6911ac36217dF58361e79B1898a3516B7D5960` | 180,000 | 93.1200 | 67.9415 | 35.69 |
| long | `0xfa2fa3Cb926C1f4fa414edd24EdA062D1F70d083` | 180,000 | 93.2400 | 35.4343 | 69.93 |
| long | `0x55Ff5e6a9a342b11A545a2CF2EeAb1B9fcbC4d11` | 180,000 | 93.0800 | 82.7607 | 1.45 |

The same pattern holds on BTC (`0x4181dd08e73bbcdd1ba3e615a18f6abd941b94c0`, block 46,830,239, mark 73,441.27). Every in-profit short read, e.g. `0x0a9C8033d8aA17c5093cf2535F8cAc776b063AA0` (entry 86,151.9) and `0x51340B4020f973E8D54f3ed7b062381c93a83529` (entry 86,168.8), returned exactly its entry.

The values look like a clamp to the entry price on the short side, or a sign error, when unrealized PnL is positive. Anything that bounds a liquidation or bid price with this figure treats a profitable short's bankruptcy price as below the mark. Our vault had to special-case it: it ignores a short-side bankruptcy figure that is not above the liquidation price.

## Evidence
- Full output, reproducible at any block: `feedback/repro/bankruptcy-price-shorts.sh [pool]`
- Calls: `getBankruptcyPrice(address,address)(uint256)`, `getPosition(address,address)`, `getAccountHealth(address)` on MarginBank `0x478769E1177C0773c43A593DCCc4Ad15F15F1394`, all at the same pinned block
- SDK text this contradicts: `@somnia-chain/markets-sdk` 0.32.1, `docs/PERPS.md` ("the price at which the position's allocated share of the account's equity is exhausted … a keeper pays against this number") and `src/readsAbi.ts`
- Workaround in our contract: `CatchVault._window`, short side (`if (bankruptcy > liq && bankruptcy < hi) hi = bankruptcy;`)

## Environment
SDK `@somnia-chain/markets-sdk` 0.32.1, network Somnia Hideki testnet (chain 50383, RPC `https://api.hideki2.infra.testnet.somnia.network`), wallet `0x68A7Be0E0402dd17EA3CDFfA9Bff84b266F3eE9e` (reads need none)
