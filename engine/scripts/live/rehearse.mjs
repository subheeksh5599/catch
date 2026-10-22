// Rehearse against the live venue without spending anything: simulate the vault's constructor
// with eth_call, then load the resulting runtime at a scratch address via a state override and
// ask it for catch windows of real accounts. The engine's own math must agree exactly.
//   node scripts/live/rehearse.mjs [network] [pool]
import { readFileSync } from "node:fs";
import { encodeDeployData, decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";
import { NETWORKS, publicClient, systemAbi, engineAbi } from "../../src/chain.mjs";
import { snapshotPool } from "../../src/reader.mjs";
import { catchWindow, bestCluster } from "../../src/math.mjs";

const netKey = process.argv[2] || "hideki";
const net = NETWORKS[netKey];
const pool = process.argv[3] || "0x4181dd08E73BbCdd1Ba3E615A18f6abD941b94C0";
const client = publicClient(net);
const art = JSON.parse(readFileSync(new URL("../../../contracts/out/CatchVault.sol/CatchVault.json", import.meta.url), "utf8"));
const FROM = "0x00000000000000000000000000000000000ca7c4";

const data = encodeDeployData({ abi: art.abi, bytecode: art.bytecode.object, args: [net.addresses.marginBank, 2500n, 1000n, 30n] });
const { data: runtime } = await client.call({ account: FROM, data, gas: 200_000_000n });
console.log("constructor ran against the live MarginBank; runtime bytes", (runtime.length - 2) / 2);

const AT = "0x00000000000000000000000000000000000ca7c5";
const abi = parseAbi([
  "function catchWindow(address account, address pool) view returns (uint256 lo, uint256 hi)",
  "function liquidationPrice(address account, address pool) view returns (uint256)",
  "function ASSET() view returns (address)",
  "function ENGINE() view returns (address)",
]);
let pin; // block the comparison is pinned to, so chain and engine see the same state
const call = async (functionName, args = []) => {
  const r = await client.call({ to: AT, data: encodeFunctionData({ abi, functionName, args }), stateOverride: [{ address: AT, code: runtime }], blockNumber: pin });
  return decodeFunctionResult({ abi, functionName, data: r.data });
};
const cfg = await client.readContract({ address: net.addresses.marginBank, abi: systemAbi, functionName: "getSystemConfig" });
const spread = await client.readContract({ address: cfg.liquidationEngine, abi: engineAbi, functionName: "getMaxLiquidationSpreadBps" });
console.log("ASSET", await call("ASSET"), "== collateral", cfg.collateralToken);
console.log("ENGINE", await call("ENGINE"), "== engine", cfg.liquidationEngine, "spread bps", spread);

const s = await snapshotPool(client, { bank: net.addresses.marginBank, pool });
pin = s.blockNumber;
console.log("pinned to block", pin);
const picks = [true, false].map((isBid) => bestCluster(s.positions, { markPrice: s.markPrice, tickSize: s.tickSize, isBid, spreadBps: spread })).filter(Boolean);
let checked = 0, agree = 0, same = 0;
for (const c of picks) {
  for (const a of c.backers) {
    const p = s.positions.find((x) => x.account === a);
    const mine = catchWindow({ ...p, spreadBps: spread });
    const [lo, hi] = await call("catchWindow", [a, pool]);
    const liq = await call("liquidationPrice", [a, pool]);
    checked++;
    const ok = lo <= c.price && c.price <= hi;
    const exact = lo === mine.lo && hi === mine.hi;
    if (exact) same++;
    if (ok) agree++;
    console.log(c.isBid ? "bid" : "ask", a.slice(0, 10), "engine", mine.lo, mine.hi, "| contract", lo, hi, "liq", liq, ok ? "contains price" : "MISS");
  }
}
console.log(`${agree}/${checked} backers' on-chain windows contain the proposed price; ${same}/${checked} identical to the wei`);
process.exit(agree === checked ? 0 : 1);
