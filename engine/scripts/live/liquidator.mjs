// Liquidation watcher. The venue's liquidation engine is permissionless: anyone may call
// liquidate(account) once the account is under maintenance margin (it reverts NotLiquidatable()
// otherwise). This polls the accounts backing the vault's orders and triggers the liquidation
// itself the moment it is allowed, so the forced close reaches the book while the vault's
// order rests at the edge of that account's catch window.
//   node scripts/live/liquidator.mjs [network] [--every 2] [--accounts 0xa,0xb]
import { readFileSync } from "node:fs";
import { parseAbi } from "viem";
import { NETWORKS, publicClient, systemAbi } from "../../src/chain.mjs";
import { loadAccount, walletFor } from "../../src/signer.mjs";
import { wantedAccounts } from "../../src/subscriptions.mjs";

const argv = process.argv.slice(2);
const netKey = argv[0] && !argv[0].startsWith("--") ? argv[0] : "hideki";
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const net = NETWORKS[netKey];
const client = publicClient(net);
const account = loadAccount();
const wallet = walletFor(net, account);
const rec = () => JSON.parse(readFileSync(new URL(`../../../deployments/${netKey}.json`, import.meta.url), "utf8"));
const engineAbi = parseAbi(["function isLiquidatable(address) view returns (bool)", "function liquidate(address)"]);
const log = (...a) => console.log(new Date().toISOString(), ...a);

const cfg = await client.readContract({ address: net.addresses.marginBank, abi: systemAbi, functionName: "getSystemConfig" });
const engine = cfg.liquidationEngine;
log("liquidator on", net.chain.name, "engine", engine);

let watch = [];
let lastRefresh = 0;
let tick = 0;
for (;;) {
  try {
    if (Date.now() - lastRefresh > 60_000) {
      const fixed = (opt("accounts") || "").split(",").filter(Boolean).map((a) => a.toLowerCase());
      const vault = rec().vault.toLowerCase();
      watch = [...new Set([...fixed, ...(await wantedAccounts(client, vault))])].filter((a) => a !== vault);
      lastRefresh = Date.now();
    }
    // named accounts every tick; the rest of the backers every `others-every` ticks (each check
    // is a full account-health read on the venue, so poll gently)
    const fixed = (opt("accounts") || "").split(",").filter(Boolean).map((a) => a.toLowerCase());
    const now = tick++ % Number(opt("others-every", 15)) === 0 ? watch : watch.filter((a) => fixed.includes(a));
    const flags = await Promise.all(now.map((a) => client.readContract({ address: engine, abi: engineAbi, functionName: "isLiquidatable", args: [a] }).catch(() => false)));
    for (const [i, a] of now.entries()) {
      if (!flags[i]) continue;
      try {
        const gas = await client.estimateContractGas({ account, address: engine, abi: engineAbi, functionName: "liquidate", args: [a] });
        const hash = await wallet.writeContract({ address: engine, abi: engineAbi, functionName: "liquidate", args: [a], gas: (gas * 15n) / 10n });
        const r = await client.waitForTransactionReceipt({ hash });
        log("liquidate", a, r.status, hash, "block", r.blockNumber);
      } catch (e) {
        log("liquidate skipped", a, e.shortMessage || e.message); // someone else got there first
      }
    }
  } catch (e) {
    log("poll failed", e.shortMessage || e.message);
  }
  await new Promise((r) => setTimeout(r, Number(opt("every", 2)) * 1000));
}
