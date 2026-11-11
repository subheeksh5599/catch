import * as React from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
import { BaseLayout } from "@/components/layouts/base-layout"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Card, CardContent, CardHeader, CardTitle, CardAction, CardDescription } from "@/components/ui/card"
import { StatCard, Section, Reading, AddrLink, Tag, Kv, Empty } from "@/components/catch/parts"
import { LiquidationMapChart, MapLegend } from "@/components/catch/charts"
import { useCatch, type Cluster, type MapData } from "@/lib/api"
import { usd, price, qty, pct, int, ago, baseOf } from "@/lib/format"

function ClusterCard({ c, m }: { c: Cluster; m: MapData }) {
  const long = c.side === "bid"
  return (
    <Card className="shadow-xs">
      <CardHeader>
        <CardDescription>{long ? <Tag tone="long">Bid under longs</Tag> : <Tag tone="short">Ask over shorts</Tag>}</CardDescription>
        <CardTitle className="num text-2xl">{price(c.price, m.markPrice)}</CardTitle>
        <CardAction className="text-xs text-muted-foreground">{int(c.accountsInWindow)} accounts in window</CardAction>
        <CardDescription className="num">
          {pct((c.price - m.markPrice) / m.markPrice, 2)} from mark · window <span className="text-vault">{price(c.window.lo, m.markPrice)} to {price(c.window.hi, m.markPrice)}</span>
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Kv
          rows={[
            ["Forced size", `${qty(c.size)} ${m.base}`],
            ["Notional", usd(c.notional)],
            ["Book inside the window", <span className={c.coverage < 0.25 ? "text-long" : ""}>{usd(c.restingInWindow)}</span>],
            ["Vault order", c.vaultOrderQty == null ? <span className="text-muted-foreground">No vault on this network</span> : c.vaultOrderQty > 0 ? `${qty(c.vaultOrderQty)} ${m.base}` : <span className="text-muted-foreground">Under the venue minimum</span>],
          ]}
        />
      </CardContent>
    </Card>
  )
}

export default function MapPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const markets = useCatch((s) => s.markets)
  const maps = useCatch((s) => s.maps)
  const loading = useCatch((s) => s.mapLoading)
  const loadMap = useCatch((s) => s.loadMap)
  const pool = params.get("m") || markets?.[0]?.pool
  const m0 = markets?.find((x) => x.pool.toLowerCase() === pool?.toLowerCase()) ?? markets?.[0]
  React.useEffect(() => {
    if (m0) loadMap(m0.pool)
  }, [m0?.pool])
  const m = m0 ? maps[m0.pool.toLowerCase()] : undefined

  const picker = markets && (
    <Select value={m0?.pool} onValueChange={(p) => navigate(`/map?m=${p}`)} items={markets.map((x) => ({ value: x.pool, label: `${baseOf(x.symbol)}-PERP` }))}>
      <SelectTrigger className="w-44" aria-label="Market">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {markets.map((x) => (
          <SelectItem key={x.pool} value={x.pool}>
            {baseOf(x.symbol)}-PERP
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )

  if (!markets || !m0 || !m) {
    return (
      <BaseLayout>
        <div className="flex items-center justify-between gap-3 px-4 lg:px-6">
          <span className="text-sm text-muted-foreground">{m0 ? `${baseOf(m0.symbol)}-PERP` : "Markets"}</span>
          {picker}
        </div>
        <div className="px-4 lg:px-6">
          <Reading
            title={`Reading every open ${m0 ? baseOf(m0.symbol) : ""} position`}
            detail={`Liquidation prices come from each account's health, read in one block. The first read of a market walks every account and can take a few minutes on testnet.${m0 && loading[m0.pool.toLowerCase()] ? "" : ""}`}
            height={420}
          />
        </div>
      </BaseLayout>
    )
  }

  const r = m.risk
  const moves = [
    ...["10%", "5%", "3%", "1%"].map((k) => ({ d: -parseFloat(k) / 100, v: r[k as keyof typeof r].long, side: "Longs sold" })),
    ...["1%", "3%", "5%", "10%"].map((k) => ({ d: parseFloat(k) / 100, v: r[k as keyof typeof r].short, side: "Shorts bought back" })),
  ]

  return (
    <BaseLayout>
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 lg:px-6">
        <div>
          <h2 className="text-xl font-medium">{baseOf(m.symbol)}-PERP</h2>
          <p className="num text-xs text-muted-foreground">
            block {int(m.block)} · {ago(m.at)}
          </p>
        </div>
        {picker}
      </div>
      <div className="grid grid-cols-1 gap-4 px-4 @xl/main:grid-cols-2 @5xl/main:grid-cols-4 lg:px-6">
        <StatCard label="Mark" value={price(m.markPrice)} sub={`Maintenance margin ${(m.maintenanceMarginBps / 100).toFixed(2)}%`} />
        <StatCard
          label="Open positions"
          value={int(m.positions)}
          sub={`${int(m.holders.long)} long, ${int(m.holders.short)} short${m.pricedShare != null && m.pricedShare < 1 ? `, prices read for ${pct(m.pricedShare)} of size` : ""}`}
        />
        <StatCard label="Liquidated by a 1% move" value={usd(r["1%"].long + r["1%"].short)} sub={`${int(r["1%"].accounts)} accounts`} />
        <StatCard label="Liquidated by a 5% move" value={usd(r["5%"].long + r["5%"].short)} sub={`${usd(r["5%"].long)} long, ${usd(r["5%"].short)} short`} />
      </div>
      <div className="grid items-start gap-4 px-4 lg:grid-cols-[2fr_1fr] lg:px-6">
        <Section title="Liquidation notional by trigger price" hint="hover a bar for the accounts and the book at that price" contentClassName="grid gap-3">
          <LiquidationMapChart data={m} height={420} />
          <MapLegend full />
          {m.outsideRange > 0 && <p className="text-xs text-muted-foreground">{int(m.outsideRange)} positions trigger more than 15% from the mark and are off the chart.</p>}
        </Section>
        <div className="grid gap-4">
          {(m.clusters || []).filter((c): c is Cluster => !!c).map((c) => <ClusterCard key={c.side} c={c} m={m} />)}
          {!(m.clusters || []).some(Boolean) && <Empty>No cluster within reach of the mark on either side.</Empty>}
        </div>
      </div>
      <div className="grid gap-4 px-4 lg:grid-cols-2 lg:px-6">
        <Section title="If the mark moves" hint="liquidation notional crossed, and the book on that side">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Move</TableHead>
                <TableHead className="text-right">Price</TableHead>
                <TableHead>Forced</TableHead>
                <TableHead className="text-right">Notional crossed</TableHead>
                <TableHead className="text-right">Book resting</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {moves.map(({ d, v, side }) => {
                const p = m.markPrice * (1 + d)
                const book = m.bins.reduce((t, b) => t + (d < 0 ? (b.price >= p && b.price < m.markPrice ? b.bidDepth : 0) : b.price <= p && b.price > m.markPrice ? b.askDepth : 0), 0)
                return (
                  <TableRow key={d}>
                    <TableCell className={`num ${d < 0 ? "text-long" : "text-short"}`}>
                      {d > 0 ? "+" : ""}
                      {(d * 100).toFixed(0)}%
                    </TableCell>
                    <TableCell className="num text-right">{price(p, m.markPrice)}</TableCell>
                    <TableCell className="text-muted-foreground">{side}</TableCell>
                    <TableCell className="num text-right">{usd(v)}</TableCell>
                    <TableCell className={`num text-right ${v > 0 && book < v * 0.25 ? "text-long" : ""}`}>{usd(book)}</TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </Section>
        <Section title="Closest to liquidation" hint="single-market solve, as the venue's SDK publishes it">
          <div className="max-h-96 overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Account</TableHead>
                  <TableHead>Side</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                  <TableHead className="text-right">Liquidation</TableHead>
                  <TableHead className="text-right">From mark</TableHead>
                  <TableHead className="text-right">Notional</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {m.near.map((p) => (
                  <TableRow key={p.account + p.side}>
                    <TableCell>
                      <AddrLink address={p.account} />
                    </TableCell>
                    <TableCell>{p.side === "long" ? <Tag tone="long">Long</Tag> : <Tag tone="short">Short</Tag>}</TableCell>
                    <TableCell className="num text-right">{qty(p.size)}</TableCell>
                    <TableCell className="num text-right">{price(p.liq, m.markPrice)}</TableCell>
                    <TableCell className={`num text-right ${p.distance < 0.02 ? "text-long" : "text-muted-foreground"}`}>{pct(p.distance, 2)}</TableCell>
                    <TableCell className="num text-right">{usd(p.notional)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Section>
      </div>
    </BaseLayout>
  )
}
