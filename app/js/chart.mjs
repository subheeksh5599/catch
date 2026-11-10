// Liquidation map and share-price line. Plain SVG, every value from the engine API.
// Colour carries meaning only: red = longs being liquidated, green = shorts being liquidated,
// grey = the resting book, amber = the vault's own catch windows.
// Every interpolated string is a number formatted by fmt.mjs or a fixed label, never user input.
import { usd, price } from "./fmt.mjs";

const NS = "http://www.w3.org/2000/svg";
const C = { long: "#e5484d", short: "#4cc38a", book: "#85858b", amber: "#e2a336", text: "#ededed", raised: "#232325" };

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

export function liquidationMap(el, data, { height = 360, compact = false, tip } = {}) {
  const W = Math.max(el.clientWidth || 800, 320);
  const H = height;
  const pad = { l: 56, r: compact ? 16 : 56, t: 28, b: 32 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const bins = data.bins;
  const n = bins.length;
  const bw = iw / n;
  const lo = bins[0].price - data.binWidth / 2;
  const span = data.binWidth * n;
  const px = (p) => pad.l + ((p - lo) / span) * iw;
  const maxBar = niceMax(Math.max(...bins.map((b) => Math.max(b.long, b.short, b.bidDepth, b.askDepth)), 1));

  // cumulative: longs accumulate from the mark downward, shorts from the mark upward
  const mi = bins.findIndex((b) => b.price >= data.markPrice);
  const cumL = new Array(n).fill(0), cumS = new Array(n).fill(0);
  for (let i = mi - 1, acc = 0; i >= 0; i--) { acc += bins[i].long; cumL[i] = acc; }
  for (let i = Math.max(mi, 0), acc = 0; i < n; i++) { acc += bins[i].short; cumS[i] = acc; }
  const maxCum = niceMax(Math.max(...cumL, ...cumS, 1));

  const x = (i) => pad.l + i * bw;
  const y = (v) => pad.t + ih - (v / maxBar) * ih;
  const yc = (v) => pad.t + ih - (v / maxCum) * ih;

  let s = `<svg viewBox="0 0 ${W} ${H}" xmlns="${NS}" role="img" aria-label="Liquidation map">`;
  s += `<g class="grid">`;
  for (let k = 0; k <= 4; k++) s += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${pad.t + (ih * k) / 4}" y2="${pad.t + (ih * k) / 4}" />`;
  s += `</g>`;

  // catch windows behind everything: a quiet amber band with bracket ends, a line at the order
  for (const c of data.clusters || []) {
    if (!c?.window) continue;
    const a = Math.max(pad.l, px(c.window.lo)), b = Math.min(W - pad.r, px(c.window.hi));
    if (b <= pad.l || a >= W - pad.r) continue;
    const w = Math.max(b - a, 2);
    s += `<rect x="${a}" y="${pad.t}" width="${w}" height="${ih}" fill="${C.amber}" fill-opacity=".07"/>`;
    s += `<path d="M${a + 4},${pad.t - 10} H${a} V${pad.t - 2} M${a + w - 4},${pad.t - 10} H${a + w} V${pad.t - 2}" fill="none" stroke="${C.amber}" stroke-width="1.25"/>`;
    s += `<line x1="${px(c.price)}" x2="${px(c.price)}" y1="${pad.t}" y2="${pad.t + ih}" stroke="${C.amber}" stroke-width="1"/>`;
  }

  // cumulative curves, quiet, on the full map only
  const pathOf = (arr, from, to) => {
    let d = `M${x(from) + bw / 2},${yc(arr[from])}`;
    for (let i = from + 1; i <= to; i++) d += ` L${x(i) + bw / 2},${yc(arr[i])}`;
    return d;
  };
  if (!compact) {
    if (mi > 0) s += `<path d="${pathOf(cumL, 0, mi - 1)}" fill="none" stroke="${C.long}" stroke-opacity=".45" stroke-width="1"/>`;
    if (mi > -1 && mi < n) s += `<path d="${pathOf(cumS, mi, n - 1)}" fill="none" stroke="${C.short}" stroke-opacity=".45" stroke-width="1"/>`;
  }
  // bars
  const gap = Math.min(2, bw * 0.25);
  bins.forEach((b, i) => {
    const bx = x(i) + gap / 2, w = Math.max(bw - gap, 1);
    if (b.long > 0) s += `<rect x="${bx}" y="${y(b.long)}" width="${w}" height="${pad.t + ih - y(b.long)}" rx="1" fill="${C.long}" fill-opacity=".85"/>`;
    if (b.short > 0) s += `<rect x="${bx}" y="${y(b.short)}" width="${w}" height="${pad.t + ih - y(b.short)}" rx="1" fill="${C.short}" fill-opacity=".85"/>`;
  });
  // the resting book in the same bins: bids below the mark, asks above, one neutral step line
  let d = "";
  bins.forEach((b, i) => {
    const v = b.price < data.markPrice ? b.bidDepth : b.askDepth;
    d += `${d ? " L" : "M"}${x(i)},${y(v)} L${x(i + 1)},${y(v)}`;
  });
  s += `<path d="${d}" fill="none" stroke="${C.book}" stroke-width="1.25" stroke-dasharray="3 3"/>`;

  // mark
  const mx = px(data.markPrice);
  s += `<line x1="${mx}" x2="${mx}" y1="${pad.t}" y2="${pad.t + ih}" stroke="${C.text}" stroke-opacity=".7" stroke-width="1"/>`;
  s += `<rect x="${mx - 40}" y="${pad.t + ih + 4}" width="80" height="20" rx="4" fill="${C.raised}"/><text x="${mx}" y="${pad.t + ih + 18}" text-anchor="middle" font-size="11" fill="${C.text}" font-family="Geist Mono, monospace">${price(data.markPrice)}</text>`;
  // axes
  s += `<g class="axis">`;
  for (let k = 0; k <= 4; k++) {
    const v = (maxBar * (4 - k)) / 4, vc = (maxCum * (4 - k)) / 4, yy = pad.t + (ih * k) / 4 + 4;
    s += `<text x="${pad.l - 8}" y="${yy}" text-anchor="end">${usd(v)}</text>`;
    if (!compact) s += `<text x="${W - pad.r + 8}" y="${yy}">${usd(vc)}</text>`;
  }
  const ticks = compact ? 4 : 6;
  for (let k = 0; k <= ticks; k++) {
    const i = Math.round(((n - 1) * k) / ticks);
    const tx = x(i) + bw / 2;
    if (Math.abs(tx - mx) < 56) continue;
    s += `<text x="${tx}" y="${H - 6}" text-anchor="middle">${price(bins[i].price, data.markPrice)}</text>`;
  }
  s += `</g>`;
  s += `<rect class="hit" x="${pad.l}" y="${pad.t}" width="${iw}" height="${ih}" fill="transparent"/>`;
  s += `<line class="cross" x1="0" x2="0" y1="${pad.t}" y2="${pad.t + ih}" stroke="${C.text}" stroke-opacity=".25" visibility="hidden"/>`;
  s += `</svg>`;
  el.innerHTML = s;

  if (!tip) return;
  const svg = el.querySelector("svg");
  const hit = svg.querySelector(".hit");
  const cross = svg.querySelector(".cross");
  const move = (ev) => {
    const r = svg.getBoundingClientRect();
    const sx = ((ev.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.floor((sx - pad.l) / bw)));
    const b = bins[i];
    cross.setAttribute("x1", x(i) + bw / 2);
    cross.setAttribute("x2", x(i) + bw / 2);
    cross.setAttribute("visibility", "visible");
    const below = b.price < data.markPrice;
    const dist = (b.price - data.markPrice) / data.markPrice;
    tip.hidden = false;
    tip.innerHTML = `<div class="t">${price(b.price - data.binWidth / 2, data.markPrice)} to ${price(b.price + data.binWidth / 2, data.markPrice)}</div>
      <div class="row"><span class="t3">From mark</span><span>${(dist * 100).toFixed(2)}%</span></div>
      ${below ? `<div class="row"><span class="down">Longs liquidated here</span><span>${usd(b.long)} · ${b.longAccounts}</span></div>
      <div class="row"><span class="t3">Down to here</span><span>${usd(cumL[i])}</span></div>
      <div class="row"><span class="t3">Bids resting</span><span>${usd(b.bidDepth)}</span></div>`
      : `<div class="row"><span class="up">Shorts liquidated here</span><span>${usd(b.short)} · ${b.shortAccounts}</span></div>
      <div class="row"><span class="t3">Up to here</span><span>${usd(cumS[i])}</span></div>
      <div class="row"><span class="t3">Asks resting</span><span>${usd(b.askDepth)}</span></div>`}`;
    const tx = Math.min(ev.clientX + 16, window.innerWidth - tip.offsetWidth - 12);
    tip.style.left = `${tx}px`;
    tip.style.top = `${ev.clientY + 16}px`;
  };
  hit.addEventListener("mousemove", move);
  hit.addEventListener("mouseleave", () => { tip.hidden = true; cross.setAttribute("visibility", "hidden"); });
}

/** Share price (per 1,000 shares) over time: one neutral line, the latest read marked in amber. */
export function priceLine(el, points, { height = 200 } = {}) {
  if (points.length < 2) {
    el.innerHTML = `<div class="loading" style="min-height:${height}px">The line starts after the keeper's second read of this vault. Each point is a real read, never a back-fill.</div>`;
    return;
  }
  const W = Math.max(el.clientWidth || 600, 320), H = height;
  const pad = { l: 56, r: 16, t: 12, b: 28 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const t0 = points[0].t, t1 = points.at(-1).t;
  const vs = points.map((p) => p.v);
  let lo = Math.min(...vs), hi = Math.max(...vs);
  if (hi - lo < 1e-9) { lo -= 0.01; hi += 0.01; }
  const padV = (hi - lo) * 0.15; lo -= padV; hi += padV;
  const x = (t) => pad.l + ((t - t0) / Math.max(t1 - t0, 1)) * iw;
  const y = (v) => pad.t + ih - ((v - lo) / (hi - lo)) * ih;
  let s = `<svg viewBox="0 0 ${W} ${H}" xmlns="${NS}" role="img" aria-label="Share price over time"><g class="grid">`;
  for (let k = 0; k <= 3; k++) s += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${pad.t + (ih * k) / 3}" y2="${pad.t + (ih * k) / 3}"/>`;
  s += `</g><path d="${points.map((p, i) => `${i ? "L" : "M"}${x(p.t)},${y(p.v)}`).join(" ")}" fill="none" stroke="${C.text}" stroke-opacity=".8" stroke-width="1.5" stroke-linejoin="round"/>`;
  const last = points.at(-1);
  s += `<circle cx="${x(last.t)}" cy="${y(last.v)}" r="3.5" fill="${C.amber}"/>`;
  s += `<g class="axis">`;
  for (let k = 0; k <= 3; k++) { const v = hi - ((hi - lo) * k) / 3; s += `<text x="${pad.l - 8}" y="${pad.t + (ih * k) / 3 + 4}" text-anchor="end">${v.toFixed(3)}</text>`; }
  const fmtT = (t) => new Date(t).toLocaleString("en-US", t1 - t0 < 2 * 864e5 ? { hour: "numeric", minute: "2-digit" } : { month: "short", day: "numeric" });
  for (const [t, anchor] of [[t0, "start"], [(t0 + t1) / 2, "middle"], [t1, "end"]]) s += `<text x="${x(t)}" y="${H - 6}" text-anchor="${anchor}">${fmtT(t)}</text>`;
  s += `</g></svg>`;
  el.innerHTML = s;
}

/** Small inline bars for table rows: liquidation notional per side across the window. */
export function spark(bins, mark) {
  const n = bins.length, w = 120, h = 24, bw = w / n;
  const max = Math.max(...bins.map((b) => Math.max(b.long, b.short)), 1);
  let s = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">`;
  bins.forEach((b, i) => {
    const v = b.price < mark ? b.long : b.short;
    if (!v) return;
    const bh = Math.max(1, (v / max) * h);
    s += `<rect x="${i * bw}" y="${h - bh}" width="${Math.max(bw - 0.4, 0.6)}" height="${bh}" fill="${b.price < mark ? C.long : C.short}" fill-opacity=".8"/>`;
  });
  return s + `</svg>`;
}
