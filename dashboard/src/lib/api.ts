// Every number on the dashboard comes from the engine API (/api/*), which reads Somnia and the
// venue's indexer. Nothing here is sample data: a value not read yet is shown as being read.
import { create } from "zustand"
import { Wallet } from "./wallet"

export type Network = { key: string; label: string; chainId: number; explorer: string | null; rpc: string }
export type Status = {
  network: Network
  head: number | null
  system: { marginBank: string; liquidationEngine: string; insuranceFund: string; collateral: string } | null
  engine: { address: string; penaltyBps: number; minSpreadBps: number; maxSpreadBps: number; bidderCount: number } | null
  markets: number
  mapped: number
  errors: { at: number; msg: string }[]
}

export type Bin = { price: number; long: number; short: number; bidDepth: number; askDepth: number; longAccounts: number; shortAccounts: number }
export type Cluster = {
  side: "bid" | "ask"
  price: number
  window: { lo: number; hi: number }
  size: number
  notional: number
  accountsInWindow: number
  restingInWindow: number
  coverage: number
  vaultOrderQty: number | null
}
export type Risk = Record<"1%" | "3%" | "5%" | "10%", { long: number; short: number; accounts: number }>
export type MapData = {
  pool: string
  symbol: string
  base: string
  block: number
  at: number
  markPrice: number
  binWidth: number
  bins: Bin[]
  clusters: (Cluster | null)[]
  risk: Risk
  positions: number
  holders: { long: number; short: number }
  pricedShare: number | null
  maintenanceMarginBps: number
  outsideRange: number
  near: { account: string; side: "long" | "short"; size: number; entry: number; liq: number; distance: number; notional: number }[]
}

export type Market = {
  pool: string
  symbol: string
  base: string
  markPrice: number
  indexPrice: number
  fundingRate: number | null
  openInterest: number
  volumeQuote: number
  mapped: boolean
  positions: number | null
  risk: Risk | null
  clusters: (Cluster | null)[] | null
  agent?: { pair: string; mark: number; updatedAtMs: number; ageMs: number; validators: number; gapBps: number | null } | null
}

export type Slot = { id: number; side: "bid" | "ask"; unwind: boolean; price: number; quantity?: number; notional: number | null; backers: string[] }
export type VaultMarket = {
  pool: string
  symbol: string
  exposure: number
  oiCap: number | null
  price: { status: number; mark?: number; index?: number } | null
  position: { size: number; entry: number }
  slots: Slot[]
}
export type Trade = { block: number; tx: string; kind: "liquidation" | "taker"; pool: string; base: string | null; newSize: number; avgEntry: number; realizedPnl: number }
export type Retired = {
  tag: string
  vault: string
  deployBlock: number
  deployTx: string
  retired: { reason?: string } | null
  performance: { deposited: number; redeemed: number; stillInside: number } | null
  trades: Trade[]
}
export type VaultState = {
  address: string
  asset: string
  totalAssets: number
  totalSupply: number
  sharePrice: number
  marketCapBps: number
  clusterCapBps: number
  oiCapBps: number | null
  backstop?: { engine: string; registered: boolean | null; bidders: string[] | null; spreadBps: number; selector: string } | null
  maxIndexDeviationBps: number | null
  maxIndexAgeSeconds: number | null
  redeemDelaySeconds: number | null
  locked: number
  free: number
  markets: VaultMarket[]
  history: { at: string; block: number; totalAssets: string; totalSupply: string }[]
  retired: Retired[]
}
export type Evidence = { kind: string; title: string; status: string; block?: number; detail: string; txs?: { label: string; tx: string; index?: number }[]; vault?: string; size?: number; base?: string; side?: string; price?: number; vaultTag?: string }
export type Deployment = { vault: string; deployTx: string; deployBlock: number; evidence: Evidence[]; trades?: Trade[] }
export type VaultEvent = { event: string; args: Record<string, any>; block: number; tx: string }
export type VaultResponse = { deployment: Deployment | null; state: VaultState | null; events: VaultEvent[] }

export type LiqRow = { id: string; kind: string; account: string; pool: string; symbol: string; size: number; price: number; txHash: string; block: number; at: number }
export type Liquidations = {
  updatedAt: number
  stats: {
    accounts: number
    byStage: Record<string, number>
    emptyBook: number
    pastBook: number
    emptyBookShare: number
    pastBookShare: number
    from: number
    to: number
  } | null
  rows: LiqRow[]
  recentAccounts: { account: string; stage: string; positionsProcessed: number; txHash: string; at: number }[]
}

const API = (window as any).CATCH_API || ""

async function get<T>(path: string): Promise<T> {
  const r = await fetch(API + path, { cache: "no-store" })
  if (!r.ok) throw new Error(`${path}: ${r.status}`)
  return r.json()
}

type Store = {
  status: Status | null
  vault: VaultResponse | null
  liq: Liquidations | null
  markets: Market[] | null
  maps: Record<string, MapData>
  mapLoading: Record<string, boolean>
  error: string | null
  headSeenAt: number
  wallet: Wallet | null
  walletTick: number
  refresh: () => Promise<void>
  loadMarkets: () => Promise<void>
  loadMap: (pool: string, force?: boolean) => Promise<MapData | null>
}

let marketsInFlight: Promise<void> | null = null

export const useCatch = create<Store>((set, getState) => ({
  status: null,
  vault: null,
  liq: null,
  markets: null,
  maps: {},
  mapLoading: {},
  error: null,
  headSeenAt: 0,
  wallet: null,
  walletTick: 0,

  async refresh() {
    try {
      const [status, vault, liq] = await Promise.all([get<Status>("/api/status"), get<VaultResponse>("/api/vault"), get<Liquidations>("/api/liquidations")])
      const prev = getState().status?.head
      set({ status, vault, liq, error: null, headSeenAt: status.head !== prev ? Date.now() : getState().headSeenAt })
      if (!getState().wallet && status.network) {
        const w = new Wallet({ id: status.network.chainId, name: status.network.label, rpc: status.network.rpc })
        w.subscribe(() => set((s) => ({ walletTick: s.walletTick + 1 })))
        set({ wallet: w })
      }
    } catch (e: any) {
      set({ error: e?.message ?? String(e) })
    }
    getState().loadMarkets()
  },

  loadMarkets() {
    // the slow read (every position on every market); never block the page on it
    if (!marketsInFlight) {
      marketsInFlight = get<Market[]>("/api/markets")
        .then((markets) => set({ markets }))
        .catch(() => {})
        .finally(() => {
          marketsInFlight = null
        })
    }
    return marketsInFlight
  },

  async loadMap(pool, force = false) {
    const key = pool.toLowerCase()
    const s = getState()
    if (!force && s.maps[key]) return s.maps[key]
    if (s.mapLoading[key]) return null
    set((st) => ({ mapLoading: { ...st.mapLoading, [key]: true } }))
    try {
      const m = await get<MapData>(`/api/map/${pool}`)
      set((st) => ({ maps: { ...st.maps, [key]: m } }))
      return m
    } catch {
      return null
    } finally {
      set((st) => ({ mapLoading: { ...st.mapLoading, [key]: false } }))
    }
  },
}))

/** Start polling once for the whole app. */
let started = false
export function startPolling() {
  if (started) return
  started = true
  const tick = () => useCatch.getState().refresh()
  tick()
  setInterval(tick, 20_000)
}

export const explorerTx = (net: Network | undefined | null, hash: string) => (net?.explorer ? `${net.explorer}/tx/${hash}` : null)
export const explorerAddr = (net: Network | undefined | null, a: string) => (net?.explorer ? `${net.explorer}/address/${a}` : null)

/** Share price per 1,000 shares from the keeper's recorded reads. */
export function navPoints(v: VaultState | null | undefined) {
  if (!v) return []
  return (v.history || [])
    .map((h) => ({ t: Date.parse(h.at), v: Number(h.totalSupply) > 0 ? (Number(h.totalAssets) * 1000) / Number(h.totalSupply) : null }))
    .filter((p): p is { t: number; v: number } => p.v != null)
}

/** The newest proven catch in the deployment record (carried across vault versions). */
export function lastCatch(d: Deployment | null | undefined) {
  return (d?.evidence || []).filter((e) => e.kind === "catch" && e.status === "proven").sort((a, b) => (b.block ?? 0) - (a.block ?? 0))[0] ?? null
}

/** Round trips across every vault: how each position opened, and what the venue booked when it
 *  shrank. A fill that grows a position is not a close, whatever its realizedPnl field says
 *  (that field can carry funding settled on the update), so only reductions count as results. */
export function roundTrips(v: VaultState | null | undefined, d: Deployment | null | undefined) {
  const all = [...(v?.retired || []).flatMap((r) => (r.trades || []).map((t) => ({ ...t, tag: r.tag }))), ...(d?.trades || []).map((t) => ({ ...t, tag: "current" }))]
  const open = new Map<string, Trade & { tag: string }>()
  const last = new Map<string, number>()
  const rows: { o: (Trade & { tag: string }) | null; c: (Trade & { tag: string }) | null }[] = []
  for (const t of all) {
    const k = `${t.tag}:${t.pool.toLowerCase()}`
    const prev = last.get(k) ?? 0
    last.set(k, t.newSize)
    if (t.newSize !== 0 && !open.has(k)) {
      open.set(k, t)
      continue
    }
    const reduced = Math.abs(t.newSize) < Math.abs(prev) && Math.sign(t.newSize) !== -Math.sign(prev)
    if (t.newSize === 0) {
      rows.push({ o: open.get(k) ?? null, c: t })
      open.delete(k)
    } else if (reduced) {
      rows.push({ o: open.get(k) ?? null, c: t }) // a partial close; the rest stays open
    }
  }
  for (const o of open.values()) rows.push({ o, c: null })
  return rows.sort((a, b) => (b.c?.block ?? b.o?.block ?? 0) - (a.c?.block ?? a.o?.block ?? 0))
}
