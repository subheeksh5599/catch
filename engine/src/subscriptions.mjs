// Per-account reactivity subscriptions. A venue-wide PositionUpdated filter calls the vault on
// every position change anywhere on dreamDEX (measured ~0.1 STT/min of callbacks on Hideki), so
// the keeper keeps one narrow subscription per account that matters instead: the vault itself
// (its own fills start the unwind) and every account backing a live order. Filter =
// [PositionUpdated, topic1 = account]; emitter = MarginBank; handler = the vault.
import { pad } from "viem";
import { SomniaMarkets } from "@somnia-chain/markets-sdk";
import { createReactivity, unwrap, DEFAULT_SUBSCRIPTION_OPTIONS } from "@somnia-chain/markets-sdk/reactivity";
import { vaultAbi } from "./chain.mjs";

export const POSITION_UPDATED = "0xf7816a375f0ca01053ed213b57908bff79f578810301d50971a5f685529b82de";

/** Accounts the vault needs callbacks for right now. */
export async function wantedAccounts(client, vault) {
  const rd = (functionName, args = []) => client.readContract({ address: vault, abi: vaultAbi, functionName, args });
  const want = new Set([vault.toLowerCase()]);
  for (const pool of await rd("pools")) {
    for (const id of await rd("liveSlots", [pool])) {
      const s = await rd("getSlot", [id]);
      for (const b of s.backers) want.add(b.toLowerCase());
    }
  }
  return want;
}

/** Bring rec.subscriptions in line with `want`. Records every tx in rec.txs; calls save(). */
export async function reconcile({ net, client, wallet, rec, save, log = console.log }) {
  const ex = new SomniaMarkets({ chain: net.chain, addresses: net.addresses, indexerUrl: net.indexerUrl });
  const reactivity = createReactivity(ex.client, { wallet });
  const want = await wantedAccounts(client, rec.vault);
  rec.subscriptions ??= [];
  const live = rec.subscriptions.filter((s) => s.status === "active");
  const have = new Set(live.map((s) => s.account));

  for (const s of live) {
    if (want.has(s.account)) continue;
    const hash = unwrap(await reactivity.unsubscribe(BigInt(s.subscriptionId)));
    const r = await client.waitForTransactionReceipt({ hash });
    s.status = r.status === "success" ? "removed" : s.status;
    s.removedTx = hash;
    rec.txs.push({ kind: "unsubscribe", account: s.account, tx: hash, block: Number(r.blockNumber), status: r.status });
    save();
    log("unsubscribe", s.account, r.status, hash);
  }

  for (const account of want) {
    if (have.has(account)) continue;
    const hash = unwrap(await reactivity.subscribe({
      handlerContractAddress: rec.vault,
      filter: { emitter: net.addresses.marginBank, eventTopics: [POSITION_UPDATED, pad(account, { size: 32 })] },
      options: DEFAULT_SUBSCRIPTION_OPTIONS,
    }));
    const r = await client.waitForTransactionReceipt({ hash });
    const created = r.logs.find((l) => l.address.toLowerCase() === "0x0000000000000000000000000000000000000100");
    const subscriptionId = created ? BigInt(created.topics[1]).toString() : null;
    rec.subscriptions.push({ account, subscriptionId, tx: hash, block: Number(r.blockNumber), status: r.status === "success" && subscriptionId ? "active" : "failed" });
    rec.txs.push({ kind: "subscribe", account, tx: hash, block: Number(r.blockNumber), status: r.status });
    save();
    log("subscribe", account, r.status, subscriptionId, hash);
  }
  return want;
}
