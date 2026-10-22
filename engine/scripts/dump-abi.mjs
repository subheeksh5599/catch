// Dump the exact ABI items Catch's contracts call, straight from the SDK, so the Solidity
// interfaces are transcribed from the venue's own definitions rather than guessed.
import * as sdk from "@somnia-chain/markets-sdk";
import { writeFileSync } from "node:fs";

const want = {
  perpPoolWriteAbi: ["placeOrder", "cancelOrder", "cancelOrders"],
  orderBookBatchWriteAbi: ["amendOrders", "placeOrders", "cancelOrders"],
  marginBankWriteAbi: ["deposit", "withdraw"],
  marginBankReadAbi: null,
  perpPoolReadAbi: null,
  marginBankEventsAbi: ["PositionUpdated", "Deposit", "Withdraw"],
  liquidationEngineEventsAbi: ["AccountLiquidated", "PositionLiquidated"],
};
const out = {};
const all = Object.entries(sdk).filter(([k, v]) => Array.isArray(v) && v[0] && typeof v[0] === "object" && "type" in v[0]);
console.log("abi exports:", all.map(([k]) => k).join(" "));
for (const [k, names] of Object.entries(want)) {
  const abi = sdk[k] ?? sdk.TradeAbi?.[k] ?? sdk.ReadsAbi?.[k];
  if (!abi) { console.log("missing", k); continue; }
  out[k] = names ? abi.filter((i) => names.includes(i.name)) : abi;
}
writeFileSync(new URL("../abi/venue.json", import.meta.url), JSON.stringify(out, null, 1));
for (const [k, v] of Object.entries(out)) console.log(k, v.map((i) => `${i.type}:${i.name}(${(i.inputs || []).map((x) => x.type).join(",")})`).join("  "));
