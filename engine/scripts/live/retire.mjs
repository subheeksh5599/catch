// Retire a vault: redeem every operator share (the vault cancels its own orders to free the
// collateral) and remove its reactivity subscription. Moves the record to <network>-<tag>.json.
//   node scripts/live/retire.mjs [network] [tag]
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { SomniaMarkets } from "@somnia-chain/markets-sdk";
import { createReactivity, unwrap } from "@somnia-chain/markets-sdk/reactivity";
import { NETWORKS, publicClient, vaultAbi, erc20Abi, bankAbi } from "../../src/chain.mjs";
import { loadAccount, walletFor } from "../../src/signer.mjs";

const [netKey = "hideki", tag = "v1"] = process.argv.slice(2);
const net = NETWORKS[netKey];
const recPath = new URL(`../../../deployments/${netKey}.json`, import.meta.url);
const rec = JSON.parse(readFileSync(recPath, "utf8"));
const account = loadAccount();
const client = publicClient(net), wallet = walletFor(net, account);
const vault = rec.vault;
const rd = (functionName, args = []) => client.readContract({ address: vault, abi: vaultAbi, functionName, args });

// redeem only what the bank holds free, so no order has to be cancelled; open positions stay
// in the old vault with their unwind orders resting, and the remaining shares stay redeemable.
let shares = await rd("balanceOf", [account.address]);
{
  const st = await client.readContract({ address: net.addresses.marginBank, abi: bankAbi, functionName: "getAccountState", args: [vault] });
  const [assets, supply] = await Promise.all([rd("totalAssets"), rd("totalSupply")]);
  const freeShares = (st.unlockedCollateralBalance * 98n / 100n) * supply / assets;
  if (freeShares < shares) shares = freeShares;
}
if (shares > 0n) {
  const gas = await client.estimateContractGas({ account, address: vault, abi: vaultAbi, functionName: "redeem", args: [shares, account.address] });
  const hash = await wallet.writeContract({ address: vault, abi: vaultAbi, functionName: "redeem", args: [shares, account.address], gas: (gas * 15n) / 10n });
  const r = await client.waitForTransactionReceipt({ hash });
  rec.txs.push({ kind: "redeem", tx: hash, block: Number(r.blockNumber), status: r.status });
  console.log("redeem", r.status, hash);
}
const asset = await rd("ASSET");
console.log("operator USDso", Number(await client.readContract({ address: asset, abi: erc20Abi, functionName: "balanceOf", args: [account.address] })) / 1e18);
for (const p of await rd("pools")) console.log("live slots on", p, (await rd("liveSlots", [p])).length);

if (rec.subscription?.subscriptionId && rec.subscription.status !== "removed") {
  const ex = new SomniaMarkets({ chain: net.chain, addresses: net.addresses, indexerUrl: net.indexerUrl });
  const reactivity = createReactivity(ex.client, { wallet });
  const hash = unwrap(await reactivity.unsubscribe(BigInt(rec.subscription.subscriptionId)));
  const r = await client.waitForTransactionReceipt({ hash });
  rec.subscription.unsubscribeTx = hash;
  rec.subscription.status = r.status === "success" ? "removed" : rec.subscription.status;
  rec.txs.push({ kind: "unsubscribe", tx: hash, block: Number(r.blockNumber), status: r.status });
  console.log("unsubscribe", r.status, hash);
}
for (const s of (rec.subscriptions || []).filter((x) => x.status === "active")) {
  const ex = new SomniaMarkets({ chain: net.chain, addresses: net.addresses, indexerUrl: net.indexerUrl });
  const hash = unwrap(await createReactivity(ex.client, { wallet }).unsubscribe(BigInt(s.subscriptionId)));
  const r = await client.waitForTransactionReceipt({ hash });
  s.status = r.status === "success" ? "removed" : s.status;
  s.removedTx = hash;
  rec.txs.push({ kind: "unsubscribe", account: s.account, tx: hash, block: Number(r.blockNumber), status: r.status });
  console.log("unsubscribe", s.account, r.status);
}
rec.retired = { reason: process.env.RETIRE_REASON || "superseded by a redeploy", at: new Date().toISOString() };
writeFileSync(recPath, JSON.stringify(rec, null, 2) + "\n");
renameSync(recPath, new URL(`../../../deployments/${netKey}-${tag}.json`, import.meta.url));
console.log(`moved to deployments/${netKey}-${tag}.json`);
