// Catch dashboard: hash-routed views over the engine API. Every number on screen comes from
// /api/*, which reads the chain and the venue's indexer.
import { esc, usd, price, qty, pct, int, short, ago, baseOf } from "./fmt.mjs";
import { liquidationMap, spark } from "./chart.mjs";
import { Wallet, calldata, toUnits, fromUnits } from "./wallet.mjs";

const API = window.CATCH_API || "";
const $ = (sel, root = document) => root.querySelector(sel);
const view = $("#view");
const tip = $("#tip");

const state = { status: null, markets: null, liq: null, vault: null, maps: new Map(), pool: null, route: "overview", wallet: null, me: null };

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
    }).finally(() => { marketsInFlight = null; });
  }
  const [status, liq, vault] = await Promise.all([get("/api/status"), get("/api/liquidations"), get("/api/vault")]);
  Object.assign(state, { status, liq, vault });
  const markets = state.markets || [];
  if (!state.pool && markets.length) state.pool = (new URLSearchParams(location.hash.split("?")[1]).get("m")) || markets[0].pool;
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
const txLink = (hash) => {
  const ex = state.status?.network?.explorer;
  return ex ? `<a class="addr mono" href="${ex}/tx/${esc(hash)}" target="_blank" rel="noopener">${short(hash)}</a>` : `<span class="mono fog" title="${esc(hash)}">${short(hash)}</span>`;
};
const addrLink = (a) => {
  const ex = state.status?.network?.explorer;
  return ex ? `<a class="addr mono" href="${ex}/address/${esc(a)}" target="_blank" rel="noopener">${short(a)}</a>` : `<span class="mono fog" title="${esc(a)}">${short(a)}</span>`;
};
const coin = (sym) => `<span class="coin">${esc(baseOf(sym).slice(0, 4))}</span>`;

// ------------------------------------------------------------------ chrome

function renderChrome() {
  const s = state.status;
  if (!s) return;
  $("#netName").textContent = s.network.label;
  $("#headBlock").textContent = s.head ? `block ${int(s.head)}` : "reading chain";
  if (s.head !== renderChrome.head) { renderChrome.head = s.head; renderChrome.at = Date.now(); }
  const stale = !s.head || Date.now() - renderChrome.at > 90_000;
  $("#liveDot").className = "dot " + (stale ? "stale" : "live");
  if (stale && s.head) $("#headBlock").textContent = `block ${int(s.head)} · stale`;
}

function renderConnect() {
  const b = $("#connect");
  const w = state.wallet;
  if (w?.account) { b.textContent = short(w.account); b.classList.add("ghost"); }
  else { b.textContent = "Connect wallet"; }
}

$("#connect").addEventListener("click", async () => {
  try { await state.wallet?.connect(); } catch (e) { toast(e.message); }
});

function toast(msg) {
  tip.hidden = false;
  tip.innerHTML = esc(msg);
  tip.style.left = "auto"; tip.style.right = "24px"; tip.style.top = "72px";
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { tip.hidden = true; tip.style.right = ""; }, 4200);
}

function setHead(title, sub = "") {
  $("#title").textContent = title;
  $("#subtitle").textContent = sub;
  document.title = `${title} · Catch`;
}

function marketPicker(show) {
  const el = $("#marketPick");
  if (!show || !state.markets) { el.innerHTML = ""; return; }
  el.innerHTML = `<select id="mp" aria-label="Market">${state.markets.map((m) => `<option value="${esc(m.pool)}" ${m.pool === state.pool ? "selected" : ""}>${esc(baseOf(m.symbol))}-PERP</option>`).join("")}</select>`;
  $("#mp").addEventListener("change", (e) => { state.pool = e.target.value; render(); });
}

// ------------------------------------------------------------------ aggregates

function totals() {
  const mapped = (state.markets || []).filter((m) => m.risk);
  let r5 = 0, a5 = 0, r1 = 0, clusterN = 0, resting = 0;
  for (const m of mapped) {
    r5 += m.risk["5%"].long + m.risk["5%"].short;
    a5 += m.risk["5%"].accounts;
    r1 += m.risk["1%"].long + m.risk["1%"].short;
    for (const c of m.clusters || []) if (c) { clusterN += c.notional; resting += c.restingInWindow; }
  }
  return { r5, a5, r1, coverage: clusterN ? resting / clusterN : null, mapped: mapped.length };
}

function kpi(label, value, foot = "", cls = "") {
  return `<div class="card pad kpi fade"><div class="label">${label}</div><div class="value ${cls}">${value}</div><div class="foot">${foot}</div></div>`;
}

// ------------------------------------------------------------------ views

const STAGE_LABEL = { OrderCancellation: "Order cancellation", CLOBPartial: "Closed into the book", BidderTakeover: "Bidder takeover", InsuranceFund: "Insurance fund", ADL: "Auto-deleverage", Deferred: "Deferred" };

async function overview() {
  setHead("Overview", state.status ? `${state.status.network.label} · dreamDEX perps` : "");
  marketPicker(false);
  const t = totals();
  const st = state.liq?.stats;
  const v = state.vault?.state;
  const top = state.markets?.[0];
  view.innerHTML = `
    <section class="grid kpis">
      ${state.markets ? kpi("Liquidations within 5% of mark", usd(t.r5), `${int(t.a5)} accounts across ${t.mapped} markets`) : kpi("Liquidations within 5% of mark", "…", "Reading every open position")}
      ${state.markets ? kpi("Within 1% of mark", usd(t.r1), "Would trigger on a 1% move") : kpi("Within 1% of mark", "…", "Reading every open position")}
      ${kpi("Book inside catch windows", t.coverage == null ? "…" : pct(t.coverage), "Resting liquidity vs. largest clusters")}
      ${kpi("Liquidations into an empty book", st ? pct(st.emptyBookShare) : "—", st ? `${int(st.emptyBook)} of the last ${int(st.accounts)}` : "Venue history")}
      ${v ? kpi("Vault assets", usd(v.totalAssets), `${v.markets.reduce((n, m) => n + m.slots.length, 0)} resting orders`) : kpi("Vault", "Not deployed", "On this network", "muted")}
    </section>
    <section class="grid two">
      <div class="card fade">
        <div class="card-h"><h2>${top ? esc(baseOf(top.symbol)) + "-PERP liquidation map" : "Liquidation map"}</h2><a class="hint" href="#/map?m=${esc(top?.pool ?? "")}">Open map</a></div>
        <div class="card-b"><div class="chart" id="ovChart"><div class="skel" style="height:300px"></div></div>
        <div class="legend" style="margin-top:10px"><span><i style="background:#ff5c4d"></i>Long liquidations</span><span><i style="background:#22c55e"></i>Short liquidations</span><span><i style="background:#7fa9ff"></i>Bids resting</span><span><i style="background:#1c6cff"></i>Catch cluster</span></div></div>
      </div>
      <div class="card fade">
        <div class="card-h"><h2>How liquidations resolved</h2><span class="hint">Last ${int(st?.accounts ?? 0)} account liquidations</span></div>
        <div class="card-b">${stageBlock(st)}</div>
      </div>
    </section>
    <section class="grid halves">
      <div class="card fade"><div class="card-h"><h2>Largest clusters</h2><span class="hint">Best bid and ask per market</span></div>${clustersTable(8)}</div>
      <div class="card fade"><div class="card-h"><h2>Latest liquidations</h2><a class="hint" href="#/liquidations">All</a></div>${liqTable(8)}</div>
    </section>`;
  if (top) {
    const m = state.maps.get(top.pool.toLowerCase()) || (await loadMap(top.pool));
    if (state.route === "overview") liquidationMap($("#ovChart"), m, { height: 300, compact: true, tip });
  }
}

function stageBlock(st) {
  if (!st) return `<div class="empty">Reading the venue's liquidation history…</div>`;
  const order = [["OrderCancellation", "Order cancellation", "#5c6f8a"], ["CLOBPartial", "Closed into the book", "#1c6cff"], ["BidderTakeover", "Bidder takeover", "#ffb020"], ["InsuranceFund", "Insurance fund", "#ff8833"], ["ADL", "Auto-deleverage", "#ff5c4d"]];
  const total = st.accounts || 1;
  const bar = order.map(([k, , c]) => `<i style="width:${((st.byStage[k] || 0) / total) * 100}%;background:${c}"></i>`).join("");
  const rows = order.map(([k, label, c]) => `<tr><td><span class="legend"><span><i style="background:${c}"></i>${label}</span></span></td><td class="r">${int(st.byStage[k] || 0)}</td><td class="r muted">${pct((st.byStage[k] || 0) / total)}</td></tr>`).join("");
  return `<div class="stack" style="margin:4px 0 14px">${bar}</div>
    <table class="table"><tbody>${rows}
    <tr><td><b>Book was empty</b><div class="muted" style="font-size:12px">Closed into the book, nothing filled</div></td><td class="r"><b>${int(st.emptyBook)}</b></td><td class="r"><b>${pct(st.emptyBookShare)}</b></td></tr></tbody></table>
    <p class="muted" style="font-size:12px;margin:12px 0 0">${st.from ? `${new Date(st.from).toLocaleDateString()} to ${new Date(st.to).toLocaleDateString()}. ` : ""}Read from the venue's LiquidationEngine events.</p>`;
}

function clustersTable(limit = 50) {
  const rows = [];
  for (const m of state.markets || []) for (const c of m.clusters || []) if (c) rows.push({ m, c });
  rows.sort((a, b) => b.c.notional - a.c.notional);
  if (!rows.length) return `<div class="empty">Mapping markets…</div>`;
  return `<div class="scroll"><table class="table"><thead><tr><th>Market</th><th>Side</th><th class="r">Price</th><th class="r">From mark</th><th class="r">Notional</th><th class="r">Book in window</th></tr></thead><tbody>
    ${rows.slice(0, limit).map(({ m, c }) => `<tr class="click" data-pool="${esc(m.pool)}"><td><div class="sym">${coin(m.symbol)}<b>${esc(baseOf(m.symbol))}</b></div></td>
      <td><span class="tag ${c.side === "bid" ? "long" : "short"}">${c.side === "bid" ? "Longs" : "Shorts"}</span></td>
      <td class="r">${price(c.price, m.markPrice)}</td><td class="r muted">${pct((c.price - m.markPrice) / m.markPrice, 2)}</td>
      <td class="r">${usd(c.notional)}</td><td class="r ${c.coverage < 0.25 ? "down" : ""}">${usd(c.restingInWindow)}</td></tr>`).join("")}
  </tbody></table></div>`;
}

function liqTable(limit = 100) {
  const rows = (state.liq?.rows || []).filter((r) => r.kind === "PositionLiquidated" || r.kind === "AutoDeleveraged").slice(0, limit);
  if (!rows.length) return `<div class="empty">No liquidations indexed yet.</div>`;
  return `<div class="scroll"><table class="table"><thead><tr><th>Market</th><th>Kind</th><th class="r">Size</th><th class="r">Price</th><th>Account</th><th class="r">When</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td><div class="sym">${coin(r.symbol || "?")}<b>${esc(baseOf(r.symbol) || "—")}</b></div></td>
      <td><span class="tag ${r.kind === "AutoDeleveraged" ? "amber" : r.size > 0 ? "long" : "short"}">${r.kind === "AutoDeleveraged" ? "ADL" : r.size > 0 ? "Long" : "Short"}</span></td>
      <td class="r">${qty(Math.abs(r.size))}</td><td class="r">${price(r.price)}</td><td>${addrLink(r.account)}</td><td class="r muted">${ago(r.at)}</td></tr>`).join("")}
  </tbody></table></div>`;
}

async function mapView() {
  if (!state.markets) { setHead("Liquidation map", "Reading every open position"); view.innerHTML = `<div class="skel" style="height:460px"></div>`; return; }
  const m0 = market(state.pool) || state.markets?.[0];
  if (!m0) { view.innerHTML = `<div class="empty">No markets.</div>`; return; }
  state.pool = m0.pool;
  setHead(`${baseOf(m0.symbol)}-PERP`, "Liquidation map");
  marketPicker(true);
  view.innerHTML = `<div class="skel" style="height:460px"></div>`;
  const m = state.maps.get(m0.pool.toLowerCase()) || (await loadMap(m0.pool));
  if (state.route !== "map" || state.pool !== m0.pool) return;
  const r = m.risk;
  view.innerHTML = `
    <section class="grid kpis">
      ${kpi("Mark", price(m.markPrice), `Maintenance ${(m.maintenanceMarginBps / 100).toFixed(2)}%`)}
      ${kpi("Open positions", int(m.positions), `${int(m.holders.long)} long · ${int(m.holders.short)} short`)}
      ${kpi("Within 1%", usd(r["1%"].long + r["1%"].short), `${int(r["1%"].accounts)} accounts`)}
      ${kpi("Within 5%", usd(r["5%"].long + r["5%"].short), `${usd(r["5%"].long)} long · ${usd(r["5%"].short)} short`)}
      ${kpi("Within 10%", usd(r["10%"].long + r["10%"].short), `${int(r["10%"].accounts)} accounts`)}
    </section>
    <section class="grid two">
      <div class="card fade">
        <div class="card-h"><h2>Liquidation notional by trigger price</h2><span class="hint">Block ${int(m.block)} · ${ago(m.at)} · bins of ${price(m.binWidth, m.markPrice)}</span></div>
        <div class="card-b"><div class="chart" id="bigChart"></div>
          <div class="legend" style="margin-top:12px"><span><i style="background:#ff5c4d"></i>Long liquidations</span><span><i style="background:#22c55e"></i>Short liquidations</span><span><i style="background:#7fa9ff"></i>Bids resting</span><span><i style="background:#c3b3ff"></i>Asks resting</span><span><i style="background:#1c6cff"></i>Catch cluster</span><span class="muted">Shaded: cumulative from the mark</span></div>
          ${m.outsideRange ? `<p class="muted" style="font-size:12px;margin:10px 0 0">${int(m.outsideRange)} positions trigger more than 15% from the mark and are off the chart.</p>` : ""}
        </div>
      </div>
      <div class="grid" style="align-content:start">
        ${(m.clusters || []).map((c) => clusterCard(c, m)).join("")}
      </div>
    </section>
    <section class="card fade"><div class="card-h"><h2>Stress</h2><span class="hint">Liquidation notional a mark move crosses, at block ${int(m.block)}</span></div>
      <div class="scroll"><table class="table"><thead><tr><th>Mark move</th><th class="r">Price</th><th>Side forced</th><th class="r">Notional crossed</th><th class="r">Book resting on that side</th></tr></thead><tbody>
      ${["10%", "5%", "3%", "1%"].map((k) => ({ k, d: -parseFloat(k) / 100, v: r[k].long, side: "Longs sold" }))
        .concat(["1%", "3%", "5%", "10%"].map((k) => ({ k, d: parseFloat(k) / 100, v: r[k].short, side: "Shorts bought" })))
        .map(({ d, v, side }) => {
          const p = m.markPrice * (1 + d);
          const book = m.bins.reduce((t, b) => t + (d < 0 ? (b.price >= p && b.price < m.markPrice ? b.bidDepth : 0) : (b.price <= p && b.price > m.markPrice ? b.askDepth : 0)), 0);
          return `<tr><td class="${d < 0 ? "down" : "up"}">${d > 0 ? "+" : ""}${(d * 100).toFixed(0)}%</td><td class="r">${price(p, m.markPrice)}</td><td class="fog">${side}</td><td class="r">${usd(v)}</td><td class="r ${v > 0 && book < v * 0.25 ? "down" : ""}">${usd(book)}</td></tr>`;
        }).join("")}
      </tbody></table></div></section>
    <section class="card fade"><div class="card-h"><h2>Closest to liquidation</h2><span class="hint">Single-market solve, as the venue publishes it</span></div>
      <div class="scroll"><table class="table"><thead><tr><th>Account</th><th>Side</th><th class="r">Size</th><th class="r">Entry</th><th class="r">Liquidation</th><th class="r">From mark</th><th class="r">Notional</th></tr></thead><tbody>
      ${m.near.map((p) => `<tr><td>${addrLink(p.account)}</td><td><span class="tag ${p.side}">${p.side === "long" ? "Long" : "Short"}</span></td><td class="r">${qty(p.size)} ${esc(m.base)}</td><td class="r">${price(p.entry, m.markPrice)}</td><td class="r">${price(p.liq, m.markPrice)}</td><td class="r ${p.distance < 0.02 ? "down" : "muted"}">${pct(p.distance, 2)}</td><td class="r">${usd(p.notional)}</td></tr>`).join("")}
      </tbody></table></div></section>`;
  liquidationMap($("#bigChart"), m, { height: 420, tip });
}

function clusterCard(c, m) {
  if (!c) return "";
  const long = c.side === "bid";
  return `<div class="cluster fade">
    <div class="head"><span class="tag ${long ? "long" : "short"}">${long ? "Bid under longs" : "Ask over shorts"}</span><span class="muted" style="font-size:12px">${int(c.accountsInWindow)} accounts in window</span></div>
    <div class="price">${price(c.price, m.markPrice)} <span class="muted" style="font-size:13px;font-family:Matter">${pct((c.price - m.markPrice) / m.markPrice, 2)}</span></div>
    <dl class="kv">
      <dt>Forced size</dt><dd>${qty(c.size)} ${esc(m.base)}</dd>
      <dt>Notional</dt><dd>${usd(c.notional)}</dd>
      <dt>Catch window</dt><dd>${price(c.window.lo, m.markPrice)} – ${price(c.window.hi, m.markPrice)}</dd>
      <dt>Book in window</dt><dd class="${c.coverage < 0.25 ? "down" : ""}">${usd(c.restingInWindow)} · ${pct(Math.min(c.coverage, 9.99), 0)}</dd>
      <dt>Backers cited</dt><dd>${c.backers.length}</dd>
      <dt>Vault order</dt><dd>${c.vaultOrderQty == null ? '<span class="muted">Vault not deployed</span>' : c.vaultOrderQty > 0 ? `${qty(c.vaultOrderQty)} ${esc(m.base)}` : '<span class="muted">Below venue minimum</span>'}</dd>
    </dl>
  </div>`;
}

function marketsView() {
  setHead("Markets", `${state.markets?.length ?? 0} tradeable perps`);
  marketPicker(false);
  const rows = state.markets || [];
  view.innerHTML = `<section class="card fade"><div class="scroll" style="max-height:none"><table class="table"><thead><tr>
    <th>Market</th><th class="r">Mark</th><th class="r">Open interest</th><th class="r">Funding</th><th class="r">Positions</th><th class="r">Within 1%</th><th class="r">Within 5%</th><th>Map</th><th class="r">Book in window</th><th class="r">Read</th></tr></thead><tbody>
    ${rows.map((m) => {
      const bin = state.maps.get(m.pool.toLowerCase());
      const cov = m.clusters?.filter(Boolean) ?? [];
      const n = cov.reduce((a, c) => a + c.notional, 0), rest = cov.reduce((a, c) => a + c.restingInWindow, 0);
      return `<tr class="click" data-pool="${esc(m.pool)}"><td><div class="sym">${coin(m.symbol)}<b>${esc(baseOf(m.symbol))}</b><span class="muted">PERP</span></div></td>
      <td class="r">${price(m.markPrice)}</td><td class="r">${usd(m.openInterest * m.markPrice)}</td>
      <td class="r ${m.fundingRate >= 0 ? "up" : "down"}">${m.fundingRate == null ? "—" : (m.fundingRate * 100).toFixed(4) + "%"}</td>
      <td class="r">${m.positions == null ? '<span class="muted">—</span>' : int(m.positions)}</td>
      <td class="r">${m.risk ? usd(m.risk["1%"].long + m.risk["1%"].short) : "—"}</td>
      <td class="r">${m.risk ? usd(m.risk["5%"].long + m.risk["5%"].short) : "—"}</td>
      <td>${bin ? spark(bin.bins, bin.markPrice) : '<span class="muted">—</span>'}</td>
      <td class="r ${n && rest / n < 0.25 ? "down" : ""}">${n ? pct(rest / n, 0) : "—"}</td>
      <td class="r muted">${m.snapshotAt ? ago(m.snapshotAt) : "queued"}</td></tr>`;
    }).join("")}
  </tbody></table></div></section>`;
  // fill sparklines for markets not yet fetched into the client cache
  for (const m of rows) if (m.mapped && !state.maps.get(m.pool.toLowerCase())) loadMap(m.pool).then(() => state.route === "markets" && marketsView()).catch(() => {});
}

async function vaultView() {
  let v = state.vault?.state;
  const d = state.vault?.deployment;
  setHead("Vault", v ? short(v.address) : "Simulated on live data");
  marketPicker(false);
  const rules = `<ol class="rules">
    <li>Per-market exposure stays under the market cap; a single cluster order stays under the cluster cap. Both are fixed at deploy.</li>
    <li>An order rests only while every account it cites still holds a position whose catch window contains the order price. Reactivity re-checks on each of their position updates.</li>
    <li>A caught position is offered back at or beyond its entry, never below.</li>
    <li>Redemptions cancel resting orders until enough collateral is free.</li>
    <li>Orders are post-only. The vault never takes liquidity and has no owner.</li></ol>`;
  const sim = !v;
  if (sim) v = simulateVault();
  const w = state.wallet;
  let mine = null;
  if (w?.account && !sim) {
    try {
      const sh = BigInt(await w.call(v.address, calldata.balanceOf(w.account)));
      const as = sh ? BigInt(await w.call(v.address, calldata.convertToAssets(sh))) : 0n;
      const bal = BigInt(await w.call(v.asset, calldata.balanceOf(w.account)));
      mine = { shares: sh, assets: as, wallet: bal };
    } catch (e) { mine = { error: e.message }; }
  }
  const orders = v.markets.flatMap((m) => m.slots.map((s) => ({ ...s, m })));
  view.innerHTML = `
    ${sim ? `<div class="notice fade"><span class="dot stale" style="margin-top:6px"></span><div><b>Simulated vault.</b> CatchVault is not deployed on ${esc(state.status?.network?.label ?? "this network")} yet. This page shows what a ${usd(v.totalAssets, { compact: false })} USDso vault would rest right now, sized by the contract's caps from the live liquidation map. No order below is on the book, and deposits open at deploy.</div></div>` : ""}
    <section class="grid kpis">
      ${kpi("Vault assets", usd(v.totalAssets, { compact: false, digits: 2 }), sim ? "Simulated deposit" : "Idle + bank equity + locked")}
      ${kpi("Share price", v.sharePrice.toFixed(6), sim ? "USDso per share" : `USDso per 1,000 shares · ${qty(v.totalSupply)} shares`)}
      ${kpi("Free collateral", usd(v.free), sim ? "After initial margin" : "Withdrawable now")}
      ${kpi("Locked in orders", usd(v.locked), sim ? `${orders.length} orders, venue initial margin` : `${orders.length} resting`)}
      ${kpi("Caps", `${v.marketCapBps / 100}% / ${v.clusterCapBps / 100}%`, "Per market / per cluster")}
    </section>
    <section class="grid two">
      <div class="grid" style="align-content:start">
        <div class="card fade"><div class="card-h"><h2>Exposure by market</h2><span class="hint">Cap ${usd((v.totalAssets * v.marketCapBps) / 10000)} each</span></div>
          <div class="card-b">${v.markets.length ? v.markets.map((m) => `<div style="display:grid;grid-template-columns:120px 1fr 110px;gap:12px;align-items:center;margin:8px 0"><div class="sym">${coin(m.symbol)}<b>${esc(baseOf(m.symbol))}</b></div><div class="meter"><i style="width:${Math.min(100, (m.exposure / ((v.totalAssets * v.marketCapBps) / 10000 || 1)) * 100)}%"></i></div><div class="r num" style="text-align:right">${usd(m.exposure)}</div></div>`).join("") : '<div class="empty">No market quoted yet.</div>'}</div></div>
        <div class="card fade"><div class="card-h"><h2>${sim ? "Orders it would rest" : "Resting orders"}</h2><span class="hint">${sim ? "From the current clusters" : "On the venue's book"}</span></div>
          ${orders.length ? `<div class="scroll"><table class="table"><thead><tr><th>Slot</th><th>Market</th><th>Kind</th><th class="r">Price</th><th class="r">Notional</th><th class="r">Backers</th><th class="r">Order id</th></tr></thead><tbody>${orders.map((o) => `<tr><td class="mono">#${o.id}</td><td>${esc(baseOf(o.m.symbol))}</td><td><span class="tag ${o.unwind ? "blue" : o.side === "bid" ? "long" : "short"}">${o.unwind ? "Unwind" : o.side === "bid" ? "Bid" : "Ask"}</span></td><td class="r">${price(o.price)}</td><td class="r">${o.notional != null ? usd(o.notional) : "—"}</td><td class="r">${o.backers.length}</td><td class="r mono muted">${esc(o.orderId)}</td></tr>`).join("")}</tbody></table></div>` : '<div class="empty">No orders resting.</div>'}</div>
        ${sim ? "" : `<div class="card fade"><div class="card-h"><h2>Activity</h2><span class="hint">Vault events</span></div>${eventsTable()}</div>`}
      </div>
      <div class="grid" style="align-content:start">
        <div class="card pad fade">
          <div class="seg" id="dwSeg"><button class="on" data-k="deposit">Deposit</button><button data-k="redeem">Redeem</button></div>
          <div style="height:14px"></div>
          <input class="big" id="amt" placeholder="0.00" inputmode="decimal" autocomplete="off" />
          <div class="muted" id="preview" style="font-size:12.5px;margin-top:8px">At share price ${v.sharePrice.toFixed(6)}</div>
          <div class="kv" style="margin:12px 0 14px"><dt>Wallet</dt><dd>${mine?.wallet != null ? usd(fromUnits(mine.wallet), { compact: false, digits: 2 }) + " USDso" : "—"}</dd><dt>Your shares</dt><dd>${mine?.shares != null ? qty(fromUnits(mine.shares)) : "—"}</dd><dt>Worth</dt><dd>${mine?.assets != null ? usd(fromUnits(mine.assets), { compact: false, digits: 2 }) : "—"}</dd></div>
          <button class="btn wide" id="dwGo" ${sim ? "disabled" : ""}>${sim ? "Opens at deploy" : w?.account ? "Deposit USDso" : "Connect wallet"}</button>
          <p class="muted" style="font-size:12px;margin:10px 0 0">Deposits go straight into the vault's MarginBank account. Redemptions cancel resting orders if collateral is needed.</p>
        </div>
        <div class="card pad fade"><h2 style="margin:0 0 12px;font-size:14px;font-weight:670">Rules the contract enforces</h2>${rules}
          <p class="muted" style="font-size:12px;margin:14px 0 0">${sim ? "Contract: not deployed yet. Source in contracts/src/CatchVault.sol, 55 tests." : `Contract ${addrLink(v.address)}${d?.deployTx ? ` · deployed in ${txLink(d.deployTx)}` : ""}`}</p></div>
      </div>
    </section>`;
  let mode = "deposit";
  const preview = () => {
    const x = parseFloat($("#amt").value);
    $("#preview").textContent = !(x > 0) ? `At share price ${v.sharePrice.toFixed(6)}`
      : mode === "deposit" ? `You deposit ${usd(x, { compact: false, digits: 2 })} USDso → about ${qty((x / v.sharePrice) * (sim ? 1 : 1000))} shares`
      : `You redeem ${qty(x)} shares → about ${usd((x * v.sharePrice) / (sim ? 1 : 1000), { compact: false, digits: 2 })} USDso`;
  };
  $("#amt").addEventListener("input", preview);
  $("#dwSeg").addEventListener("click", (e) => {
    const k = e.target.dataset.k; if (!k) return;
    mode = k;
    for (const b of $("#dwSeg").children) b.classList.toggle("on", b.dataset.k === k);
    $("#dwGo").textContent = w?.account ? (k === "deposit" ? "Deposit USDso" : "Redeem shares") : "Connect wallet";
    preview();
  });
  $("#dwGo").addEventListener("click", async () => {
    try {
      if (!w?.account) { await w.connect(); return; }
      const amount = toUnits($("#amt").value);
      if (!amount) { toast("Enter an amount."); return; }
      const btn = $("#dwGo"); btn.disabled = true;
      if (mode === "deposit") {
        const allowance = BigInt(await w.call(v.asset, calldata.allowance(w.account, v.address)));
        if (allowance < amount) { btn.textContent = "Approving…"; await w.send(v.asset, calldata.approve(v.address, amount)); }
        btn.textContent = "Depositing…";
        const h = await w.send(v.address, calldata.deposit(amount, w.account));
        toast(`Deposited. ${h.slice(0, 10)}…`);
      } else {
        btn.textContent = "Redeeming…";
        const h = await w.send(v.address, calldata.redeem(amount, w.account));
        toast(`Redeemed. ${h.slice(0, 10)}…`);
      }
      await loadCore(); render();
    } catch (e) { toast(e.message || String(e)); $("#dwGo").disabled = false; }
  });
}

/** What a fresh vault would rest right now: each market's best clusters from the live map,
 *  sized by the contract's rules (cluster cap 10%, market cap 25%), with the venue's initial
 *  margin locked against each order. Shown only while no vault is deployed, and labelled. */
function simulateVault(assets = 100_000, marketCapBps = 2500, clusterCapBps = 1000) {
  const clusterCap = (assets * clusterCapBps) / 10000, marketCap = (assets * marketCapBps) / 10000;
  const markets = [];
  let id = 1, locked = 0;
  for (const m of state.markets || []) {
    let exposure = 0;
    const slots = [];
    for (const c of (m.clusters || []).filter(Boolean).sort((a, b) => b.notional - a.notional)) {
      const notional = Math.min(c.notional, clusterCap, marketCap - exposure);
      const margin = (notional * (m.initialMarginBps || 1000)) / 10000;
      if (notional < 50 || locked + margin > assets) continue; // the venue refuses an order the margin cannot back
      exposure += notional;
      locked += margin;
      slots.push({ id: id++, side: c.side, unwind: false, price: c.price, quantity: notional / c.price, notional, orderId: "not placed", backers: c.backers });
    }
    if (slots.length) markets.push({ pool: m.pool, symbol: m.symbol, exposure, slots });
  }
  markets.sort((a, b) => b.exposure - a.exposure);
  return { address: null, asset: null, totalAssets: assets, totalSupply: assets, sharePrice: 1, marketCapBps, clusterCapBps, locked, free: assets - locked, markets };
}

function eventsTable() {
  const ev = state.vault?.events || [];
  if (!ev.length) return `<div class="empty">No events yet.</div>`;
  const label = { Placed: "Order placed", Released: "Order released", Caught: "Position caught", Unwinding: "Unwind resting", Deposited: "Deposit", Redeemed: "Redemption" };
  return `<div class="scroll"><table class="table"><thead><tr><th>Event</th><th>Detail</th><th class="r">Block</th><th class="r">Tx</th></tr></thead><tbody>
    ${ev.filter((e) => label[e.event]).slice(0, 60).map((e) => {
      const a = e.args;
      const detail = e.event === "Deposited" ? `${usd(Number(a.assets) / 1e18, { compact: false, digits: 2 })} by ${short(a.owner)}`
        : e.event === "Redeemed" ? `${usd(Number(a.assets) / 1e18, { compact: false, digits: 2 })} to ${short(a.owner)}`
        : e.event === "Placed" ? `${a.isBid ? "Bid" : "Ask"} at ${price(Number(a.price) / 1e18)} · ${a.backers.length} backers`
        : e.event === "Released" ? `Slot #${a.slotId} · ${["", "filled", "window left", "evicted", "redemption", "repriced"][Number(a.reason)] || a.reason}`
        : e.event === "Caught" ? `Size ${a.newSize} at ${price(Number(a.avgEntryPrice) / 1e18)}`
        : e.event === "Unwinding" ? `${a.isBid ? "Bid" : "Ask"} at ${price(Number(a.price) / 1e18)}` : "";
      return `<tr><td>${label[e.event]}</td><td class="fog">${esc(detail)}</td><td class="r mono muted">${int(e.block)}</td><td class="r">${txLink(e.tx)}</td></tr>`;
    }).join("")}</tbody></table></div>`;
}

function liquidationsView() {
  const st = state.liq?.stats;
  setHead("Liquidations", "From the venue's LiquidationEngine");
  marketPicker(false);
  view.innerHTML = `
    <section class="grid kpis">
      ${kpi("Account liquidations read", int(st?.accounts), st?.from ? `Since ${new Date(st.from).toLocaleDateString()}` : "")}
      ${kpi("Into an empty book", pct(st?.emptyBookShare), `${int(st?.emptyBook)} accounts`, "down")}
      ${kpi("Fell past the book", pct(st?.pastBookShare), "Bidder, insurance or ADL")}
      ${kpi("Engine spread", state.status?.engine ? `${state.status.engine.minSpreadBps / 100}–${state.status.engine.maxSpreadBps / 100}%` : "—", "Min to max, from the mark")}
      ${kpi("Registered bidders", int(state.status?.engine?.bidderCount), "Stage 4 takeover")}
    </section>
    <section class="grid two">
      <div class="card fade"><div class="card-h"><h2>Position liquidations</h2><span class="hint">Most recent first</span></div>${liqTable(200)}</div>
      <div class="grid" style="align-content:start">
        <div class="card fade"><div class="card-h"><h2>Waterfall stage reached</h2></div><div class="card-b">${stageBlock(st)}</div></div>
        <div class="card fade"><div class="card-h"><h2>Recent accounts</h2></div><div class="scroll" style="max-height:360px"><table class="table"><thead><tr><th>Account</th><th>Stage</th><th class="r">Closed</th><th class="r">When</th></tr></thead><tbody>
          ${(state.liq?.recentAccounts || []).map((r) => `<tr><td>${addrLink(r.account)}</td><td class="fog">${esc(STAGE_LABEL[r.stage] ?? r.stage)}</td><td class="r ${r.stage === "CLOBPartial" && !r.positionsProcessed ? "down" : ""}">${r.positionsProcessed}</td><td class="r muted">${ago(r.at)}</td></tr>`).join("")}
        </tbody></table></div></div>
      </div>
    </section>`;
}

function contractsView() {
  setHead("Contracts", "Everything the app reads");
  marketPicker(false);
  const s = state.status;
  const d = state.vault?.deployment;
  const ex = s?.network?.explorer;
  const row = (name, a, note) => `<tr><td>${name}</td><td>${a ? (ex ? `<a class="addr mono" href="${ex}/address/${esc(a)}" target="_blank" rel="noopener">${esc(a)}</a>` : `<span class="mono fog">${esc(a)}</span>`) : '<span class="muted">—</span>'}</td><td class="fog">${note}</td></tr>`;
  view.innerHTML = `<section class="card fade"><div class="card-h"><h2>${esc(s?.network?.label ?? "")} · chain ${esc(s?.network?.chainId ?? "")}</h2><span class="hint">Head ${int(s?.head)}</span></div>
    <div class="scroll" style="max-height:none"><table class="table"><thead><tr><th>Contract</th><th>Address</th><th>Role</th></tr></thead><tbody>
    ${row("CatchVault", d?.vault, d ? `Deployed at block ${int(d.deployBlock)}` : "Not deployed on this network")}
    ${row("MarginBank", s?.system?.marginBank, "Positions, health, bankruptcy prices, holder lists")}
    ${row("LiquidationEngine", s?.system?.liquidationEngine, `Penalty ${(s?.engine?.penaltyBps ?? 0) / 100}%, spread ${(s?.engine?.minSpreadBps ?? 0) / 100}–${(s?.engine?.maxSpreadBps ?? 0) / 100}%`)}
    ${row("InsuranceFund", s?.system?.insuranceFund, "Stage 5 of the waterfall")}
    ${row("USDso", s?.system?.collateral, "Collateral and vault asset")}
    ${(state.markets || []).map((m) => row(`${esc(baseOf(m.symbol))}-PERP`, m.pool, "PerpPool")).join("")}
    </tbody></table></div></section>
    ${s?.errors?.length ? `<section class="card pad fade"><h2 style="margin:0 0 10px;font-size:14px;font-weight:670">Recent read errors</h2>${s.errors.map((e) => `<div class="mono muted" style="margin:4px 0">${new Date(e.at).toLocaleTimeString()} ${esc(e.msg)}</div>`).join("")}</section>` : ""}`;
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
    view.innerHTML = `<div class="notice"><span class="dot stale" style="margin-top:6px"></span><div><b>Could not read the engine.</b> ${esc(e.message)}</div></div>`;
  }
}

view.addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-pool]");
  if (tr) location.hash = `#/map?m=${tr.dataset.pool}`;
});
window.addEventListener("hashchange", render);
let resizeT;
window.addEventListener("resize", () => { clearTimeout(resizeT); resizeT = setTimeout(() => (state.route === "map" || state.route === "overview") && render(), 150); });

async function boot() {
  view.innerHTML = `<section class="grid kpis">${'<div class="skel" style="height:112px"></div>'.repeat(5)}</section><div class="skel" style="height:360px"></div>`;
  try { await loadCore(); } catch (e) {
    view.innerHTML = `<div class="notice"><span class="dot stale" style="margin-top:6px"></span><div><b>The engine is not answering.</b> Start it with <span class="mono">npm start</span> in <span class="mono">engine/</span>. ${esc(e.message)}</div></div>`;
    return;
  }
  renderConnect();
  await render();
  // refresh quietly; views that hold form input are not re-rendered
  setInterval(async () => {
    try {
      await loadCore();
      state.maps.delete(String(state.pool).toLowerCase());
      if (["overview", "markets", "liquidations", "contracts"].includes(state.route)) render();
    } catch {}
  }, 15_000);
}

boot();
