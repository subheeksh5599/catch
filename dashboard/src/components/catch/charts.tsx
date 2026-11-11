import * as React from "react"
import { Bar, CartesianGrid, ComposedChart, Line, LineChart, ReferenceArea, ReferenceLine, XAxis, YAxis } from "recharts"
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart"
import type { MapData } from "@/lib/api"
import { price, usd, pct } from "@/lib/format"

const mapConfig = {
  long: { label: "Longs liquidated", color: "var(--long)" },
  short: { label: "Shorts liquidated", color: "var(--short)" },
  book: { label: "Book resting", color: "var(--muted-foreground)" },
  cumLong: { label: "Longs, cumulative", color: "var(--long)" },
  cumShort: { label: "Shorts, cumulative", color: "var(--short)" },
} satisfies ChartConfig

/** Liquidation notional by trigger price, the resting book in the same bins, the mark, and the
 *  vault's catch windows. Red = longs being liquidated, green = shorts, amber = Catch. */
export function LiquidationMapChart({ data, height = 360, compact = false }: { data: MapData; height?: number; compact?: boolean }) {
  const rows = React.useMemo(() => {
    const mi = data.bins.findIndex((b) => b.price >= data.markPrice)
    const cumL = new Array(data.bins.length).fill(0)
    const cumS = new Array(data.bins.length).fill(0)
    for (let i = mi - 1, acc = 0; i >= 0; i--) cumL[i] = acc += data.bins[i].long
    for (let i = Math.max(mi, 0), acc = 0; i < data.bins.length; i++) cumS[i] = acc += data.bins[i].short
    return data.bins.map((b, i) => ({
      ...b,
      below: b.price < data.markPrice,
      book: b.price < data.markPrice ? b.bidDepth : b.askDepth,
      cumLong: i < mi ? cumL[i] : null,
      cumShort: i >= mi ? cumS[i] : null,
    }))
  }, [data])
  const clusters = (data.clusters || []).filter((c): c is NonNullable<typeof c> => !!c?.window)
  const lo = data.bins[0].price - data.binWidth / 2
  const hi = data.bins.at(-1)!.price + data.binWidth / 2

  return (
    <ChartContainer config={mapConfig} className="aspect-auto w-full" style={{ height }}>
      <ComposedChart data={rows} margin={{ left: 4, right: compact ? 4 : 8, top: 12, bottom: 0 }} barCategoryGap={1}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis
          dataKey="price"
          type="number"
          domain={[lo, hi]}
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={48}
          tickFormatter={(v) => price(v, data.markPrice)}
        />
        <YAxis yAxisId="bars" tickLine={false} axisLine={false} width={56} tickFormatter={(v) => usd(v)} />
        {!compact && <YAxis yAxisId="cum" orientation="right" tickLine={false} axisLine={false} width={56} tickFormatter={(v) => usd(v)} />}
        {clusters.map((c, i) => (
          <ReferenceArea key={`w${i}`} yAxisId="bars" x1={Math.max(c.window.lo, lo)} x2={Math.min(c.window.hi, hi)} fill="var(--vault)" fillOpacity={0.1} stroke="var(--vault)" strokeOpacity={0.5} strokeDasharray="4 3" />
        ))}
        {clusters.map((c, i) => (
          <ReferenceLine key={`p${i}`} yAxisId="bars" x={c.price} stroke="var(--vault)" strokeWidth={1.5} />
        ))}
        <Bar yAxisId="bars" dataKey="long" fill="var(--color-long)" radius={[2, 2, 0, 0]} isAnimationActive={false} />
        <Bar yAxisId="bars" dataKey="short" fill="var(--color-short)" radius={[2, 2, 0, 0]} isAnimationActive={false} />
        <Line yAxisId="bars" dataKey="book" type="stepAfter" stroke="var(--color-book)" strokeDasharray="4 3" strokeWidth={1.5} dot={false} isAnimationActive={false} />
        {!compact && <Line yAxisId="cum" dataKey="cumLong" type="monotone" stroke="var(--color-cumLong)" strokeOpacity={0.5} dot={false} isAnimationActive={false} connectNulls={false} />}
        {!compact && <Line yAxisId="cum" dataKey="cumShort" type="monotone" stroke="var(--color-cumShort)" strokeOpacity={0.5} dot={false} isAnimationActive={false} connectNulls={false} />}
        <ReferenceLine yAxisId="bars" x={data.markPrice} stroke="var(--foreground)" strokeOpacity={0.7} label={{ value: `mark ${price(data.markPrice)}`, position: "insideTopRight", fill: "var(--foreground)", fontSize: 11 }} />
        <ChartTooltip
          cursor={{ fill: "var(--muted)", opacity: 0.4 }}
          content={({ active, payload }) => {
            const b = active && (payload?.[0]?.payload as (typeof rows)[number] | undefined)
            if (!b) return null
            const dist = (b.price - data.markPrice) / data.markPrice
            return (
              <div className="grid min-w-52 gap-1 rounded-lg border bg-popover p-3 text-xs shadow-lg">
                <div className="mb-1 font-medium">
                  {price(b.price - data.binWidth / 2, data.markPrice)} to {price(b.price + data.binWidth / 2, data.markPrice)}
                </div>
                <Row k="From mark" v={pct(dist, 2)} />
                {b.below ? (
                  <>
                    <Row k={<span className="text-long">Longs liquidated here</span>} v={`${usd(b.long)} · ${b.longAccounts}`} />
                    <Row k="Down to here" v={usd(b.cumLong ?? 0)} />
                    <Row k="Bids resting" v={usd(b.bidDepth)} />
                  </>
                ) : (
                  <>
                    <Row k={<span className="text-short">Shorts liquidated here</span>} v={`${usd(b.short)} · ${b.shortAccounts}`} />
                    <Row k="Up to here" v={usd(b.cumShort ?? 0)} />
                    <Row k="Asks resting" v={usd(b.askDepth)} />
                  </>
                )}
              </div>
            )
          }}
        />
      </ComposedChart>
    </ChartContainer>
  )
}

function Row({ k, v }: { k: React.ReactNode; v: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{k}</span>
      <span className="num">{v}</span>
    </div>
  )
}

export function MapLegend({ full = false }: { full?: boolean }) {
  const items = [
    ["var(--long)", "Longs liquidated"],
    ["var(--short)", "Shorts liquidated"],
    ["var(--muted-foreground)", "Book resting"],
    ["var(--vault)", full ? "Catch window and order" : "Catch window"],
  ]
  return (
    <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
      {items.map(([c, l]) => (
        <span key={l} className="inline-flex items-center gap-1.5">
          <i className="inline-block size-2 rounded-sm" style={{ background: c }} />
          {l}
        </span>
      ))}
      {full && <span>Thin lines: cumulative from the mark</span>}
    </div>
  )
}

const navConfig = { v: { label: "Share price", color: "var(--primary)" } } satisfies ChartConfig

/** Share price per 1,000 shares, one point per keeper read. Never back-filled. */
export function SharePriceChart({ points, height = 180 }: { points: { t: number; v: number }[]; height?: number }) {
  if (points.length < 2) {
    return (
      <div className="flex items-center justify-center rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground" style={{ minHeight: height }}>
        The line starts after the keeper's second read of this vault. Each point is a real read, never a back-fill.
      </div>
    )
  }
  const span = points.at(-1)!.t - points[0].t
  const fmt = (t: number) => new Date(t).toLocaleString("en-US", span < 2 * 864e5 ? { hour: "numeric", minute: "2-digit" } : { month: "short", day: "numeric" })
  return (
    <ChartContainer config={navConfig} className="aspect-auto w-full" style={{ height }}>
      <LineChart data={points} margin={{ left: 4, right: 8, top: 8 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} tickLine={false} axisLine={false} tickFormatter={fmt} minTickGap={48} />
        <YAxis tickLine={false} axisLine={false} width={56} domain={["auto", "auto"]} tickFormatter={(v) => Number(v).toFixed(3)} />
        <Line dataKey="v" type="monotone" stroke="var(--color-v)" strokeWidth={2} dot={false} isAnimationActive={false} />
        <ChartTooltip
          content={({ active, payload }) => {
            const p = active && (payload?.[0]?.payload as { t: number; v: number } | undefined)
            if (!p) return null
            return (
              <div className="rounded-lg border bg-popover p-2 text-xs shadow-lg">
                <div className="text-muted-foreground">{new Date(p.t).toLocaleString()}</div>
                <div className="num font-medium">{p.v.toFixed(4)} USDso / 1,000 shares</div>
              </div>
            )
          }}
        />
      </LineChart>
    </ChartContainer>
  )
}

export const STAGES: [string, string, string][] = [
  ["OrderCancellation", "Order cancellation", "var(--chart-5)"],
  ["CLOBPartial", "Closed into the book", "var(--primary)"],
  ["BidderTakeover", "Bidder takeover", "var(--info)"],
  ["InsuranceFund", "Insurance fund", "var(--vault)"],
  ["ADL", "Auto-deleverage", "var(--long)"],
]
export const STAGE_LABEL = Object.fromEntries(STAGES.map(([k, l]) => [k, l]))

export function StageBar({ byStage, total }: { byStage: Record<string, number>; total: number }) {
  return (
    <div className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full">
      {STAGES.map(([k, , c]) => (
        <i key={k} className="block h-full" style={{ width: `${((byStage[k] || 0) / (total || 1)) * 100}%`, background: c }} />
      ))}
    </div>
  )
}
