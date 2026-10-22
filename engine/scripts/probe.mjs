// Probe the live perps plane on Shannon and Hideki: markets, engine, bidders, positions, liquidations.
import { SomniaMarkets, SOMNIA_TESTNET_ADDRESSES, SOMNIA_HIDEKI_TESTNET_ADDRESSES } from "@somnia-chain/markets-sdk";
import { somniaShannon, hidekiTestnet } from "@somnia-chain/markets-sdk/chains";

const nets = [
  { name: "shannon", chain: somniaShannon, addresses: SOMNIA_TESTNET_ADDRESSES, indexerUrl: "https://dev.smk.somnia.host/v1/graphql" },
  { name: "hideki", chain: hidekiTestnet, addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES, indexerUrl: "https://hideki-dev.smk.somnia.host/v1/graphql" },
];
const j = (x) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v));

for (const n of nets) {
  console.log("=====", n.name);
  try {
    const ex = new SomniaMarkets({ chain: n.chain, addresses: n.addresses, indexerUrl: n.indexerUrl });
    const client = ex.client;
    const mb = n.addresses.marginBank;
    const cfg = await client.getPerpSystemConfig(mb);
    console.log("system", j(cfg));
    const eng = await client.getLiquidationEngineConfig(cfg.liquidationEngine);
    console.log("engine", j(eng));
    const pools = await client.listPerpPoolStatuses({ factory: n.addresses.perpPoolFactory });
    console.log("pools", pools.length, j(pools.map((p) => ({ pool: p.pool ?? p.address, sym: p.symbol, tradeable: p.tradeable, restricted: p.restricted }))));
    for (const p of pools.filter((p) => p.tradeable).slice(0, 4)) {
      const pool = p.pool ?? p.address;
      const L = await client.getPerpSideHolders({ marginBank: mb, pool, isLong: true });
      const S = await client.getPerpSideHolders({ marginBank: mb, pool, isLong: false });
      console.log("holders", pool, "long", L.holders.length, "short", S.holders.length, "block", String(L.asOfBlock));
    }
    const liq = await client.listLiquidations({ limit: 20 });
    console.log("liquidations sample", liq.length, j(liq.slice(0, 3)).slice(0, 1200));
  } catch (e) {
    console.log("ERR", e?.name, e?.message?.slice(0, 600));
  }
}
process.exit(0);
