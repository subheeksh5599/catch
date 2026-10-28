// Register the on-chain reactivity subscription: every MarginBank PositionUpdated log calls
// CatchVault.onEvent in the same block. The operator must hold at least 32 STT.
//   node scripts/live/subscribe.mjs [network]
import { readFileSync, writeFileSync } from "node:fs";
import { decodeEventLog, keccak256, toHex } from "viem";
import {
  createReactivity,
  unwrap,
  DEFAULT_SUBSCRIPTION_OPTIONS,
  SOMNIA_REACTIVITY_PRECOMPILE_ADDRESS,
  SomniaReactivityPrecompileABI,
} from "@somnia-chain/markets-sdk/reactivity";
import { SomniaMarkets } from "@somnia-chain/markets-sdk";
import { NETWORKS, publicClient } from "../../src/chain.mjs";
import { loadAccount, walletFor } from "../../src/signer.mjs";

const netKey = process.argv[2] || "hideki";
const net = NETWORKS[netKey];
const recPath = new URL(`../../../deployments/${netKey}.json`, import.meta.url);
const rec = JSON.parse(readFileSync(recPath, "utf8"));
const account = loadAccount();
const client = publicClient(net), wallet = walletFor(net, account);
const ex = new SomniaMarkets({ chain: net.chain, addresses: net.addresses, indexerUrl: net.indexerUrl });
const topic = keccak256(toHex("PositionUpdated(address,address,int128,uint128,int256,int256)"));
const save = () => writeFileSync(recPath, JSON.stringify(rec, null, 2) + "\n");
const argv = process.argv.slice(3);
const retryFailed = argv.includes("--retry");

function recordReceipt(hash, receipt, subscriptionId) {
  const status = receipt.status === "success" ? "confirmed" : "failed";
  rec.subscription = {
    ...rec.subscription,
    tx: hash,
    handler: rec.vault,
    emitter: net.addresses.marginBank,
    topic0: topic,
    status,
    block: Number(receipt.blockNumber),
    ...(subscriptionId == null ? {} : { subscriptionId: subscriptionId.toString() }),
  };
  rec.txs ??= [];
  let tx = rec.txs.find((item) => item.kind === "subscribe" && item.tx === hash);
  if (!tx) {
    tx = { kind: "subscribe", tx: hash };
    rec.txs.push(tx);
  }
  tx.status = receipt.status;
  tx.block = Number(receipt.blockNumber);
  save();
  return status;
}

async function confirmRegistration(hash, receipt) {
  if (receipt.status !== "success") return recordReceipt(hash, receipt);

  const created = receipt.logs
    .filter((log) => log.address.toLowerCase() === SOMNIA_REACTIVITY_PRECOMPILE_ADDRESS.toLowerCase())
    .map((log) => {
      try {
        return decodeEventLog({ abi: SomniaReactivityPrecompileABI, data: log.data, topics: log.topics });
      } catch {
        return null;
      }
    })
    .find((event) => event?.eventName === "SubscriptionCreated");
  if (!created) throw new Error(`subscription transaction ${hash} succeeded without a SubscriptionCreated event`);

  const subscriptionId = created.args.subscriptionId;
  const info = unwrap(await reactivity.getSubscriptionInfo(subscriptionId));
  // the SDK returns [subscriptionData, owner]
  const [data, owner] = Array.isArray(info) ? info : [info.subscriptionData, info.owner];
  if (
    owner.toLowerCase() !== account.address.toLowerCase() ||
    data.handlerContractAddress.toLowerCase() !== rec.vault.toLowerCase() ||
    data.emitter.toLowerCase() !== net.addresses.marginBank.toLowerCase() ||
    data.eventTopics[0].toLowerCase() !== topic.toLowerCase()
  ) {
    throw new Error(`subscription ${subscriptionId} was created, but its owner or filter does not match Catch's expected setup`);
  }
  return recordReceipt(hash, receipt, subscriptionId);
}

const reactivity = createReactivity(ex.client, { wallet });
let hash = rec.subscription?.tx;

if (hash) {
  const existing = rec.subscription;
  if (
    (existing.handler && existing.handler.toLowerCase() !== rec.vault.toLowerCase()) ||
    (existing.emitter && existing.emitter.toLowerCase() !== net.addresses.marginBank.toLowerCase()) ||
    (existing.topic0 && existing.topic0.toLowerCase() !== topic.toLowerCase())
  ) {
    throw new Error(`recorded subscription ${hash} has a different handler or filter; inspect ${recPath.pathname} before registering another`);
  }

  const receipt = await client.getTransactionReceipt({ hash }).catch(() => null);
  if (receipt) {
    const status = await confirmRegistration(hash, receipt);
    if (status === "confirmed") {
      console.log("subscription already confirmed", hash, "block", receipt.blockNumber);
      process.exit(0);
    }
    if (!retryFailed) {
      throw new Error(`previous subscription transaction reverted (${hash}); fix the cause, then rerun with --retry`);
    }
    rec.subscription = null;
    save();
    hash = undefined;
  } else {
    console.log("resuming pending subscription", hash);
  }
}

if (!hash) {
  hash = unwrap(await reactivity.subscribe({
    handlerContractAddress: rec.vault,
    filter: { emitter: net.addresses.marginBank, eventTopics: [topic] },
    options: DEFAULT_SUBSCRIPTION_OPTIONS,
  }));
  rec.subscription = {
    tx: hash,
    handler: rec.vault,
    emitter: net.addresses.marginBank,
    topic0: topic,
    status: "submitted",
  };
  rec.txs ??= [];
  rec.txs.push({ kind: "subscribe", tx: hash, status: "submitted" });
  save();
  console.log("subscribe submitted", hash);
}

const receipt = await client.waitForTransactionReceipt({ hash });
const status = await confirmRegistration(hash, receipt);
if (status !== "confirmed") throw new Error(`subscription transaction reverted (${hash})`);
console.log("subscription confirmed", hash, "block", receipt.blockNumber);
