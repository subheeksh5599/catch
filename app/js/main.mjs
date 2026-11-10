// Catch dashboard: hash-routed views over the engine API. Every number on screen comes from
// /api/*, which reads the chain and the venue's indexer. A value that has not been read yet is
// shown as what is being read, never as zero.
// Markup is built from formatted numbers, fixed labels and esc()-escaped strings only.
import { esc, usd, price, qty, pct, int, short, ago, baseOf } from "./fmt.mjs";
import { liquidationMap, priceLine, spark } from "./chart.mjs";
import { Wallet, calldata, toUnits, fromUnits } from "./wallet.mjs";

const API = window.CATCH_API || "";
const $ = (sel, root = document) => root.querySelector(sel);
const view = $("#view");
const tip = $("#tip");

const state = { status: null, markets: null, liq: null, vault: null, maps: new Map(), pool: null, route: "overview", wallet: null };

async function get(path) {
  const r = await fetch(API + path, { cache: "no-store" });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

// ------------------------------------------------------------------ data

let marketsInFlight = null;
async function loadCore() {
  // markets is the slow read (every position on every market); never block the shell on it
  if (!marketsInFlight) {
    marketsInFlight = get("/api/markets").then((markets) => {
      const first = !state.markets?.length;
      state.markets = markets;
      if (!state.pool && markets.length) state.pool = markets[0].pool;
      if (first) render();
      return markets;
    }).catch(() => null).finally(() => { marketsInFlight = null; });
  }
  const [status, liq, vault] = await Promise.all([get("/api/status"), get("/api/liquidations"), get("/api/vault")]);
  Object.assign(state, { status, liq, vault });
  if (!state.pool) state.pool = new URLSearchParams(location.hash.split("?")[1]).get("m");
  if (!state.wallet && status?.network) {
    state.wallet = new Wallet({ id: status.network.chainId, name: status.network.label, rpc: status.network.rpc });
    state.wallet.on(() => { renderConnect(); if (state.route === "vault") render(); });
  }
  renderChrome();
}

async function loadMap(pool) {
  const m = await get(`/api/map/${pool}`);
  state.maps.set(pool.toLowerCase(), m);
  return m;
}

const market = (pool) => state.markets?.find((m) => m.pool.toLowerCase() === String(pool).toLowerCase());
const explorer = () => state.status?.network?.explorer;
const txLink = (hash) => explorer()
  ? `<a class="addr mono" href="${explorer()}/tx/${esc(hash)}" target="_blank" rel="noopener">${short(hash)}</a>`
  : `<span class="mono t2" title="${esc(hash)}">${short(hash)}</span>`;
const addrLink = (a) => explorer()
  ? `<a class="addr mono" href="${explorer()}/address/${esc(a)}" target="_blank" rel="noopener">${short(a)}</a>`
  : `<span class="mono t2" title="${esc(a)}">${short(a)}</span>`;
const sym = (symbol) => `<div class="sym"><b>${esc(baseOf(symbol))}</b><span>PERP</span></div>`;
const wait = (what) => `<div class="figure wait">${esc(what)}</div>`;

// ------------------------------------------------------------------ chrome

function renderChrome() {
  const s = state.status;
  if (!s) return;
  $("#netName").textContent = s.network.label;
  if (s.head !== renderChrome.head) { renderChrome.head = s.head; renderChrome.at = Date.now(); }
  const stale = !s.head || Date.now() - renderChrome.at > 90_000;
  $("#liveDot").className = "dot " + (stale ? "stale" : "live");
  $("#headBlock").textContent = s.head ? `block ${int(s.head)}${stale ? " · not moving" : ""}` : "reading chain";
}

function renderConnect() {
  const b = $("#connect");
  const w = state.wallet;
  b.textContent = w?.account ? short(w.account) : "Connect wallet";
}

$("#connect").addEventListener("click", async () => {
  try { await state.wallet?.connect(); } catch (e) { toast(e.message); }
});

function toast(msg) {
  tip.hidden = false;
  tip.textContent = msg;
  tip.style.left = "auto"; tip.style.right = "24px"; tip.style.top = "76px";
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { tip.hidden = true; tip.style.right = ""; }, 5000);
}

function setHead(title, sub = "") {
  $("#title").textContent = title;
  $("#subtitle").textContent = sub;
  document.title = title === "Overview" ? "Catch" : `${title} · Catch`;
}

function marketPicker(show) {
  const el = $("#marketPick");
  if (!show || !state.markets) { el.replaceChildren(); return; }
  el.innerHTML = `<select id="mp" aria-label="Market">${state.markets.map((m) => `<option value="${esc(m.pool)}" ${m.pool === state.pool ? "selected" : ""}>${esc(baseOf(m.symbol))}-PERP</option>`).join("")}</select>`;
  $("#mp").addEventListener("change", (e) => { state.pool = e.target.value; location.hash = `#/map?m=${e.target.value}`; });
}

function stat(label, figure, foot = "") {
  return `<div class="card stat enter"><div class="label">${label}</div>${figure.startsWith("<") ? figure : `<div class="figure">${figure}</div>`}<div class="foot">${foot}</div></div>`;
}

// ------------------------------------------------------------------ shared pieces

/** The newest proven catch in the deployment record (carried across vault versions). */
function lastCatch() {
  const ev = state.vault?.deployment?.evidence || [];
  return ev.filter((e) => e.kind === "catch" && e.status === "proven").sort((a, b) => (b.block ?? 0) - (a.block ?? 0))[0] ?? null;
}

function receipt() {
  const c = lastCatch();
  if (!c) {
    const armed = (state.vault?.deployment?.evidence || []).find((e) => e.kind === "catch");
    return `<div class="card receipt enter"><div class="head"><h2>Last catch</h2><span class="badge wait">Waiting</span></div>
      <p class="t2">No liquidation has filled a vault order on this deployment yet.${armed ? ` ${esc(armed.detail)}` : ""}</p></div>`;
  }
  const liq = c.txs?.find((t) => /liquidation/i.test(t.label));
  const cb = c.txs?.find((t) => /callback/i.test(t.label));
  return `<div class="card receipt enter">
    <div class="head"><h2>Last catch</h2><span class="badge ok">On chain</span></div>
    <div class="ticket">
      <div class="big">${c.size != null ? `${qty(Math.abs(c.size))} ${esc(c.base ?? "")}` : "Caught"}</div>
      <div class="t2">${c.side === "short" ? "short" : c.side === "long" ? "long" : "position"} closed by the engine into the vault's ${c.side === "short" ? "ask" : "bid"}</div>
      <span class="bracket">${c.price != null ? price(c.price) : ""}</span>
    </div>
    <div class="timeline">
      ${liq ? `<div class="row"><span class="mono idx">${liq.index != null ? `#${liq.index} in block` : "in block"}</span><span>Liquidation engine force-closes the position into the book</span>${txLink(liq.tx)}</div>` : ""}
      ${cb ? `<div class="row"><span class="mono idx">${cb.index != null ? `#${cb.index} in block` : "in block"}</span><span>Reactivity callback records it and rests the unwind</span>${txLink(cb.tx)}</div>` : ""}
    </div>
    <p class="t3" style="font-size:12px">Both in block ${int(c.block)}${c.vaultTag ? ` · vault ${esc(c.vaultTag)}` : ""}. Nobody on the Catch side sent the liquidation.</p>
  </div>`;
}

const STAGES = [
  ["OrderCancellation", "Order cancellation", "#5b5b60"],
  ["CLOBPartial", "Closed into the book", "#a1a1a6"],
  ["BidderTakeover", "Bidder takeover", "#77777d"],
  ["InsuranceFund", "Insurance fund", "#8f8f95"],
  ["ADL", "Auto-deleverage", "#e5484d"],
];
const STAGE_LABEL = Object.fromEntries(STAGES.map(([k, l]) => [k, l]));

function stageBlock(st) {
  if (!st) return `<div class="loading" style="min-height:200px"><b>Reading the venue's liquidation history</b></div>`;
  const total = st.accounts || 1;
  const bar = STAGES.map(([k, , c]) => `<i style="width:${((st.byStage[k] || 0) / total) * 100}%;background:${c}"></i>`).join("");
  const rows = STAGES.map(([k, label, c]) => `<tr><td><span class="legend"><span><i style="background:${c}"></i>${label}</span></span></td><td class="r">${int(st.byStage[k] || 0)}</td><td class="r t3">${pct((st.byStage[k] || 0) / total)}</td></tr>`).join("");
  return `<div class="stack" style="margin:0 20px 8px">${bar}</div>
    <table class="table"><tbody>${rows}
    <tr><td><b style="font-weight:500">Book was empty</b><div class="t3" style="font-size:12px;line-height:16px">Sent to the book, nothing filled</div></td><td class="r"><b style="font-weight:500">${int(st.emptyBook)}</b></td><td class="r amber">${pct(st.emptyBookShare)}</td></tr></tbody></table>
    <p class="t3" style="font-size:12px;padding:12px 20px 16px">${st.from ? `${new Date(st.from).toLocaleDateString()} to ${new Date(st.to).toLocaleDateString()}, ` : ""}from the venue's LiquidationEngine events.</p>`;
}

function liqTable(limit = 100) {
  const rows = (state.liq?.rows || []).filter((r) => r.kind === "PositionLiquidated" || r.kind === "AutoDeleveraged").slice(0, limit);
  if (!state.liq) return `<div class="loading" style="min-height:160px"><b>Reading recent liquidations</b></div>`;
  if (!rows.length) return `<div class="empty">No liquidations indexed in this window.</div>`;
  return `<div class="scroll"><table class="table"><thead><tr><th>Market</th><th>Kind</th><th class="r">Size</th><th class="r">Price</th><th>Account</th><th class="r">When</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td>${sym(r.symbol || "?")}</td>
      <td><span class="badge ${r.kind === "AutoDeleveraged" ? "" : r.size > 0 ? "long" : "short"}">${r.kind === "AutoDeleveraged" ? "ADL" : r.size > 0 ? "Long" : "Short"}</span></td>
      <td class="r">${qty(Math.abs(r.size))}</td><td class="r">${price(r.price)}</td><td>${addrLink(r.account)}</td><td class="r t3">${ago(r.at)}</td></tr>`).join("")}
  </tbody></table></div>`;
}

function mapLoading(m) {
  return `<div class="loading" style="min-height:300px"><b>Reading every open ${esc(m ? baseOf(m.symbol) : "")} position</b>
    <span>Liquidation prices come from each account's health, read in one block. The first read of a market walks every account and can take a few minutes on testnet.</span></div>`;
}

// ------------------------------------------------------------------ overview

async function overview() {
  setHead("Overview", state.status ? `dreamDEX perps on ${state.status.network.label}` : "");
  marketPicker(false);
  const st = state.liq?.stats;
  const v = state.vault?.state;
  const top = state.markets?.[0];
  const orders = v ? v.markets.reduce((n, m) => n + m.slots.filter((s) => !s.unwind).length, 0) : null;
  const quoted = v ? v.markets.filter((m) => m.slots.length).length : null;
  const hist = navPoints(v);
  const change = hist.length > 1 ? hist.at(-1).v / hist[0].v - 1 : null;
  view.innerHTML = `
    <section class="grid lead overview-lead">
      <div class="card intro enter">
        <div style="display:grid;gap:12px">
          <h2>When a dreamDEX position is liquidated, Catch is already in the book to buy it</h2>
          <p>The engine closes a liquidated position into the public order book first, and often the book is empty there. Catch is a vault that rests orders at those prices and drops each one in the same block the positions behind it change.</p>
        </div>
        <ol class="steps">
          <li><b>Map</b>Every open position and its liquidation price, read in one block</li>
          <li><b>Rest</b>A post-only order inside the engine's close window, checked by the contract</li>
          <li><b>Catch</b>The forced close fills it; the vault offers it back at or past entry</li>
        </ol>
        <div class="actions"><a class="btn lg" href="#/vault">Deposit USDso</a><a class="btn quiet lg" href="#/map">Open the map</a></div>
      </div>
      ${receipt()}
    </section>
    <section class="grid stats">
      ${stat("Vault assets", v ? usd(v.totalAssets, { compact: false, digits: 2 }) : wait("Reading the vault"), v ? "USDso, marked to market" : "")}
      ${stat("Share price", v ? v.sharePrice.toFixed(4) : wait("Reading the vault"), change != null ? `${change >= 0 ? "+" : ""}${(change * 100).toFixed(2)}% since the first recorded read` : "USDso per 1,000 shares")}
      ${stat("Orders resting", v ? int(orders) : wait("Reading the vault"), v ? (orders ? `${quoted} market${quoted === 1 ? "" : "s"}, all post-only` : "None right now; placed when a cluster is in reach") : "")}
      ${stat("Liquidations into an empty book", st ? pct(st.emptyBookShare) : wait("Reading venue history"), st ? `${int(st.emptyBook)} of the last ${int(st.accounts)} on the venue` : "")}
    </section>
    <section class="grid main-side">
      <div class="card enter">
        <div class="card-h"><h2>${top ? `${esc(baseOf(top.symbol))}-PERP liquidations by price` : "Liquidations by price"}</h2>${top ? `<a class="link" href="#/map?m=${esc(top.pool)}">Full map</a>` : ""}</div>
        <div class="card-b"><div class="chart" id="ovChart">${mapLoading(top)}</div>
          <div class="legend" style="margin-top:12px"><span><i style="background:#e5484d"></i>Longs liquidated</span><span><i style="background:#4cc38a"></i>Shorts liquidated</span><span><i style="background:#85858b"></i>Book resting</span><span><i style="background:#e2a336"></i>Catch window</span></div></div>
      </div>
      <div class="card enter"><div class="card-h" style="padding-bottom:16px"><h2>How liquidations ended</h2><span class="hint">${st ? `last ${int(st.accounts)}` : ""}</span></div>${stageBlock(st)}</div>
    </section>
    <section class="card enter"><div class="card-h" style="padding-bottom:8px"><h2>Latest liquidations</h2><a class="link" href="#/liquidations">All</a></div>${liqTable(8)}</section>`;
  if (top) {
    const m = state.maps.get(top.pool.toLowerCase()) || (await loadMap(top.pool));
    if (state.route === "overview" && $("#ovChart")) liquidationMap($("#ovChart"), m, { height: 300, compact: true, tip });
  }
}

// ------------------------------------------------------------------ map

async function mapView() {
  if (!state.markets) { setHead("Liquidation map", "Reading every open position"); view.innerHTML = `<section class="card">${mapLoading()}</section>`; return; }
  const m0 = market(state.pool) || state.markets[0];
  if (!m0) { view.innerHTML = `<div class="empty">No markets.</div>`; return; }
  state.pool = m0.pool;
  setHead(`${baseOf(m0.symbol)}-PERP`, "Liquidation map");
  marketPicker(true);
  if (!state.maps.get(m0.pool.toLowerCase())) view.innerHTML = `<section class="card">${mapLoading(m0)}</section>`;
  const m = state.maps.get(m0.pool.toLowerCase()) || (await loadMap(m0.pool));
  if (state.route !== "map" || state.pool !== m0.pool) return;
  const r = m.risk;
  view.innerHTML = `
    <section class="grid stats">
      ${stat("Mark", price(m.markPrice), `Maintenance margin ${(m.maintenanceMarginBps / 100).toFixed(2)}%`)}
      ${stat("Open positions", int(m.positions), `${int(m.holders.long)} long, ${int(m.holders.short)} short${m.pricedShare != null && m.pricedShare < 1 ? `, prices read for ${pct(m.pricedShare)} of size` : ""}`)}
      ${stat("Liquidated by a 1% move", usd(r["1%"].long + r["1%"].short), `${int(r["1%"].accounts)} accounts`)}
      ${stat("Liquidated by a 5% move", usd(r["5%"].long + r["5%"].short), `${usd(r["5%"].long)} long, ${usd(r["5%"].short)} short`)}
    </section>
    <section class="grid main-side">
      <div class="card enter">
        <div class="card-h"><h2>Liquidation notional by trigger price</h2><span class="hint">block ${int(m.block)} · ${ago(m.at)}</span></div>
        <div class="card-b"><div class="chart" id="bigChart"></div>
          <div class="legend" style="margin-top:12px"><span><i style="background:#e5484d"></i>Longs liquidated</span><span><i style="background:#4cc38a"></i>Shorts liquidated</span><span><i style="background:#85858b"></i>Book resting</span><span><i style="background:#e2a336"></i>Catch window and order</span><span>Thin lines: cumulative from the mark</span></div>
          ${m.outsideRange ? `<p class="t3" style="font-size:12px;margin-top:8px">${int(m.outsideRange)} positions trigger more than 15% from the mark and are off the chart.</p>` : ""}
        </div>
      </div>
      <div class="grid" style="align-content:start">${(m.clusters || []).filter(Boolean).map((c) => clusterCard(c, m)).join("") || `<div class="card empty">No cluster within reach of the mark on either side.</div>`}</div>
    </section>
    <section class="card enter"><div class="card-h" style="padding-bottom:8px"><h2>If the mark moves</h2><span class="hint">liquidation notional crossed, and the book on that side</span></div>
      <div class="scroll"><table class="table"><thead><tr><th>Move</th><th class="r">Price</th><th>Forced</th><th class="r">Notional crossed</th><th class="r">Book resting</th></tr></thead><tbody>
      ${["10%", "5%", "3%", "1%"].map((k) => ({ d: -parseFloat(k) / 100, v: r[k].long, side: "Longs sold" }))
        .concat(["1%", "3%", "5%", "10%"].map((k) => ({ d: parseFloat(k) / 100, v: r[k].short, side: "Shorts bought back" })))
        .map(({ d, v, side }) => {
          const p = m.markPrice * (1 + d);
          const book = m.bins.reduce((t, b) => t + (d < 0 ? (b.price >= p && b.price < m.markPrice ? b.bidDepth : 0) : (b.price <= p && b.price > m.markPrice ? b.askDepth : 0)), 0);
          return `<tr><td class="${d < 0 ? "down" : "up"}">${d > 0 ? "+" : ""}${(d * 100).toFixed(0)}%</td><td class="r">${price(p, m.markPrice)}</td><td class="t2">${side}</td><td class="r">${usd(v)}</td><td class="r ${v > 0 && book < v * 0.25 ? "down" : ""}">${usd(book)}</td></tr>`;
        }).join("")}
      </tbody></table></div></section>
    <section class="card enter"><div class="card-h" style="padding-bottom:8px"><h2>Closest to liquidation</h2><span class="hint">single-market solve, as the venue's SDK publishes it</span></div>
      <div class="scroll"><table class="table"><thead><tr><th>Account</th><th>Side</th><th class="r">Size</th><th class="r">Entry</th><th class="r">Liquidation</th><th class="r">From mark</th><th class="r">Notional</th></tr></thead><tbody>
      ${m.near.map((p) => `<tr><td>${addrLink(p.account)}</td><td><span class="badge ${p.side}">${p.side === "long" ? "Long" : "Short"}</span></td><td class="r">${qty(p.size)} ${esc(m.base)}</td><td class="r">${price(p.entry, m.markPrice)}</td><td class="r">${price(p.liq, m.markPrice)}</td><td class="r ${p.distance < 0.02 ? "down" : "t3"}">${pct(p.distance, 2)}</td><td class="r">${usd(p.notional)}</td></tr>`).join("")}
      </tbody></table></div></section>`;
  liquidationMap($("#bigChart"), m, { height: 400, tip });
}

function clusterCard(c, m) {
  const long = c.side === "bid";
  return `<div class="card pad enter" style="display:grid;gap:12px">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><span class="badge ${long ? "long" : "short"}">${long ? "Bid under longs" : "Ask over shorts"}</span><span class="t3" style="font-size:12px">${int(c.accountsInWindow)} accounts in window</span></div>
    <div style="display:flex;align-items:baseline;gap:8px"><span class="figure" style="font-size:24px;font-weight:500">${price(c.price, m.markPrice)}</span><span class="t3">${pct((c.price - m.markPrice) / m.markPrice, 2)} from mark</span></div>
    <span class="bracket">${price(c.window.lo, m.markPrice)} to ${price(c.window.hi, m.markPrice)}</span>
    <dl class="kv">
      <dt>Forced size</dt><dd>${qty(c.size)} ${esc(m.base)}</dd>
      <dt>Notional</dt><dd>${usd(c.notional)}</dd>
      <dt>Book inside the window</dt><dd class="${c.coverage < 0.25 ? "down" : ""}">${usd(c.restingInWindow)}</dd>
      <dt>Vault order</dt><dd>${c.vaultOrderQty == null ? '<span class="t3">No vault on this network</span>' : c.vaultOrderQty > 0 ? `${qty(c.vaultOrderQty)} ${esc(m.base)}` : '<span class="t3">Under the venue minimum</span>'}</dd>
    </dl>
  </div>`;
}

// ------------------------------------------------------------------ markets

function marketsView() {
  setHead("Markets", state.markets ? `${state.markets.length} perps, busiest first` : "Reading markets");
  marketPicker(false);
  if (!state.markets) { view.innerHTML = `<section class="card">${mapLoading()}</section>`; return; }
  const v = state.vault?.state;
  view.innerHTML = `<section class="card enter"><div class="scroll" style="max-height:none"><table class="table"><thead><tr>
    <th>Market</th><th class="r">Mark</th><th class="r">Open interest</th><th class="r">Funding</th><th class="r">Positions</th><th class="r">1% move</th><th class="r">5% move</th><th>Shape</th><th class="r">Book in window</th><th class="r">Vault</th></tr></thead><tbody>
    ${state.markets.map((m) => {
      const bin = state.maps.get(m.pool.toLowerCase());
      const cov = m.clusters?.filter(Boolean) ?? [];
      const n = cov.reduce((a, c) => a + c.notional, 0), rest = cov.reduce((a, c) => a + c.restingInWindow, 0);
      const vm = v?.markets.find((x) => x.pool.toLowerCase() === m.pool.toLowerCase());
      return `<tr class="click" data-pool="${esc(m.pool)}"><td>${sym(m.symbol)}</td>
      <td class="r">${price(m.markPrice)}</td><td class="r">${usd(m.openInterest * m.markPrice)}</td>
      <td class="r ${m.fundingRate >= 0 ? "up" : "down"}">${m.fundingRate == null ? "—" : (m.fundingRate * 100).toFixed(4) + "%"}</td>
      <td class="r">${m.positions == null ? '<span class="t3">queued</span>' : int(m.positions)}</td>
      <td class="r">${m.risk ? usd(m.risk["1%"].long + m.risk["1%"].short) : "—"}</td>
      <td class="r">${m.risk ? usd(m.risk["5%"].long + m.risk["5%"].short) : "—"}</td>
      <td>${bin ? spark(bin.bins, bin.markPrice) : '<span class="t3">—</span>'}</td>
      <td class="r ${n && rest / n < 0.25 ? "down" : ""}">${n ? pct(rest / n, 0) : "—"}</td>
      <td class="r">${vm?.slots.length ? `<span class="amber">${vm.slots.length} order${vm.slots.length > 1 ? "s" : ""}</span>` : '<span class="t3">—</span>'}</td></tr>`;
    }).join("")}
  </tbody></table></div></section>`;
  for (const m of state.markets) if (m.mapped && !state.maps.get(m.pool.toLowerCase())) loadMap(m.pool).then(() => state.route === "markets" && marketsView()).catch(() => {});
}

// ------------------------------------------------------------------ vault

function navPoints(v) {
  if (!v) return [];
  return (v.history || []).map((h) => ({ t: Date.parse(h.at), v: Number(h.totalSupply) > 0 ? (Number(h.totalAssets) * 1000) / Number(h.totalSupply) : null })).filter((p) => p.v != null);
}

const fmtDelay = (s) => (s == null ? "—" : s % 3600 === 0 ? `${s / 3600} hour${s === 3600 ? "" : "s"}` : `${Math.round(s / 60)} minutes`);

async function vaultView() {
  const v = state.vault?.state;
  const d = state.vault?.deployment;
  marketPicker(false);
  if (!v) {
    setHead("Vault", "");
    view.innerHTML = state.vault ? `<div class="notice"><span class="dot stale"></span><div><b>No vault on this network.</b> Deploy one with <span class="mono">npm run deploy</span> in <span class="mono">engine/</span>.</div></div>` : `<section class="card"><div class="loading"><b>Reading the vault</b></div></section>`;
    return;
  }
  setHead("Vault", short(v.address));
  const w = state.wallet;
  let mine = null;
  if (w?.account) {
    try {
      const [sh, bal, un] = await Promise.all([w.call(v.address, calldata.balanceOf(w.account)), w.call(v.asset, calldata.balanceOf(w.account)), w.call(v.address, calldata.unlockAt(w.account)).catch(() => "0x0")]);
      const shares = BigInt(sh);
      const assets = shares ? BigInt(await w.call(v.address, calldata.convertToAssets(shares))) : 0n;
      mine = { shares, assets, wallet: BigInt(bal), unlockAt: Number(BigInt(un)) * 1000 };
    } catch (e) { mine = { error: e.message }; }
  }
  const orders = v.markets.flatMap((m) => m.slots.map((s) => ({ ...s, m })));
  const capOf = (m) => Math.min((v.totalAssets * v.marketCapBps) / 10000, m.oiCap ?? Infinity);
  const locked = mine?.unlockAt && mine.unlockAt > Date.now();
  view.innerHTML = `
    <section class="grid stats">
      ${stat("Vault assets", usd(v.totalAssets, { compact: false, digits: 2 }), "Idle, bank equity and locked margin")}
      ${stat("Share price", v.sharePrice.toFixed(4), `USDso per 1,000 shares · ${qty(v.totalSupply)} shares`)}
      ${stat("Free to withdraw", usd(v.free, { compact: false, digits: 2 }), `${usd(v.locked, { compact: false, digits: 2 })} locked behind ${orders.length} orders`)}
      ${stat("Your position", mine?.shares != null ? usd(fromUnits(mine.assets), { compact: false, digits: 2 }) : `<div class="figure wait">Connect a wallet</div>`, mine?.shares != null ? `${qty(fromUnits(mine.shares))} shares${locked ? ` · unlocks ${new Date(mine.unlockAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}` : "To see your shares")}
    </section>
    <section class="grid lead">
      <div class="card pad enter form">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><h2 style="font-size:14px;font-weight:500">Deposit or redeem</h2><div class="seg" id="dwSeg"><button class="on" data-k="deposit">Deposit</button><button data-k="redeem">Redeem</button></div></div>
        <input class="amount" id="amt" placeholder="0.00" inputmode="decimal" autocomplete="off" aria-label="Amount" />
        <div class="t3" id="preview" style="font-size:13px">USDso in, shares out at ${v.sharePrice.toFixed(4)} per 1,000</div>
        <dl class="kv"><dt>In your wallet</dt><dd>${mine?.wallet != null ? `${usd(fromUnits(mine.wallet), { compact: false, digits: 2 })} USDso` : "—"}</dd><dt>Your shares</dt><dd>${mine?.shares != null ? qty(fromUnits(mine.shares)) : "—"}</dd></dl>
        <div class="lock" id="lockNote">${locked ? `Your shares unlock at ${new Date(mine.unlockAt).toLocaleString([], { hour: "numeric", minute: "2-digit", month: "short", day: "numeric" })}. The contract refuses a redemption or transfer before then.` : `A deposit locks your shares for ${fmtDelay(v.redeemDelaySeconds)}, so nobody can buy in just before a catch and leave just after it.`}</div>
        <button class="btn wide" id="dwGo">${w?.account ? "Deposit USDso" : "Connect wallet"}</button>
        <p class="note">Deposits go straight into the vault's own dreamDEX margin account. A redemption cancels resting orders if it needs their margin. There is no admin key.</p>
      </div>
      <div class="card enter">
        <div class="card-h"><h2>Share price</h2><span class="hint">read by the keeper at head, per 1,000 shares</span></div>
        <div class="card-b"><div class="chart" id="navChart"></div></div>
        ${trackRecord(v)}
      </div>
    </section>
    <section class="grid main-side">
      <div class="grid" style="align-content:start">
      <div class="card enter"><div class="card-h" style="padding-bottom:8px"><h2>Exposure by market</h2><span class="hint">limit is the lower of ${v.marketCapBps / 100}% of assets and ${v.oiCapBps != null ? `${v.oiCapBps / 100}% of open interest` : "the market cap"}</span></div>
        <div class="list">${v.markets.length ? v.markets.slice().sort((a, b) => b.exposure - a.exposure).map((m) => {
          const cap = capOf(m);
          const ps = m.price?.status;
          return `<div class="row" style="grid-template-columns:120px 1fr 140px 120px">${sym(m.symbol)}<div class="meter"><i class="${m.exposure ? "amber" : ""}" style="width:${Math.min(100, (m.exposure / (cap || 1)) * 100)}%"></i></div><span class="r num" style="text-align:right">${usd(m.exposure, { compact: false, digits: 2 })} <span class="t3">of ${usd(cap, { compact: false, digits: 0 })}</span></span><span style="text-align:right;font-size:12px" class="${ps === 0 ? "t3" : "amber"}">${ps == null ? "" : ps === 0 ? "price checks out" : ps === 1 ? "index stale, paused" : "mark off index, paused"}</span></div>`;
        }).join("") : '<div class="empty">No market quoted yet.</div>'}</div></div>
      <div class="card enter"><div class="card-h" style="padding-bottom:8px"><h2>Resting orders</h2><span class="hint">on the venue's book now</span></div>
        ${orders.length ? `<div class="scroll"><table class="table"><thead><tr><th>Market</th><th>Kind</th><th class="r">Price</th><th class="r">Notional</th><th class="r">Accounts cited</th><th class="r">Slot</th></tr></thead><tbody>${orders.map((o) => `<tr><td>${sym(o.m.symbol)}</td><td><span class="badge ${o.unwind ? "wait" : o.side === "bid" ? "long" : "short"}">${o.unwind ? "Unwind" : o.side === "bid" ? "Bid under longs" : "Ask over shorts"}</span></td><td class="r">${price(o.price)}</td><td class="r">${o.notional != null ? usd(o.notional, { compact: false, digits: 2 }) : "—"}</td><td class="r">${o.backers.length}</td><td class="r mono t3">#${o.id}</td></tr>`).join("")}</tbody></table></div>` : '<div class="empty">No orders resting. The keeper quotes markets with a reachable cluster above the venue minimum.</div>'}</div>
      <div class="card enter"><div class="card-h" style="padding-bottom:8px"><h2>Activity</h2><span class="hint">the vault's own events</span></div>${eventsTable()}</div>
      </div>
      <div class="grid" style="align-content:start">
      <div class="card pad enter" style="display:grid;gap:16px;align-content:start"><h2 style="font-size:14px;font-weight:500">What the contract enforces</h2>
        <ol class="rules">
          <li><span><b>Caps.</b> One order stays under ${v.clusterCapBps / 100}% of assets; one market under ${v.marketCapBps / 100}%${v.oiCapBps != null ? ` and under ${v.oiCapBps / 100}% of that market's open interest` : ""}.</span></li>
          <li><span><b>Windows.</b> An order rests only while every account it cites can still be closed at its price. Reactivity re-checks on each of their position updates.</span></li>
          <li><span><b>Entry.</b> A caught position is offered back at or past its entry, never below.</span></li>
          <li><span><b>Exit.</b> Redemptions cancel resting orders to free margin. No other address can move funds.</span></li>
          <li><span><b>Maker only.</b> Orders are post-only. The vault never takes liquidity and cannot liquidate anyone.</span></li>
          ${v.maxIndexDeviationBps != null ? `<li><span><b>Price check.</b> No quote while the mark is more than ${v.maxIndexDeviationBps / 100}% from the oracle index or the index is older than ${v.maxIndexAgeSeconds} seconds.</span></li>
          <li><span><b>Lock.</b> New shares can't be redeemed or moved for ${fmtDelay(v.redeemDelaySeconds)}.</span></li>` : ""}
        </ol>
        <p class="t3" style="font-size:12px">Contract ${addrLink(v.address)}${d?.deployTx ? `, deployed in ${txLink(d.deployTx)}` : ""}</p>
      </div>
      ${proofsCard(d)}
      </div>
    </section>
`;
  priceLine($("#navChart"), navPoints(v), { height: 160 });

  let mode = "deposit";
  const label = () => (!w?.account ? "Connect wallet" : mode === "deposit" ? "Deposit USDso" : locked ? "Locked until the delay passes" : "Redeem shares");
  const preview = () => {
    const x = parseFloat($("#amt").value);
    $("#preview").textContent = !(x > 0) ? (mode === "deposit" ? `USDso in, shares out at ${v.sharePrice.toFixed(4)} per 1,000` : "Shares in, USDso out at the current share price")
      : mode === "deposit" ? `${usd(x, { compact: false, digits: 2 })} USDso buys about ${qty((x / v.sharePrice) * 1000)} shares`
      : `${qty(x)} shares redeem for about ${usd((x * v.sharePrice) / 1000, { compact: false, digits: 2 })} USDso`;
  };
  $("#amt").addEventListener("input", preview);
  $("#dwSeg").addEventListener("click", (e) => {
    const k = e.target.dataset.k; if (!k) return;
    mode = k;
    for (const b of $("#dwSeg").children) b.classList.toggle("on", b.dataset.k === k);
    $("#dwGo").textContent = label();
    $("#dwGo").disabled = !!(w?.account && mode === "redeem" && locked);
    preview();
  });
  $("#dwGo").addEventListener("click", async () => {
    const btn = $("#dwGo");
    try {
      if (!w?.account) { await w.connect(); return; }
      const amount = toUnits($("#amt").value);
      if (!amount) { toast("Enter an amount"); return; }
      btn.disabled = true;
      if (mode === "deposit") {
        const allowance = BigInt(await w.call(v.asset, calldata.allowance(w.account, v.address)));
        if (allowance < amount) { btn.textContent = "Approve USDso in your wallet"; await w.send(v.asset, calldata.approve(v.address, amount)); }
        btn.textContent = "Confirm the deposit in your wallet";
        const h = await w.send(v.address, calldata.deposit(amount, w.account));
        toast(`Deposited in ${h.slice(0, 10)}…`);
      } else {
        btn.textContent = "Confirm the redemption in your wallet";
        const h = await w.send(v.address, calldata.redeem(amount, w.account));
        toast(`Redeemed in ${h.slice(0, 10)}…`);
      }
      await loadCore(); render();
    } catch (e) { toast(e.message || String(e)); btn.disabled = false; btn.textContent = label(); }
  });
}

function trackRecord(v) {
  const rows = (v.retired || []).filter((r) => r.performance?.deposited > 0);
  if (!rows.length) return "";
  return `<div class="history">${rows.map((r) => {
    const p = r.performance, back = p.redeemed + p.stillInside, res = back / p.deposited - 1;
    return `<div class="past">
      <div class="h"><span>Earlier vault <span class="mono t3">${esc(r.tag)}</span> ${addrLink(r.vault)}</span><b class="${res >= 0 ? "up" : "down"}">${res >= 0 ? "+" : ""}${pct(res, 1)}</b></div>
      <div class="t2">${usd(p.deposited, { compact: false, digits: 2 })} in, ${usd(back, { compact: false, digits: 2 })} paid back on redemption</div>
      ${r.retired?.reason ? `<div class="t3">Replaced: ${esc(r.retired.reason)}</div>` : ""}
    </div>`;
  }).join("")}</div>`;
}

/** On-chain proofs recorded in the deployment file, each with the transactions that show it. */
function proofsCard(d) {
  const proven = new Set((d?.evidence || []).filter((e) => e.status === "proven").map((e) => e.kind));
  const ev = (d?.evidence || []).filter((e) => e.status === "proven" || !proven.has(e.kind));
  // one of each kind, newest first, so a long record does not bury the rarer proofs
  const pick = [];
  for (const k of ["catch", "auto-cancel", "fill", "refusal", "redeem"]) {
    const list = ev.filter((e) => e.kind === k).sort((a, b) => (b.block ?? 0) - (a.block ?? 0));
    if (list.length) pick.push({ e: list[0], n: list.length });
  }
  if (!pick.length) return `<div class="card enter"><div class="card-h"><h2>Live proofs</h2></div><div class="empty">The keeper records proofs here as they land on chain.</div></div>`;
  return `<div class="card enter"><div class="card-h"><h2>Live proofs</h2><span class="hint">by transaction, on ${esc(state.status?.network?.label ?? "")}</span></div>
    <div style="margin-top:8px">${pick.map(({ e, n }) => `<div class="proof">
      <div class="h"><b>${esc(e.title)}</b><span class="badge ${e.status === "proven" ? "ok" : "wait"}">${e.status === "proven" ? (n > 1 ? `Proven ${n}×` : "Proven") : "Waiting"}</span></div>
      <p>${esc(e.detail)}</p>
      ${(e.txs || []).map((t) => `<div class="tx"><span>${esc(t.label)}</span>${txLink(t.tx)}</div>`).join("")}
    </div>`).join("")}</div></div>`;
}

function eventsTable() {
  const ev = state.vault?.events || [];
  if (!ev.length) return `<div class="empty">No events yet.</div>`;
  const label = { Placed: "Order placed", Released: "Order released", Caught: "Position caught", Unwinding: "Unwind resting", Deposited: "Deposit", Redeemed: "Redemption" };
  const reason = ["", "filled", "an account moved", "replaced by a larger cluster", "freed for a redemption", "repriced", "mark off index"];
  return `<div class="scroll"><table class="table"><thead><tr><th>Event</th><th>Detail</th><th class="r">Block</th><th class="r">Tx</th></tr></thead><tbody>
    ${ev.filter((e) => label[e.event]).slice(0, 60).map((e) => {
      const a = e.args;
      const detail = e.event === "Deposited" ? `${usd(Number(a.assets) / 1e18, { compact: false, digits: 2 })} by ${short(a.owner)}`
        : e.event === "Redeemed" ? `${usd(Number(a.assets) / 1e18, { compact: false, digits: 2 })} to ${short(a.owner)}`
        : e.event === "Placed" ? `${a.isBid ? "Bid" : "Ask"} at ${price(Number(a.price) / 1e18)}, ${a.backers.length} account${a.backers.length > 1 ? "s" : ""} cited`
        : e.event === "Released" ? `Slot #${a.slotId}, ${reason[Number(a.reason)] || a.reason}`
        : e.event === "Caught" ? `Position now ${a.newSize} at ${price(Number(a.avgEntryPrice) / 1e18)}`
        : e.event === "Unwinding" ? `${a.isBid ? "Bid" : "Ask"} at ${price(Number(a.price) / 1e18)}` : "";
      return `<tr><td>${label[e.event]}</td><td class="t2">${esc(detail)}</td><td class="r mono t3">${int(e.block)}</td><td class="r">${txLink(e.tx)}</td></tr>`;
    }).join("")}</tbody></table></div>`;
}

// ------------------------------------------------------------------ liquidations, contracts

function liquidationsView() {
  const st = state.liq?.stats;
  setHead("Liquidations", "from the venue's LiquidationEngine");
  marketPicker(false);
  view.innerHTML = `
    <section class="grid stats">
      ${stat("Account liquidations read", st ? int(st.accounts) : wait("Reading"), st?.from ? `since ${new Date(st.from).toLocaleDateString()}` : "")}
      ${stat("Sent to an empty book", st ? pct(st.emptyBookShare) : wait("Reading"), st ? `${int(st.emptyBook)} accounts` : "")}
      ${stat("Went past the book", st ? pct(st.pastBookShare) : wait("Reading"), "bidder, insurance fund or ADL")}
      ${stat("Engine close window", state.status?.engine ? `${state.status.engine.minSpreadBps / 100} to ${state.status.engine.maxSpreadBps / 100}%` : wait("Reading"), `from the mark · ${int(state.status?.engine?.bidderCount)} registered bidder${state.status?.engine?.bidderCount === 1 ? "" : "s"}`)}
    </section>
    <section class="grid main-side">
      <div class="card enter"><div class="card-h" style="padding-bottom:8px"><h2>Position liquidations</h2><span class="hint">most recent first</span></div>${liqTable(200)}</div>
      <div class="grid" style="align-content:start">
        <div class="card enter"><div class="card-h" style="padding-bottom:16px"><h2>Stage reached</h2></div>${stageBlock(st)}</div>
        <div class="card enter"><div class="card-h" style="padding-bottom:8px"><h2>Recent accounts</h2></div><div class="scroll" style="max-height:360px"><table class="table"><thead><tr><th>Account</th><th>Stage</th><th class="r">Closed</th><th class="r">When</th></tr></thead><tbody>
          ${(state.liq?.recentAccounts || []).map((r) => `<tr><td>${addrLink(r.account)}</td><td class="t2">${esc(STAGE_LABEL[r.stage] ?? r.stage)}</td><td class="r ${r.stage === "CLOBPartial" && !r.positionsProcessed ? "down" : ""}">${r.positionsProcessed}</td><td class="r t3">${ago(r.at)}</td></tr>`).join("")}
        </tbody></table></div></div>
      </div>
    </section>`;
}

function contractsView() {
  setHead("Contracts", "everything the app reads");
  marketPicker(false);
  const s = state.status;
  const d = state.vault?.deployment;
  const row = (name, a, note) => `<tr><td>${name}</td><td>${a ? (explorer() ? `<a class="addr mono" href="${explorer()}/address/${esc(a)}" target="_blank" rel="noopener">${esc(a)}</a>` : `<span class="mono t2">${esc(a)}</span>`) : '<span class="t3">—</span>'}</td><td class="t2">${note}</td></tr>`;
  view.innerHTML = `<section class="card enter"><div class="card-h" style="padding-bottom:8px"><h2>${esc(s?.network?.label ?? "")}, chain ${esc(s?.network?.chainId ?? "")}</h2><span class="hint">head ${int(s?.head)}</span></div>
    <div class="scroll" style="max-height:none"><table class="table"><thead><tr><th>Contract</th><th>Address</th><th>Role</th></tr></thead><tbody>
    ${row("CatchVault", d?.vault, d ? `Deployed at block ${int(d.deployBlock)}` : "Not deployed on this network")}
    ${(state.vault?.state?.retired || []).map((r) => row(`CatchVault ${esc(r.tag)}`, r.vault, `Retired: ${esc(r.retired?.reason ?? "")}`)).join("")}
    ${row("MarginBank", s?.system?.marginBank, "Positions, health, bankruptcy prices, holder lists")}
    ${row("LiquidationEngine", s?.system?.liquidationEngine, `Penalty ${(s?.engine?.penaltyBps ?? 0) / 100}%, close window ${(s?.engine?.minSpreadBps ?? 0) / 100} to ${(s?.engine?.maxSpreadBps ?? 0) / 100}% from the mark`)}
    ${row("InsuranceFund", s?.system?.insuranceFund, "Stage 5 of the waterfall")}
    ${row("USDso", s?.system?.collateral, "Collateral and the vault's asset")}
    ${(state.markets || []).map((m) => row(`${esc(baseOf(m.symbol))}-PERP`, m.pool, "PerpPool")).join("")}
    </tbody></table></div></section>
    ${s?.errors?.length ? `<section class="card pad enter"><h2 style="font-size:14px;font-weight:500;margin-bottom:8px">Recent read errors</h2>${s.errors.map((e) => `<div class="mono t3" style="margin:4px 0">${new Date(e.at).toLocaleTimeString()} ${esc(e.msg)}</div>`).join("")}</section>` : ""}`;
}

// ------------------------------------------------------------------ router

const ROUTES = { overview, map: mapView, markets: marketsView, vault: vaultView, liquidations: liquidationsView, contracts: contractsView };

function parseRoute() {
  const [path, q] = location.hash.replace(/^#\/?/, "").split("?");
  const route = ROUTES[path] ? path : "overview";
  const m = new URLSearchParams(q || "").get("m");
  if (m) state.pool = m;
  return route;
}

async function render() {
  state.route = parseRoute();
  for (const a of document.querySelectorAll("#nav a")) a.classList.toggle("on", a.dataset.route === state.route);
  tip.hidden = true;
  try {
    await ROUTES[state.route]();
  } catch (e) {
    view.innerHTML = `<div class="notice"><span class="dot stale"></span><div><b>Could not read the engine.</b> ${esc(e.message)}</div></div>`;
  }
}

view.addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-pool]");
  if (tr) location.hash = `#/map?m=${tr.dataset.pool}`;
});
window.addEventListener("hashchange", render);
let resizeT;
window.addEventListener("resize", () => { clearTimeout(resizeT); resizeT = setTimeout(() => ["map", "overview", "vault"].includes(state.route) && render(), 150); });

async function boot() {
  view.innerHTML = `<section class="card"><div class="loading"><b>Reading the chain</b><span>Vault, venue history and markets</span></div></section>`;
  try { await loadCore(); } catch (e) {
    view.innerHTML = `<div class="notice"><span class="dot stale"></span><div><b>Waiting for the engine.</b> Trying again in a few seconds. If this stays, start it with <span class="mono">npm start</span> in <span class="mono">engine/</span>. <span class="t3">${esc(e.message)}</span></div></div>`;
    setTimeout(boot, 5_000);
    return;
  }
  renderConnect();
  await render();
  // refresh quietly; the vault view holds form input and is not re-rendered on a timer
  setInterval(async () => {
    try {
      await loadCore();
      state.maps.delete(String(state.pool).toLowerCase());
      if (["overview", "markets", "liquidations", "contracts"].includes(state.route)) render();
    } catch {}
  }, 20_000);
}

boot();
