// Liquidation map: liquidation notional by trigger price, the resting book in the same price
// bins, cumulative curves either side of the mark, and the vault's clusters. Plain SVG.
import { usd, price } from "./fmt.mjs";

const NS = "http://www.w3.org/2000/svg";

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

export function liquidationMap(el, data, { height = 380, compact = false, tip } = {}) {
  const W = Math.max(el.clientWidth || 800, 320);
  const H = height;
  const pad = { l: 58, r: 58, t: 18, b: 34 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const bins = data.bins;
  const n = bins.length;
  const bw = iw / n;
  const maxBar = niceMax(Math.max(...bins.map((b) => Math.max(b.long, b.short, b.bidDepth, b.askDepth)), 1));

  // cumulative: longs accumulate from the mark downward, shorts from the mark upward
  const mi = bins.findIndex((b) => b.price >= data.markPrice);
  const cumL = new Array(n).fill(0), cumS = new Array(n).fill(0);
  for (let i = mi - 1, acc = 0; i >= 0; i--) { acc += bins[i].long; cumL[i] = acc; }
  for (let i = mi, acc = 0; i < n; i++) { acc += bins[i].short; cumS[i] = acc; }
  const maxCum = niceMax(Math.max(...cumL, ...cumS, 1));

  const x = (i) => pad.l + i * bw;
  const y = (v) => pad.t + ih - (v / maxBar) * ih;
  const yc = (v) => pad.t + ih - (v / maxCum) * ih;

  let s = `<svg viewBox="0 0 ${W} ${H}" xmlns="${NS}" role="img" aria-label="Liquidation map for ${data.symbol}">`;
  s += `<defs><linearGradient id="gl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff5c4d" stop-opacity=".22"/><stop offset="1" stop-color="#ff5c4d" stop-opacity="0"/></linearGradient>`;
  s += `<linearGradient id="gs" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#22c55e" stop-opacity=".22"/><stop offset="1" stop-color="#22c55e" stop-opacity="0"/></linearGradient></defs>`;
  // grid
  s += `<g class="grid">`;
  for (let k = 0; k <= 4; k++) s += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${pad.t + (ih * k) / 4}" y2="${pad.t + (ih * k) / 4}" />`;
  s += `</g>`;
  // cumulative areas
  const pathOf = (arr, from, to) => {
    let d = `M${x(from) + bw / 2},${yc(0)}`;
    for (let i = from; i <= to; i++) d += ` L${x(i) + bw / 2},${yc(arr[i])}`;
    return d + ` L${x(to) + bw / 2},${yc(0)} Z`;
  };
  if (mi > 0) s += `<path d="${pathOf(cumL, 0, mi - 1)}" fill="url(#gl)" stroke="#ff5c4d" stroke-opacity=".55" stroke-width="1.25"/>`;
  if (mi < n) s += `<path d="${pathOf(cumS, mi, n - 1)}" fill="url(#gs)" stroke="#22c55e" stroke-opacity=".55" stroke-width="1.25"/>`;
  // bars
  const gap = Math.min(2, bw * 0.2);
  bins.forEach((b, i) => {
    const bx = x(i) + gap / 2, w = Math.max(bw - gap, 1);
    if (b.long > 0) s += `<rect x="${bx}" y="${y(b.long)}" width="${w}" height="${pad.t + ih - y(b.long)}" rx="1.5" fill="#ff5c4d"/>`;
    if (b.short > 0) s += `<rect x="${bx}" y="${y(b.short)}" width="${w}" height="${pad.t + ih - y(b.short)}" rx="1.5" fill="#22c55e"/>`;
  });
  // resting book in the same bins, as a step line
  const depthLine = (key, color) => {
    let d = "";
    bins.forEach((b, i) => {
      const v = b[key];
      d += `${d ? " L" : "M"}${x(i)},${y(v)} L${x(i + 1)},${y(v)}`;
    });
    return `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.5" stroke-dasharray="3 3"/>`;
  };
  s += depthLine("bidDepth", "#7fa9ff");
  s += depthLine("askDepth", "#c3b3ff");
  // clusters
  for (const c of data.clusters || []) {
    if (!c) continue;
    const i = bins.findIndex((b) => b.price - data.binWidth / 2 <= c.price && c.price < b.price + data.binWidth / 2);
    if (i < 0) continue; // off the chart
    const cx = x(i) + bw / 2;
    s += `<line x1="${cx}" x2="${cx}" y1="${pad.t}" y2="${pad.t + ih}" stroke="#1c6cff" stroke-width="1" stroke-dasharray="2 4"/>`;
    s += `<circle cx="${cx}" cy="${pad.t + 6}" r="4" fill="#1c6cff"/>`;
  }
  // mark line
  const mx = pad.l + ((data.markPrice - (bins[0].price - data.binWidth / 2)) / (data.binWidth * n)) * iw;
  s += `<line x1="${mx}" x2="${mx}" y1="${pad.t - 6}" y2="${pad.t + ih}" stroke="#fff" stroke-width="1.25"/>`;
  s += `<rect x="${mx - 44}" y="${pad.t + ih + 6}" width="88" height="20" rx="6" fill="#fff"/><text x="${mx}" y="${pad.t + ih + 20}" text-anchor="middle" font-size="11" fill="#000814" font-weight="670">${price(data.markPrice)}</text>`;
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
    if (Math.abs(tx - mx) < 48) continue;
    s += `<text x="${tx}" y="${H - 8}" text-anchor="middle">${price(bins[i].price, data.markPrice)}</text>`;
  }
  s += `</g>`;
  s += `<rect class="hit" x="${pad.l}" y="${pad.t}" width="${iw}" height="${ih}" fill="transparent"/>`;
  s += `<line class="cross" x1="0" x2="0" y1="${pad.t}" y2="${pad.t + ih}" stroke="#ccced0" stroke-opacity=".35" visibility="hidden"/>`;
  s += `</svg>`;
  el.innerHTML = s;

  if (!tip) return;
  const svg = el.querySelector("svg");
  const hit = svg.querySelector(".hit");
  const cross = svg.querySelector(".cross");
  const move = (ev) => {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.floor((px - pad.l) / bw)));
    const b = bins[i];
    cross.setAttribute("x1", x(i) + bw / 2);
    cross.setAttribute("x2", x(i) + bw / 2);
    cross.setAttribute("visibility", "visible");
    const below = b.price < data.markPrice;
    const dist = (b.price - data.markPrice) / data.markPrice;
    tip.hidden = false;
    tip.innerHTML = `<div class="t">${price(b.price - data.binWidth / 2, data.markPrice)} – ${price(b.price + data.binWidth / 2, data.markPrice)}</div>
      <div class="row"><span class="muted">From mark</span><span>${(dist * 100).toFixed(2)}%</span></div>
      ${below ? `<div class="row"><span class="down">Long liquidations</span><span>${usd(b.long)} · ${b.longAccounts}</span></div>
      <div class="row"><span class="muted">Cumulative to here</span><span>${usd(cumL[i])}</span></div>
      <div class="row"><span style="color:#7fa9ff">Bids resting</span><span>${usd(b.bidDepth)}</span></div>`
      : `<div class="row"><span class="up">Short liquidations</span><span>${usd(b.short)} · ${b.shortAccounts}</span></div>
      <div class="row"><span class="muted">Cumulative to here</span><span>${usd(cumS[i])}</span></div>
      <div class="row"><span style="color:#c3b3ff">Asks resting</span><span>${usd(b.askDepth)}</span></div>`}`;
    const tx = Math.min(ev.clientX + 16, window.innerWidth - tip.offsetWidth - 12);
    tip.style.left = `${tx}px`;
    tip.style.top = `${ev.clientY + 16}px`;
  };
  hit.addEventListener("mousemove", move);
  hit.addEventListener("mouseleave", () => { tip.hidden = true; cross.setAttribute("visibility", "hidden"); });
}

/** Small inline bar chart: liquidation notional per side across a window, for table rows. */
export function spark(bins, mark) {
  const n = bins.length, w = 120, h = 28, bw = w / n;
  const max = Math.max(...bins.map((b) => Math.max(b.long, b.short)), 1);
  let s = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">`;
  bins.forEach((b, i) => {
    const v = b.price < mark ? b.long : b.short;
    if (!v) return;
    const bh = Math.max(1, (v / max) * h);
    s += `<rect x="${i * bw}" y="${h - bh}" width="${Math.max(bw - 0.4, 0.6)}" height="${bh}" fill="${b.price < mark ? "#ff5c4d" : "#22c55e"}"/>`;
  });
  return s + `</svg>`;
}
