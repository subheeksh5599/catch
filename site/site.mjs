// Landing page data: the same engine API the app reads. Nothing on this page is written by
// hand except the copy; every figure, receipt and proof below is read live.
// Markup is built from formatted numbers, fixed labels and esc()-escaped strings only.
import { esc, usd, price, qty, pct, int, short } from "/app/js/fmt.mjs";
import { liquidationMap } from "/app/js/chart.mjs";

const API = window.CATCH_API || "";
const $ = (s) => document.querySelector(s);
const get = (p) => fetch(API + p, { cache: "no-store" }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${p} ${r.status}`))));
let explorer = null;
const txLink = (h) => (explorer ? `<a class="addr mono" href="${explorer}/tx/${esc(h)}" target="_blank" rel="noopener">${short(h)}</a>` : `<span class="mono t2" title="${esc(h)}">${short(h)}</span>`);
const set = (id, v, foot) => { $(id).textContent = v; if (foot != null) $(`${id}Foot`).textContent = foot; };

function receiptHtml(ev) {
  const c = ev.filter((e) => e.kind === "catch" && e.status === "proven").sort((a, b) => (b.block ?? 0) - (a.block ?? 0))[0];
  if (!c) {
    return `<div class="card receipt"><div class="head"><h2>Last catch</h2><span class="badge wait">Waiting</span></div><p class="t2">No liquidation has filled a vault order on this deployment yet.</p></div>`;
  }
  const liq = c.txs?.find((t) => /liquidation/i.test(t.label));
  const cb = c.txs?.find((t) => /callback/i.test(t.label));
  return `<div class="card receipt">
    <div class="head"><h2>Last catch</h2><span class="badge ok">On chain</span></div>
    <div class="ticket">
      <div class="big">${c.size != null ? `${qty(Math.abs(c.size))} ${esc(c.base ?? "")}` : "Caught"}</div>
      <div class="t2">${c.side === "short" ? "short" : c.side === "long" ? "long" : "position"} force-closed into the vault's ${c.side === "short" ? "ask" : "bid"}</div>
      <span class="bracket">${c.price != null ? price(c.price) : ""}</span>
    </div>
    <div class="timeline">
      ${liq ? `<div class="row"><span class="mono idx">${liq.index != null ? `#${liq.index} in block` : "in block"}</span><span>The liquidation engine closes the position into the book</span>${txLink(liq.tx)}</div>` : ""}
      ${cb ? `<div class="row"><span class="mono idx">${cb.index != null ? `#${cb.index} in block` : "in block"}</span><span>Reactivity calls the vault, which records it and rests the unwind</span>${txLink(cb.tx)}</div>` : ""}
    </div>
    <p class="t3" style="font-size:12px">Same block, ${int(c.block)}. The liquidation was sent by someone else; the vault was simply there.</p>
  </div>`;
}

function proofsHtml(ev) {
  const order = ["catch", "auto-cancel", "fill", "refusal", "redeem"];
  const proven = ev.filter((e) => e.status === "proven");
  const rows = [];
  for (const k of order) {
    const list = proven.filter((e) => e.kind === k).sort((a, b) => (b.block ?? 0) - (a.block ?? 0));
    if (list.length) rows.push({ e: list[0], n: list.length });
  }
  if (!rows.length) return `<div class="empty">No proofs recorded yet.</div>`;
  return rows.map(({ e, n }) => `<div class="proof">
    <div class="h"><b>${esc(e.title)}</b><span class="badge ok">${n > 1 ? `${n} times` : "Once"}</span></div>
    <p>${esc(e.detail)}</p>
    ${(e.txs || []).map((t) => `<div class="tx"><span>${esc(t.label)}</span>${txLink(t.tx)}</div>`).join("")}
  </div>`).join("");
}

async function main() {
  const [status, vault, liq] = await Promise.all([get("/api/status"), get("/api/vault"), get("/api/liquidations").catch(() => null)]);
  explorer = status?.network?.explorer ?? null;
  const ev = vault?.deployment?.evidence || [];
  $("#receipt").innerHTML = receiptHtml(ev);
  $("#proofs").innerHTML = proofsHtml(ev);
  const st = liq?.stats;
  if (st) set("#fEmpty", pct(st.emptyBookShare), `${int(st.emptyBook)} of the last ${int(st.accounts)} account liquidations`);
  const v = vault?.state;
  if (v) {
    const orders = v.markets.reduce((n, m) => n + m.slots.filter((s) => !s.unwind).length, 0);
    set("#fAssets", usd(v.totalAssets, { compact: false, digits: 2 }), "test USDso, marked to market");
    set("#fOrders", int(orders), orders ? `across ${v.markets.filter((m) => m.slots.length).length} markets` : "placed when a cluster is in reach");
    $("#footVault").textContent = `Vault ${v.address}`;
  }
  if (status?.head) set("#fBlock", int(status.head), "read just now");

  const markets = await get("/api/markets");
  const top = markets[0];
  if (!top) return;
  $("#mapTitle").textContent = `${top.symbol.split("/")[0]}-PERP liquidations by price, right now`;
  const map = await get(`/api/map/${top.pool}`);
  liquidationMap($("#map"), map, { height: 320, compact: true, tip: $("#tip") });
}

main().catch((e) => {
  for (const id of ["#fEmptyFoot", "#fAssetsFoot", "#fOrdersFoot", "#fBlockFoot"]) $(id).textContent = "the engine did not answer";
  console.error(e);
});
