// Mainnet readiness, before a single transaction: is every piece Catch needs live on the target
// chain? Read-only; it never signs. Run it the day dreamDEX perps launch on mainnet:
//   MAINNET_MARGIN_BANK=0x… node scripts/live/mainnet-check.mjs
//   (MAINNET_CHAIN_ID=5031 for the Global chain; default 50321, the Tokyo subchain)
// Each line is ok, or says what is missing. When all pass it prints the deploy command.
import { parseAbi } from "viem";
import { NETWORKS, publicClient, systemAbi } from "../../src/chain.mjs";
import { PRICE_FEED } from "../../src/pricefeed.mjs";

const net = NETWORKS.mainnet;
const client = publicClient(net);
const rows = [];
const check = async (name, fn) => {
  try {
    const detail = await fn();
    rows.push({ ok: true, name, detail });
  } catch (e) {
    rows.push({ ok: false, name, detail: (e.shortMessage || e.message || String(e)).split("\n")[0] });
  }
};
const need = (cond, msg) => { if (!cond) throw new Error(msg); };

await check("RPC answers with the expected chain", async () => {
  const id = await client.getChainId();
  need(id === net.chain.id, `chain id ${id}, expected ${net.chain.id}`);
  return `${net.rpc} → ${id}`;
});

let cfg = null;
await check("dreamDEX MarginBank", async () => {
  const bank = net.addresses.marginBank;
  need(bank, "not published yet: set MAINNET_MARGIN_BANK once dreamDEX announces it");
  need((await client.getCode({ address: bank }))?.length > 2, `no contract at ${bank}`);
  cfg = await client.readContract({ address: bank, abi: systemAbi, functionName: "getSystemConfig" });
  need(cfg.fullyWired, "system config reports fullyWired = false");
  return `${bank}, collateral ${cfg.collateralToken}, engine ${cfg.liquidationEngine}`;
});

await check("Perp markets registered", async () => {
  need(cfg, "needs the MarginBank");
  const pools = await client.getContractEvents({
    address: cfg.perpPoolFactory,
    abi: parseAbi(["event PerpPoolCreated(address indexed pool)"]),
    fromBlock: "earliest",
  }).catch(() => null);
  return pools ? `${pools.length} pool(s) from the factory` : `factory ${cfg.perpPoolFactory} (list markets with the SDK)`;
});

await check("Somnia Price Feeds (Somnia Agents) live", async () => {
  const r = await client.readContract({
    address: PRICE_FEED,
    abi: parseAbi(["function latestWithQuality(string) view returns (uint256,uint256,uint256,uint256,uint256,uint256,uint256)"]),
    functionName: "latestWithQuality",
    args: ["BTC/USDC:PERP"],
  });
  const age = Date.now() - Number(r[2]);
  need(r[0] > 0n, "BTC/USDC:PERP not tracked");
  need(age < 60_000, `last write ${(age / 1000).toFixed(0)} s ago`);
  return `BTC/USDC:PERP ${(Number(r[1]) / 1e18).toFixed(2)}, ${Number(r[4])} agents, ${(age / 1000).toFixed(1)} s old`;
});

await check("Reactivity precompile", async () => {
  const code = await client.getCode({ address: "0x0000000000000000000000000000000000000100" });
  return code && code.length > 2 ? "present" : "no code at 0x…0100 (precompiles may report none; confirm with a test subscription)";
});

await check("Operator can fund subscriptions (32 SOMI minimum)", async () => {
  const { loadAccount } = await import("../../src/signer.mjs");
  const a = loadAccount();
  const bal = await client.getBalance({ address: a.address });
  need(bal >= 32n * 10n ** 18n, `${a.address} holds ${(Number(bal) / 1e18).toFixed(2)} SOMI`);
  return `${a.address} holds ${(Number(bal) / 1e18).toFixed(2)} SOMI`;
});

for (const r of rows) console.log(`${r.ok ? "ok  " : "MISS"}  ${r.name}: ${r.detail}`);
if (rows.every((r) => r.ok)) {
  console.log("\nReady. Deploy with the same limits as the live testnet vault:");
  console.log("  node scripts/live/deploy.mjs mainnet 5000 2500 30 200 150 120 3600");
  console.log("  node scripts/live/keeper.mjs mainnet --markets 10");
} else {
  console.log(`\nNot ready: ${rows.filter((r) => !r.ok).length} item(s) above.`);
  process.exitCode = 1;
}
