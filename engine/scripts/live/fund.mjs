// Fund the operator on Hideki: mint USDso on Shannon (public test mint), then bridge STT and
// USDso to Hideki over the venue's Hyperlane lane. Prints balances and tx hashes only.
//   node scripts/live/fund.mjs <sttToBridge> <usdsoToBridge>
import { parseEther, formatEther } from "viem";
import { createBridgeTransfer, sendBridgeStep, BridgeToken, ChainId } from "@somnia-chain/markets-sdk/chains";
import { NETWORKS, publicClient, erc20Abi } from "../../src/chain.mjs";
import { loadAccount, walletFor } from "../../src/signer.mjs";

const [stt = "36", usd = "20000"] = process.argv.slice(2);
const account = loadAccount();
const shannon = NETWORKS.shannon, hideki = NETWORKS.hideki;
const sc = publicClient(shannon), hc = publicClient(hideki);
const sw = walletFor(shannon, account);
const USDSO_SHANNON = "0x9c32F3827A1a99f0cf9B213de8b53eC3d57bb171";
const USDSO_HIDEKI = "0xed7993A74dAe1e6656B704A424DcD8711aAf4F72"; // MarginBank collateral on Hideki

const bal = async () => ({
  shannonSTT: formatEther(await sc.getBalance({ address: account.address })),
  shannonUSDso: formatEther(await sc.readContract({ address: USDSO_SHANNON, abi: erc20Abi, functionName: "balanceOf", args: [account.address] })),
  hidekiSTT: formatEther(await hc.getBalance({ address: account.address })),
  hidekiUSDso: formatEther(await hc.readContract({ address: USDSO_HIDEKI, abi: erc20Abi, functionName: "balanceOf", args: [account.address] })),
});

console.log("operator", account.address);
console.log("before", await bal());

const usdAmount = parseEther(usd);
const have = await sc.readContract({ address: USDSO_SHANNON, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
if (have < usdAmount) {
  const h = await sw.writeContract({ address: USDSO_SHANNON, abi: erc20Abi, functionName: "mint", args: [account.address, usdAmount - have], gas: 500_000n });
  await sc.waitForTransactionReceipt({ hash: h });
  console.log("mint USDso on Shannon", h);
}

for (const [token, amount] of [[BridgeToken.USDso, usdAmount], [BridgeToken.STT, parseEther(stt)]]) {
  if (amount === 0n) continue;
  const plan = createBridgeTransfer({ token, from: ChainId.somniaShannon, to: ChainId.hidekiTestnet, amount, recipient: account.address });
  if (plan.approveStep) {
    const r = await sendBridgeStep(sc, plan.approveStep, { account });
    console.log(`approve ${token}`, r.transactionHash);
  }
  const r = await sendBridgeStep(sc, plan.bridgeStep, { account });
  console.log(`bridge ${token}`, r.transactionHash);
}

for (let i = 0; i < 36; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const b = await bal();
  if (Number(b.hidekiSTT) > 0 && Number(b.hidekiUSDso) > 0) { console.log("after", b); process.exit(0); }
}
console.log("bridge not yet delivered", await bal());
