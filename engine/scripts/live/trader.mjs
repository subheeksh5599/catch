// A test trader for the live proofs: its own key (0600, outside the repo), funded by the
// operator, trading through the venue SDK. Its positions back the vault's orders.
//   node scripts/live/trader.mjs init
//   node scripts/live/trader.mjs fund <stt> <usdso>
//   node scripts/live/trader.mjs open <BASE> <buy|sell> <marginUsdso> <notionalUsdso>
//   node scripts/live/trader.mjs close <BASE>
//   node scripts/live/trader.mjs status
import { existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { parseEther, formatEther } from "viem";
import { SomniaMarkets } from "@somnia-chain/markets-sdk";
import { NETWORKS, publicClient, erc20Abi, bankAbi } from "../../src/chain.mjs";
import { loadAccount, walletFor } from "../../src/signer.mjs";

const net = NETWORKS.hideki;
const file = process.env.TRADER_KEY_FILE || join(homedir(), ".catch", "trader.key");
const USDSO = "0xed7993A74dAe1e6656B704A424DcD8711aAf4F72";
const client = publicClient(net);
const [cmd, ...args] = process.argv.slice(2);

function traderKey() {
  if (!existsSync(file)) {
    writeFileSync(file, generatePrivateKey(), { mode: 0o600 });
  }
  if (statSync(file).mode & 0o077) throw new Error(`${file} is readable by others`);
  return readFileSync(file, "utf8").trim();
}
const trader = privateKeyToAccount(traderKey());
const ex = () => new SomniaMarkets({ chain: net.chain, addresses: net.addresses, indexerUrl: net.indexerUrl, privateKey: traderKey() });
const sym = (base) => `${base}/USDso:USDso`;

async function status() {
  const stt = formatEther(await client.getBalance({ address: trader.address }));
  const usd = formatEther(await client.readContract({ address: USDSO, abi: erc20Abi, functionName: "balanceOf", args: [trader.address] }));
  const st = await client.readContract({ address: net.addresses.marginBank, abi: bankAbi, functionName: "getAccountState", args: [trader.address] });
  console.log("trader", trader.address, "STT", stt, "USDso", usd, "bank free", Number(st.unlockedCollateralBalance) / 1e18, "locked", Number(st.lockedCollateral) / 1e18);
  const e = ex();
  await e.loadMarkets();
  for (const p of await e.fetchPositions()) {
    if (!p.contracts) continue;
    console.log(" ", p.symbol, p.side, p.contracts, "entry", p.entryPrice, "mark", p.markPrice, "liq", p.liquidationPrice, "notional", p.notional, "lev", p.leverage);
  }
}

if (cmd === "init") {
  console.log("trader", trader.address);
} else if (cmd === "fund") {
  const [stt = "1", usd = "20"] = args;
  const op = loadAccount();
  const w = walletFor(net, op);
  let h1 = null;
  if (Number(stt) > 0) {
    h1 = await w.sendTransaction({ to: trader.address, value: parseEther(stt) });
    await client.waitForTransactionReceipt({ hash: h1 });
  }
  const g = await client.estimateContractGas({ account: op, address: USDSO, abi: erc20Abi, functionName: "transfer", args: [trader.address, parseEther(usd)] });
  const h2 = await w.writeContract({ address: USDSO, abi: erc20Abi, functionName: "transfer", args: [trader.address, parseEther(usd)], gas: (g * 15n) / 10n });
  const r = await client.waitForTransactionReceipt({ hash: h2 });
  console.log("sent STT", h1, "sent USDso", r.status, h2);
  await status();
} else if (cmd === "open") {
  const [base, side, margin, notional] = args;
  const e = ex();
  await e.loadMarkets();
  const m = e.markets[sym(base)];
  if (Number(margin) > 0) {
    const dep = await e.depositMargin(sym(base), Number(margin));
    console.log("depositMargin", dep.hash ?? dep.txHash ?? JSON.stringify(dep, (k, v) => (typeof v === "bigint" ? v.toString() : v)).slice(0, 160));
  }
  const mark = Number(m.info.markPrice) / 1e18;
  const lot = Number(m.info.lotSize) / 10 ** (m.info.baseDecimals ?? 18);
  const amount = Math.floor(Number(notional) / mark / lot) * lot;
  const o = await e.createOrder(sym(base), "market", side, Number(amount.toPrecision(12)));
  console.log("order", side, amount, base, o.status, o.info?.txHash ?? o.id);
  await status();
} else if (cmd === "close") {
  const [base] = args;
  const e = ex();
  await e.loadMarkets();
  const p = (await e.fetchPositions([sym(base)])).find((x) => x.contracts);
  if (!p) { console.log("flat"); process.exit(0); }
  const o = await e.createOrder(sym(base), "market", p.side === "long" ? "sell" : "buy", p.contracts);
  console.log("close", p.side, p.contracts, o.status, o.info?.txHash ?? o.id);
  await status();
} else {
  await status();
}
process.exit(0);
