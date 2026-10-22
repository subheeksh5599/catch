// Deploy CatchVault on a network and record it in deployments/<network>.json.
//   node scripts/live/deploy.mjs [network] [marketCapBps] [clusterCapBps] [unwindSpreadBps]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { encodeDeployData } from "viem";
import { NETWORKS, publicClient, vaultAbi } from "../../src/chain.mjs";
import { loadAccount, walletFor } from "../../src/signer.mjs";

const [netKey = "hideki", mcap = "2500", ccap = "1000", spread = "30"] = process.argv.slice(2);
const net = NETWORKS[netKey];
const account = loadAccount();
const client = publicClient(net), wallet = walletFor(net, account);
const art = JSON.parse(readFileSync(new URL("../../../contracts/out/CatchVault.sol/CatchVault.json", import.meta.url), "utf8"));
const args = [net.addresses.marginBank, BigInt(mcap), BigInt(ccap), BigInt(spread)];
const data = encodeDeployData({ abi: art.abi, bytecode: art.bytecode.object, args });

const gas = await client.estimateGas({ account: account.address, data });
console.log("operator", account.address, "estimate", gas);
const hash = await wallet.sendTransaction({ data, gas: (gas * 13n) / 10n });
const r = await client.waitForTransactionReceipt({ hash });
if (r.status !== "success" || !r.contractAddress) throw new Error(`deploy failed ${hash}`);
const code = await client.getCode({ address: r.contractAddress });
if (!code || code === "0x") throw new Error("no code at the deployed address");
const bank = await client.readContract({ address: r.contractAddress, abi: vaultAbi, functionName: "BANK" });
const asset = await client.readContract({ address: r.contractAddress, abi: vaultAbi, functionName: "ASSET" });

const rec = {
  network: netKey,
  chainId: net.chain.id,
  vault: r.contractAddress,
  deployTx: hash,
  deployBlock: Number(r.blockNumber),
  operator: account.address,
  args: { marginBank: args[0], marketCapBps: Number(mcap), clusterCapBps: Number(ccap), unwindSpreadBps: Number(spread) },
  readBack: { bank, asset },
  txs: [],
};
mkdirSync(new URL("../../../deployments/", import.meta.url), { recursive: true });
writeFileSync(new URL(`../../../deployments/${netKey}.json`, import.meta.url), JSON.stringify(rec, null, 2) + "\n");
console.log("CatchVault", r.contractAddress, "tx", hash, "block", r.blockNumber);
