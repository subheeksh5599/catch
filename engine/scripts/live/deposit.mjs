// Deposit USDso into the live vault from any key file, for yourself (the contract refuses a
// deposit made for someone else). Records the approve and deposit hashes in the deployment.
//   CATCH_KEY_FILE=~/.catch/other.key node scripts/live/deposit.mjs [network] <amount>
import { readFileSync, writeFileSync } from "node:fs";
import { parseEther } from "viem";
import { NETWORKS, publicClient, vaultAbi, erc20Abi } from "../../src/chain.mjs";
import { loadAccount, walletFor } from "../../src/signer.mjs";

const [netKey = "hideki", amountText] = process.argv.slice(2);
if (!amountText) throw new Error("usage: deposit.mjs <network> <amount>");
const net = NETWORKS[netKey];
const path = new URL(`../../../deployments/${netKey}.json`, import.meta.url);
const rec = JSON.parse(readFileSync(path, "utf8"));
const account = loadAccount();
const client = publicClient(net), wallet = walletFor(net, account);
const amount = parseEther(amountText);
const asset = await client.readContract({ address: rec.vault, abi: vaultAbi, functionName: "ASSET" });
const bal = await client.readContract({ address: asset, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
if (bal < amount) throw new Error(`${account.address} holds ${Number(bal) / 1e18} USDso`);

const send = async (address, abi, functionName, args) => {
  const gas = await client.estimateContractGas({ account, address, abi, functionName, args });
  const hash = await wallet.writeContract({ address, abi, functionName, args, gas: (gas * 15n) / 10n });
  const r = await client.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${functionName} reverted ${hash}`);
  return { hash, block: Number(r.blockNumber) };
};
const allowance = await client.readContract({ address: asset, abi: erc20Abi, functionName: "allowance", args: [account.address, rec.vault] });
if (allowance < amount) {
  const a = await send(asset, erc20Abi, "approve", [rec.vault, amount]);
  rec.txs.push({ kind: "approve", tx: a.hash, block: a.block, from: account.address });
}
const d = await send(rec.vault, vaultAbi, "deposit", [amount, account.address]);
rec.txs.push({ kind: "deposit", tx: d.hash, block: d.block, status: "success", amount: amountText, from: account.address });
writeFileSync(path, JSON.stringify(rec, null, 2) + "\n");
const unlock = await client.readContract({ address: rec.vault, abi: vaultAbi, functionName: "unlockAt", args: [account.address] });
console.log("deposit", d.hash, "by", account.address, "redeemable from", new Date(Number(unlock) * 1000).toISOString());
