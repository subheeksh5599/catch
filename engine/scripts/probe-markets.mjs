// Probe market metadata + order book reads on Hideki.
import { SomniaMarkets, SOMNIA_HIDEKI_TESTNET_ADDRESSES } from "@somnia-chain/markets-sdk";
import { hidekiTestnet } from "@somnia-chain/markets-sdk/chains";
const j = (x) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v));
const ex = new SomniaMarkets({ chain: hidekiTestnet, addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES, indexerUrl: "https://hideki-dev.smk.somnia.host/v1/graphql" });
const m = await ex.loadMarkets();
const perps = Object.values(m).filter((x) => x.type === "swap" || x.swap || x.contract);
console.log("markets", Object.keys(m).length, "perps", perps.length);
console.log(j(perps.slice(0, 2)).slice(0, 1500));
const sym = perps[0]?.symbol;
const ob = await ex.fetchOrderBook(sym, 20);
console.log(sym, "bids", ob.bids.length, j(ob.bids.slice(0, 5)), "asks", j(ob.asks.slice(0, 5)));
process.exit(0);
