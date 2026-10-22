// Register the on-chain reactivity subscription: every MarginBank PositionUpdated log calls
// CatchVault.onEvent in the same block. The operator must hold at least 32 STT.
//   node scripts/live/subscribe.mjs [network]
import { readFileSync, writeFileSync } from "node:fs";
import { keccak256, toHex } from "viem";
import { createReactivity, unwrap, DEFAULT_SUBSCRIPTION_OPTIONS } from "@somnia-chain/markets-sdk/reactivity";
import { NETWORKS, publicClient } from "../../src/chain.mjs";
import { loadAccount, walletFor } from "../../src/signer.mjs";

const netKey = process.argv[2] || "hideki";
const net = NETWORKS[netKey];
const recPath = new URL(`../../../deployments/${netKey}.json`, import.meta.url);
const rec = JSON.parse(readFileSync(recPath, "utf8"));
const account = loadAccount();
const client = publicClient(net), wallet = walletFor(net, account);
const topic = keccak256(toHex("PositionUpdated(address,address,int128,uint128,int256,int256)"));

const reactivity = createReactivity(client, { wallet });
const hash = unwrap(
  await reactivity.subscribe({
    handlerContractAddress: rec.vault,
    filter: { emitter: net.addresses.marginBank, eventTopics: [topic] },
    options: DEFAULT_SUBSCRIPTION_OPTIONS,
  }),
);
console.log("subscribe tx", hash);
rec.subscription = { tx: hash, emitter: net.addresses.marginBank, topic0: topic };
rec.txs.push({ kind: "subscribe", tx: hash });
writeFileSync(recPath, JSON.stringify(rec, null, 2) + "\n");
