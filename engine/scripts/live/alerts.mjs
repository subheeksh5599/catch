// Live alerts to a Telegram channel: every liquidation the vault catches, every fill, and every
// stage-4 takeover the liquidation engine hands the vault. Reads the records the keeper writes
// (proven evidence only) and the engine's PositionTakenOver logs; posts each event once.
//   TELEGRAM_ENV=/etc/catch/telegram.env node scripts/live/alerts.mjs [network] [--dry-run] [--backfill N]
// telegram.env (0600) holds TELEGRAM_BOT_TOKEN=… and TELEGRAM_CHAT_ID=@channel or a numeric id.
// The token is read from that file only; it is never logged or written anywhere else.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { parseAbi, pad } from "viem";
import { NETWORKS, publicClient, systemAbi } from "../../src/chain.mjs";
import { loadDeployment } from "../../src/service.mjs";

const argv = process.argv.slice(2);
const netKey = argv[0] && !argv[0].startsWith("--") ? argv[0] : "hideki";
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const dry = argv.includes("--dry-run");
const net = NETWORKS[netKey];
const client = publicClient(net);
const log = (...a) => console.log(new Date().toISOString(), ...a);
const SITE = process.env.CATCH_SITE || "https://catch-backstop.vercel.app";

// credentials: from the env file, never from argv
const env = {};
if (process.env.TELEGRAM_ENV && existsSync(process.env.TELEGRAM_ENV)) {
  for (const line of readFileSync(process.env.TELEGRAM_ENV, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const TOKEN = env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const CHAT = env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
if (!dry && (!TOKEN || !CHAT)) throw new Error("set TELEGRAM_ENV to a file with TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID, or use --dry-run");

const statePath = process.env.ALERTS_STATE || new URL(`../../../deployments/.alerts-${netKey}.json`, import.meta.url).pathname;
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { posted: [], takeoverFrom: null };
const posted = new Set(state.posted);
const save = () => writeFileSync(statePath, JSON.stringify({ posted: [...posted].slice(-2000), takeoverFrom: state.takeoverFrom }, null, 2));

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const short = (h) => `${h.slice(0, 10)}…${h.slice(-4)}`;
const n = (x, d = 6) => Number(Number(x).toPrecision(d));

async function send(html) {
  if (dry) { console.log("---\n" + html.replace(/<[^>]+>/g, "")); return true; }
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT, text: html, parse_mode: "HTML", link_preview_options: { is_disabled: false } }),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) { log("telegram refused:", j.description || r.status); return false; } // never echo the URL: it holds the token
  return true;
}

const key = (e) => `${e.kind}:${e.txs?.[0]?.tx ?? e.title}`;

function message(e) {
  const tx = e.txs?.map((t) => `${esc(t.label)}: <code>${short(t.tx)}</code>`).join("\n") ?? "";
  const where = e.base ? `${e.base} ${e.side}` : "a market";
  const size = e.size != null ? ` · ${n(Math.abs(e.size))}` : "";
  const at = e.price != null ? ` at ${n(e.price)}` : "";
  if (e.kind === "catch") {
    return `<b>Liquidation caught</b>\n${esc(where)}${size}${at}\n\nA trader's position was force-closed into Catch's resting order on dreamDEX. Somnia Reactivity took the position and offered it back in the same block, block ${e.block}.\n\n${tx}\n\n${SITE}/api/share?kind=catch&id=${e.txs?.[0]?.tx ?? ""}`;
  }
  if (e.kind === "fill") {
    return `<b>Vault order filled</b>\n${esc(where)}${size}${at}\n\nA taker filled one of Catch's resting orders; the Reactivity callback recorded the position and offered it back at or past entry in block ${e.block}.\n\n${tx}`;
  }
  return null;
}

// stage-4: the engine handing a liquidated position to the vault as a registered bidder
const TAKEN_OVER = parseAbi(["event PositionTakenOver(address indexed account, address indexed bidder, address indexed perpPool, int128 size, uint256 takeoverPrice)"]);
let engine = null;
async function takeovers(vault) {
  engine ??= (await client.readContract({ address: net.addresses.marginBank, abi: systemAbi, functionName: "getSystemConfig" })).liquidationEngine;
  const head = await client.getBlockNumber();
  let from = BigInt(state.takeoverFrom ?? head - 500n);
  const out = [];
  for (let a = from; a <= head; a += 1000n) {
    const b = a + 999n > head ? head : a + 999n;
    const logs = await client.getContractEvents({ address: engine, abi: TAKEN_OVER, eventName: "PositionTakenOver", args: { bidder: vault }, fromBlock: a, toBlock: b });
    out.push(...logs);
  }
  state.takeoverFrom = Number(head) + 1;
  return out;
}

const first = !state.posted.length && state.takeoverFrom == null;
const backfill = Number(opt("backfill", 0));
log("alerts on", net.label, dry ? "(dry run)" : `to ${String(CHAT).startsWith("@") ? CHAT : "a chat"}`);
for (;;) {
  try {
    const dep = loadDeployment(netKey);
    const events = (dep?.evidence || []).filter((e) => e.status === "proven" && (e.kind === "catch" || e.kind === "fill"));
    events.sort((a, b) => (a.block ?? 0) - (b.block ?? 0));
    if (first && !state.seeded) {
      // start quiet: everything already on record counts as posted, except the last N if asked
      // the channel opens with every proven catch (they are rare), plus the last N fills if asked
      const keep = [...events.filter((e) => e.kind === "catch"), ...(backfill ? events.filter((e) => e.kind === "fill").slice(-backfill) : [])];
      for (const e of events) if (!keep.includes(e)) posted.add(key(e));
      state.seeded = true;
    }
    for (const e of events) {
      if (posted.has(key(e))) continue;
      const m = message(e);
      if (m && (await send(m))) { posted.add(key(e)); save(); log("posted", key(e)); }
    }
    for (const l of await takeovers(dep.vault)) {
      const k = `takeover:${l.transactionHash}:${l.logIndex}`;
      if (posted.has(k)) continue;
      const m = `<b>Stage-4 takeover won</b>\nThe liquidation engine handed Catch a position as a registered backstop bidder.\nSize ${l.args.size} at ${n(Number(l.args.takeoverPrice) / 1e18)}, account <code>${short(l.args.account)}</code>\n\n<code>${short(l.transactionHash)}</code>`;
      if (await send(m)) { posted.add(k); save(); log("posted", k); }
    }
    save();
  } catch (e) {
    log("poll failed", (e.shortMessage || e.message || String(e)).split("\n")[0]);
  }
  if (argv.includes("--once")) break;
  await new Promise((r) => setTimeout(r, Number(opt("every", 20)) * 1000));
}
