// The engine's live state: markets, per-market liquidation snapshots, the venue's liquidation
// history, and (once deployed) the vault. Everything here is read from the chain or the venue's
// indexer; nothing is invented. Values leave this module as plain JSON numbers/strings.
import { readFileSync, existsSync } from "node:fs";
import { parseEventLogs } from "viem";
import { SomniaMarkets } from "@somnia-chain/markets-sdk";
import { NETWORKS, publicClient, vaultAbi, erc20Abi, bankAbi } from "./chain.mjs";
import { snapshotPool } from "./reader.mjs";
import { binMap, atRisk, bestCluster, sizeOrder, catchWindow, depthBetween, BPS } from "./math.mjs";

const E18 = 1e18;
const num = (x, scale = E18) => (x == null ? null : Number(x) / scale);
const abs = (x) => (x < 0n ? -x : x);
const STAGES = ["OrderCancellation", "CLOBPartial", "BidderTakeover", "InsuranceFund", "ADL", "Deferred"];

export function loadDeployment(netKey) {
  const p = new URL(`../../deployments/${netKey}.json`, import.meta.url);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

export class CatchService {
  constructor(netKey = "hideki", log = console.log) {
    this.net = NETWORKS[netKey];
    if (!this.net) throw new Error(`unknown network ${netKey}`);
    this.log = log;
    this.client = publicClient(this.net);
    this.ex = new SomniaMarkets({ chain: this.net.chain, addresses: this.net.addresses, indexerUrl: this.net.indexerUrl });
    this.deployment = loadDeployment(netKey);
    this.markets = new Map(); // pool(lowercase) -> market row
    this.maps = new Map(); // pool -> derived snapshot
    this.raw = new Map(); // pool -> raw positions (bigint) for the keeper
    this.liquidations = { rows: [], stats: null, updatedAt: null };
    this.vault = null;
    this.engine = null;
    this.head = null;
    this.errors = [];
    this.cursor = 0;
  }

  note(where, e) {
    const msg = `${where}: ${(e?.shortMessage || e?.message || String(e)).slice(0, 240)}`;
    this.errors.unshift({ at: Date.now(), msg });
    this.errors.length = Math.min(this.errors.length, 20);
    this.log(msg);
  }

  async init() {
    const cfg = await this.ex.client.getPerpSystemConfig(this.net.addresses.marginBank);
    const eng = await this.ex.client.getLiquidationEngineConfig(cfg.liquidationEngine);
    this.system = cfg;
    this.engine = {
      address: eng.address,
      penaltyBps: Number(eng.penaltyBps),
      minSpreadBps: Number(eng.minSpreadBps),
      maxSpreadBps: Number(eng.maxSpreadBps),
      bidderCount: Number(eng.bidderCount),
      maxVolumePerBlock: num(eng.maxVolumePerBlock),
    };
    await this.refreshMarkets();
  }

  async refreshMarkets() {
    const all = await this.ex.loadMarkets(true);
    // the SDK can report registration as unknown (null); settle it with one read per pool
    const perps = Object.values(all).filter((m) => m.type === "swap" && m.perpStatus?.restricted === false);
    const reg = await this.client.multicall({
      contracts: perps.map((m) => ({ address: this.net.addresses.marginBank, abi: bankAbi, functionName: "isPerpPoolRegistered", args: [m.info.poolAddress] })),
      allowFailure: true,
    });
    for (const [k, m] of perps.entries()) {
      if (!(reg[k].status === "success" && reg[k].result === true)) continue;
      const i = m.info;
      const pool = i.poolAddress.toLowerCase();
      const prev = this.markets.get(pool);
      this.markets.set(pool, {
        pool: i.poolAddress,
        symbol: m.symbol,
        base: m.base,
        quote: m.quote,
        markPrice: num(i.markPrice),
        indexPrice: num(i.indexPrice),
        lastPrice: num(i.lastPrice),
        fundingRate: num(i.fundingRate),
        openInterest: num(i.openInterest, 10 ** (i.baseDecimals ?? 18)),
        volumeQuote: num(i.cumulativeQuoteVolume),
        trades: Number(i.tradeCount ?? 0),
        initialMarginBps: i.initialMarginBps,
        baseDecimals: i.baseDecimals ?? 18,
        pricePrecision: m.precision?.price ?? 2,
        snapshotAt: prev?.snapshotAt ?? null,
      });
    }
  }

  /** Pools ordered by open interest notional, busiest first. */
  order() {
    return [...this.markets.values()].sort((a, b) => b.openInterest * b.markPrice - a.openInterest * a.markPrice);
  }

  async snapshotNext() {
    const list = this.order();
    if (!list.length) return;
    const m = list[this.cursor++ % list.length];
    await this.snapshot(m.pool);
  }

  async snapshot(pool) {
    const m = this.markets.get(pool.toLowerCase());
    const t0 = Date.now();
    const s = await snapshotPool(this.client, { bank: this.net.addresses.marginBank, pool });
    let book = { bids: [], asks: [] };
    try {
      book = await this.ex.fetchOrderBook(m.symbol, 200);
    } catch (e) {
      this.note(`book ${m.symbol}`, e);
    }
    this.raw.set(pool.toLowerCase(), s);
    this.maps.set(pool.toLowerCase(), this.derive(m, s, book, Date.now() - t0));
    m.snapshotAt = Date.now();
    this.head = s.blockNumber;
  }

  derive(m, s, book, ms) {
    const spreadBps = BigInt(this.engine.maxSpreadBps);
    const map = binMap(s.positions, { markPrice: s.markPrice, oneBase: s.oneBase, binBps: 25n, rangeBps: 1500n });
    const bidRows = book.bids || [];
    const askRows = book.asks || [];
    const bins = map.bins.map((b) => {
      const lo = num(b.price - map.width / 2n), hi = num(b.price + map.width / 2n);
      return {
        price: num(b.price),
        long: num(b.long),
        short: num(b.short),
        longAccounts: b.longAccounts,
        shortAccounts: b.shortAccounts,
        bidDepth: depthBetween(bidRows, lo, hi),
        askDepth: depthBetween(askRows, lo, hi),
      };
    });
    const risk = Object.fromEntries(
      [100n, 300n, 500n, 1000n].map((bps) => {
        const r = atRisk(s.positions, s, bps);
        return [`${Number(bps) / 100}%`, { long: num(r.long), short: num(r.short), accounts: r.accounts }];
      }),
    );
    const vaultCap = this.vault ? this.vault.totalAssets * this.vault.clusterCapBps / 10_000 : null;
    const clusters = [true, false].map((isBid) => {
      const c = bestCluster(s.positions, { markPrice: s.markPrice, tickSize: s.tickSize, isBid, spreadBps });
      if (!c) return null;
      const notional = (c.size * c.price) / s.oneBase;
      // what the book already holds inside the window where these positions would be closed
      const backerWindows = c.backers.map((a) => {
        const p = s.positions.find((x) => x.account === a);
        return catchWindow({ ...p, spreadBps });
      });
      const lo = num(backerWindows.reduce((x, w) => (w.lo > x ? w.lo : x), 0n));
      const hi = num(backerWindows.reduce((x, w) => (w.hi < x ? w.hi : x), backerWindows[0].hi));
      const resting = depthBetween(isBid ? bidRows : askRows, lo, hi);
      let orderQty = null;
      if (vaultCap != null) {
        const q = sizeOrder({ size: c.size, price: c.price, oneBase: s.oneBase, lotSize: s.lotSize, minQuantity: s.minQuantity, capNotional: BigInt(Math.floor(vaultCap * 1e6)) * 10n ** 12n });
        orderQty = num(q, Number(s.oneBase));
      }
      return {
        side: isBid ? "bid" : "ask",
        price: num(c.price),
        size: num(c.size, Number(s.oneBase)),
        notional: num(notional),
        backers: c.backers,
        accountsInWindow: c.accountsInBand,
        window: { lo, hi },
        restingInWindow: resting,
        coverage: resting / Math.max(num(notional), 1e-9),
        vaultOrderQty: orderQty,
      };
    });
    // the accounts closest to liquidation, either side
    const near = s.positions
      .filter((p) => p.liq != null)
      .map((p) => ({ p, d: Math.abs(num(p.liq) - num(s.markPrice)) / num(s.markPrice) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 25)
      .map(({ p, d }) => ({
        account: p.account,
        side: p.size > 0n ? "long" : "short",
        size: num(abs(p.size), Number(s.oneBase)),
        entry: num(p.entry),
        liq: num(p.liq),
        bankruptcy: num(p.bankruptcy),
        distance: d,
        notional: num((abs(p.size) * p.liq) / s.oneBase),
      }));
    return {
      pool: m.pool,
      symbol: m.symbol,
      base: m.base,
      block: Number(s.blockNumber),
      tookMs: ms,
      at: Date.now(),
      markPrice: num(s.markPrice),
      maintenanceMarginBps: Number(s.maintenanceMarginBps),
      tickSize: num(s.tickSize),
      holders: s.holders,
      positions: s.positions.length,
      unpriced: s.unpriced,
      outsideRange: map.outside,
      alreadyLiquidatable: map.alreadyLiquidatable,
      binWidth: num(map.width),
      bins,
      risk,
      clusters,
      near,
      book: { bids: bidRows.length, asks: askRows.length, bestBid: bidRows[0]?.[0] ?? null, bestAsk: askRows[0]?.[0] ?? null },
    };
  }

  async refreshLiquidations() {
    const c = this.ex.client;
    const [accounts, positions] = await Promise.all([
      c.listLiquidations({ kind: "AccountLiquidated", limit: 1000 }),
      c.listLiquidations({ kinds: ["PositionLiquidated", "AutoDeleveraged", "BadDebtAbsorbed", "ResidualBadDebt"], limit: 300 }),
    ]);
    const byStage = {};
    let emptyBook = 0, pastBook = 0;
    for (const r of accounts) {
      const st = STAGES[r.stageReached] ?? String(r.stageReached);
      byStage[st] = (byStage[st] || 0) + 1;
      if (r.stageReached === 1 && Number(r.positionsProcessed) === 0) emptyBook++;
      if (r.stageReached >= 2 && r.stageReached <= 4) pastBook++;
    }
    const first = accounts[accounts.length - 1], last = accounts[0];
    this.liquidations = {
      updatedAt: Date.now(),
      stats: {
        accounts: accounts.length,
        byStage,
        emptyBook,
        pastBook,
        emptyBookShare: accounts.length ? emptyBook / accounts.length : 0,
        pastBookShare: accounts.length ? pastBook / accounts.length : 0,
        from: first ? Number(first.timestamp) * 1000 : null,
        to: last ? Number(last.timestamp) * 1000 : null,
      },
      rows: positions.map((r) => {
        const m = r.pool ? this.markets.get(r.pool.toLowerCase()) : null;
        return {
          id: r.id,
          kind: r.kind,
          account: r.account,
          pool: r.pool,
          symbol: m?.symbol ?? null,
          size: r.size != null ? Number(r.size) / 10 ** (m?.baseDecimals ?? 18) : null,
          price: num(r.price),
          counterparty: r.counterparty,
          badDebt: num(r.badDebt),
          insuranceCovered: num(r.insuranceCovered),
          txHash: r.txHash,
          block: Number(r.blockNumber),
          at: Number(r.timestamp) * 1000,
        };
      }),
      recentAccounts: accounts.slice(0, 50).map((r) => ({
        account: r.account,
        stage: STAGES[r.stageReached] ?? String(r.stageReached),
        positionsProcessed: Number(r.positionsProcessed ?? 0),
        txHash: r.txHash,
        at: Number(r.timestamp) * 1000,
      })),
    };
  }

  async refreshVault() {
    const d = this.deployment;
    if (!d?.vault) return;
    const v = d.vault;
    const rd = (functionName, args = []) => this.client.readContract({ address: v, abi: vaultAbi, functionName, args });
    const [totalAssets, totalSupply, pools, marketCap, clusterCap, spread, asset] = await Promise.all([
      rd("totalAssets"), rd("totalSupply"), rd("pools"), rd("MARKET_CAP_BPS"), rd("CLUSTER_CAP_BPS"), rd("UNWIND_SPREAD_BPS"), rd("ASSET"),
    ]);
    const state = await this.client.readContract({ address: this.net.addresses.marginBank, abi: bankAbi, functionName: "getAccountState", args: [v] });
    const markets = [];
    for (const pool of pools) {
      const [ids, exposure, pos] = await Promise.all([
        rd("liveSlots", [pool]),
        rd("exposure", [pool]),
        this.client.readContract({ address: this.net.addresses.marginBank, abi: bankAbi, functionName: "getPosition", args: [v, pool] }),
      ]);
      const slots = [];
      for (const id of ids) {
        const s = await rd("getSlot", [id]);
        slots.push({ id: Number(id), side: s.isBid ? "bid" : "ask", unwind: s.unwind, price: num(s.price), quantity: num(s.quantity), notional: num((s.price * s.quantity) / 10n ** 18n), orderId: s.orderId.toString(), backers: s.backers });
      }
      const m = this.markets.get(pool.toLowerCase());
      markets.push({ pool, symbol: m?.symbol ?? pool, exposure: num(exposure), position: { size: Number(pos.size), entry: num(pos.avgEntryPrice) }, slots });
    }
    this.vault = {
      address: v,
      deployBlock: d.deployBlock,
      deployTx: d.deployTx,
      asset,
      totalAssets: num(totalAssets),
      totalSupply: num(totalSupply),
      // the contract offsets shares by 1e3 (virtual shares); quote assets per 1,000 shares
      sharePrice: totalSupply > 0n ? (Number(totalAssets) * 1000) / Number(totalSupply) : 1,
      marketCapBps: Number(marketCap),
      clusterCapBps: Number(clusterCap),
      unwindSpreadBps: Number(spread),
      locked: num(state.lockedCollateral),
      free: num(state.unlockedCollateralBalance),
      markets,
      updatedAt: Date.now(),
    };
    await this.refreshVaultEvents();
  }

  async refreshVaultEvents() {
    const v = this.deployment.vault;
    const head = await this.client.getBlockNumber();
    const seen = this.vaultEventKeys ?? new Set();
    const rows = this.vaultEvents ?? [];
    const add = (logs) => {
      for (const l of logs) {
        const key = `${l.transactionHash}:${l.logIndex}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const args = Object.fromEntries(Object.entries(l.args).map(([k, x]) => [k, typeof x === "bigint" ? x.toString() : x]));
        rows.push({ event: l.eventName, args, block: Number(l.blockNumber), tx: l.transactionHash });
      }
    };
    // 1. every transaction the operator recorded: one receipt each, no range scan
    if (!this.vaultSeeded) {
      const hashes = [...new Set((this.deployment.txs || []).map((t) => t.tx).filter(Boolean))];
      const receipts = await Promise.all(hashes.map((hash) => this.client.getTransactionReceipt({ hash }).catch(() => null)));
      for (const r of receipts) {
        if (!r) continue;
        const mine = r.logs.filter((l) => l.address.toLowerCase() === v.toLowerCase());
        add(parseEventLogs({ abi: vaultAbi, logs: mine }));
      }
      this.vaultSeeded = true;
    }
    // 2. everything else (reactivity callbacks, third-party calls) in the recent window.
    //    Hideki serves eth_getLogs over at most 1,000 blocks per request.
    const STEP = 1000n;
    const WINDOW = BigInt(process.env.EVENT_WINDOW || 30_000);
    const floor = BigInt(this.deployment.deployBlock ?? 0);
    let from = BigInt(this.eventsFrom ?? (head > WINDOW ? head - WINDOW : 0n));
    if (from < floor) from = floor;
    const spans = [];
    for (let a = from; a <= head; a += STEP) spans.push([a, a + STEP - 1n > head ? head : a + STEP - 1n]);
    for (let i = 0; i < spans.length; i += 8) {
      const batch = await Promise.all(spans.slice(i, i + 8).map(([fromBlock, toBlock]) =>
        this.client.getContractEvents({ address: v, abi: vaultAbi, fromBlock, toBlock })));
      add(batch.flat());
    }
    this.eventsFrom = Number(head) + 1;
    this.vaultEventKeys = seen;
    rows.sort((x, y) => y.block - x.block);
    this.vaultEvents = rows.slice(0, 500);
  }

  status() {
    return {
      network: { key: this.net.key, label: this.net.label, chainId: this.net.chain.id, explorer: this.net.explorer, rpc: this.net.rpc },
      head: this.head != null ? Number(this.head) : null,
      system: this.system ? { marginBank: this.system.marginBank, liquidationEngine: this.system.liquidationEngine, insuranceFund: this.system.insuranceFund, collateral: this.system.collateralToken } : null,
      engine: this.engine,
      markets: this.markets.size,
      mapped: this.maps.size,
      vault: this.vault ? { address: this.vault.address, totalAssets: this.vault.totalAssets, sharePrice: this.vault.sharePrice } : null,
      liquidationsUpdatedAt: this.liquidations.updatedAt,
      errors: this.errors.slice(0, 5),
    };
  }

  marketsSummary() {
    return this.order().map((m) => {
      const s = this.maps.get(m.pool.toLowerCase());
      return {
        ...m,
        mapped: !!s,
        block: s?.block ?? null,
        positions: s?.positions ?? null,
        risk: s?.risk ?? null,
        clusters: s?.clusters ?? null,
      };
    });
  }
}
