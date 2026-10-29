// Send STT from Hideki back to Shannon over the bridge, so the operator can pay gas on Shannon
// (where USDso has a public test mint).   node scripts/live/gas-to-shannon.mjs <stt>
import { parseEther, formatEther } from "viem";
import { createBridgeTransfer, sendBridgeStep, BridgeToken, ChainId } from "@somnia-chain/markets-sdk/chains";
import { NETWORKS, publicClient } from "../../src/chain.mjs";
import { loadAccount } from "../../src/signer.mjs";

const stt = process.argv[2] || "4";
const account = loadAccount();
const hc = publicClient(NETWORKS.hideki), sc = publicClient(NETWORKS.shannon);
const before = await sc.getBalance({ address: account.address });
const plan = createBridgeTransfer({ token: BridgeToken.STT, from: ChainId.hidekiTestnet, to: ChainId.somniaShannon, amount: parseEther(stt), recipient: account.address });
const r = await sendBridgeStep(hc, plan.bridgeStep, { account });
console.log("bridge STT hideki -> shannon", r.transactionHash, r.status);
for (let i = 0; i < 60; i++) {
  await new Promise((res) => setTimeout(res, 5000));
  const b = await sc.getBalance({ address: account.address });
  if (b > before) { console.log("delivered; shannon STT", formatEther(b)); process.exit(0); }
}
console.log("not delivered yet");
