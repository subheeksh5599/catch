import * as React from "react"
import { Link } from "react-router-dom"
import { ArrowRight } from "lucide-react"
import { BaseLayout } from "@/components/layouts/base-layout"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardAction } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { StatCard, Section, Reading, TxLink, Tag, Sym, AddrLink, Empty } from "@/components/catch/parts"
import { LiquidationMapChart, MapLegend, StageBar, STAGES } from "@/components/catch/charts"
import { useCatch, lastCatch, navPoints, type Deployment } from "@/lib/api"
import { usd, pct, int, qty, price, ago, baseOf } from "@/lib/format"

export function CatchReceipt({ deployment }: { deployment: Deployment | null | undefined }) {
  const c = lastCatch(deployment)
  if (!c) {
    return (
      <Card className="shadow-xs">
        <CardHeader>
          <CardTitle className="text-base">Last catch</CardTitle>
          <CardAction>
            <Tag tone="vault">Waiting</Tag>
          </CardAction>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">No liquidation has filled a vault order on this deployment yet.</CardContent>
      </Card>
    )
  }
  const liq = c.txs?.find((t) => /liquidation/i.test(t.label))
  const cb = c.txs?.find((t) => /callback/i.test(t.label))
  return (
    <Card className="border-vault/40 bg-linear-to-br from-vault/10 to-card shadow-xs">
      <CardHeader>
        <CardDescription>Last catch</CardDescription>
        <CardTitle className="num text-3xl font-semibold">
          {c.size != null ? `${qty(Math.abs(c.size))} ${c.base ?? ""}` : "Caught"}
        </CardTitle>
        <CardAction>
          <Tag tone="ok">On chain</Tag>
        </CardAction>
        <CardDescription>
          A {c.side ?? "position"} force-closed by the engine into the vault's {c.side === "short" ? "ask" : "bid"}
          {c.price != null && <> at <span className="num text-foreground">{price(c.price)}</span></>}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="divide-y rounded-lg border">
          {liq && (
            <div className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <span className="num w-20 shrink-0 text-xs text-muted-foreground">{liq.index != null ? `#${liq.index} in block` : "in block"}</span>
              <span className="flex-1">Liquidation engine closes the position into the book</span>
              <TxLink hash={liq.tx} />
            </div>
          )}
          {cb && (
            <div className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <span className="num w-20 shrink-0 text-xs text-muted-foreground">{cb.index != null ? `#${cb.index} in block` : "in block"}</span>
              <span className="flex-1">Reactivity callback records it and rests the unwind</span>
              <TxLink hash={cb.tx} />
            </div>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Both in block <span className="num">{int(c.block)}</span>
          {c.vaultTag ? ` · vault ${c.vaultTag}` : ""}. The liquidated trader and the liquidation sender are both outside Catch.
        </p>
      </CardContent>
    </Card>
  )
}

export function StagesTable({ compact = false }: { compact?: boolean }) {
  const st = useCatch((s) => s.liq?.stats)
  if (!st) return <Reading title="Reading the venue's liquidation history" height={200} />
  const total = st.accounts || 1
  return (
    <div className="grid gap-3">
      <StageBar byStage={st.byStage} total={total} />
      <Table>
        <TableBody>
          {STAGES.map(([k, label, c]) => (
            <TableRow key={k}>
              <TableCell>
                <span className="inline-flex items-center gap-2">
                  <i className="inline-block size-2 rounded-sm" style={{ background: c }} />
                  {label}
                </span>
              </TableCell>
              <TableCell className="num text-right">{int(st.byStage[k] || 0)}</TableCell>
              <TableCell className="num text-right text-muted-foreground">{pct((st.byStage[k] || 0) / total)}</TableCell>
            </TableRow>
          ))}
          <TableRow>
            <TableCell>
              <div className="font-medium">Book was empty</div>
              {!compact && <div className="text-xs text-muted-foreground">Sent to the book, nothing filled</div>}
            </TableCell>
            <TableCell className="num text-right font-medium">{int(st.emptyBook)}</TableCell>
            <TableCell className="num text-right text-vault">{pct(st.emptyBookShare)}</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  )
}

export function LiquidationRows({ limit }: { limit: number }) {
  const liq = useCatch((s) => s.liq)
  if (!liq) return <Reading title="Reading recent liquidations" height={160} />
  const rows = liq.rows.filter((r) => r.kind === "PositionLiquidated" || r.kind === "AutoDeleveraged").slice(0, limit)
  if (!rows.length) return <Empty>No liquidations indexed in this window.</Empty>
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Market</TableHead>
          <TableHead>Kind</TableHead>
          <TableHead className="text-right">Size</TableHead>
          <TableHead className="text-right">Price</TableHead>
          <TableHead>Account</TableHead>
          <TableHead className="text-right">When</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.id}>
            <TableCell>
              <Sym symbol={r.symbol || "?"} />
            </TableCell>
            <TableCell>{r.kind === "AutoDeleveraged" ? <Tag>ADL</Tag> : r.size > 0 ? <Tag tone="long">Long</Tag> : <Tag tone="short">Short</Tag>}</TableCell>
            <TableCell className="num text-right">{qty(Math.abs(r.size))}</TableCell>
            <TableCell className="num text-right">{price(r.price)}</TableCell>
            <TableCell>
              <AddrLink address={r.account} />
            </TableCell>
            <TableCell className="num text-right text-muted-foreground">{ago(r.at)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

export default function OverviewPage() {
  const status = useCatch((s) => s.status)
  const vault = useCatch((s) => s.vault)
  const st = useCatch((s) => s.liq?.stats)
  const markets = useCatch((s) => s.markets)
  const maps = useCatch((s) => s.maps)
  const loadMap = useCatch((s) => s.loadMap)
  const v = vault?.state
  const top = markets?.[0]
  React.useEffect(() => {
    if (top) loadMap(top.pool)
  }, [top?.pool])
  const map = top ? maps[top.pool.toLowerCase()] : undefined
  const orders = v ? v.markets.reduce((n, m) => n + m.slots.filter((s) => !s.unwind).length, 0) : null
  const quoted = v ? v.markets.filter((m) => m.slots.length).length : 0
  const hist = navPoints(v)
  const change = hist.length > 1 ? hist.at(-1)!.v / hist[0].v - 1 : null

  return (
    <BaseLayout>
      <div className="grid gap-4 px-4 lg:grid-cols-[1.4fr_1fr] lg:px-6">
        <Card className="justify-between shadow-xs">
          <CardHeader>
            <CardTitle className="text-2xl leading-tight">Every liquidation finds a buyer</CardTitle>
            <CardDescription className="max-w-xl text-sm">
              dreamDEX closes a liquidated position into the public order book first, and often the book is empty there. Catch is a vault that rests orders at those prices and
              drops each one in the same block the positions behind it change.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5">
            <ol className="grid gap-4 sm:grid-cols-3">
              {[
                ["Map", "Every open position and its liquidation price, read in one block"],
                ["Rest", "A post-only order inside the engine's close window, checked by the contract"],
                ["Catch", "The forced close fills it; the vault offers it back at or past entry"],
              ].map(([t, d], i) => (
                <li key={t} className="grid gap-1 text-sm">
                  <span className="num font-mono text-xs text-primary">0{i + 1}</span>
                  <span className="font-medium">{t}</span>
                  <span className="text-muted-foreground">{d}</span>
                </li>
              ))}
            </ol>
            <div className="flex flex-wrap gap-2">
              <Button render={<Link to="/vault" />} nativeButton={false}>
                Deposit USDso <ArrowRight className="size-4" />
              </Button>
              <Button variant="outline" render={<Link to="/map" />} nativeButton={false}>
                Open the map
              </Button>
            </div>
          </CardContent>
        </Card>
        <CatchReceipt deployment={vault?.deployment} />
      </div>

      <div className="grid grid-cols-1 gap-4 px-4 @xl/main:grid-cols-2 @5xl/main:grid-cols-4 lg:px-6">
        <StatCard label="Vault assets" value={v ? usd(v.totalAssets, { compact: false, digits: 2 }) : null} sub={v ? "USDso, marked to market" : undefined} />
        <StatCard
          label="Share price"
          value={v ? v.sharePrice.toFixed(4) : null}
          foot={change != null ? <span className={change >= 0 ? "text-short" : "text-long"}>{`${change >= 0 ? "+" : ""}${(change * 100).toFixed(2)}% since the first recorded read`}</span> : undefined}
          sub="USDso per 1,000 shares"
        />
        <StatCard label="Orders resting" value={orders != null ? int(orders) : null} sub={v ? (orders ? `${quoted} market${quoted === 1 ? "" : "s"}, all post-only` : "Placed when a cluster is in reach") : undefined} />
        <StatCard
          label="Liquidations into an empty book"
          value={st ? pct(st.emptyBookShare) : null}
          foot={st ? <span className="text-vault">Nobody was there to buy</span> : undefined}
          sub={st ? `${int(st.emptyBook)} of the last ${int(st.accounts)} on the venue` : undefined}
        />
      </div>

      <div className="grid gap-4 px-4 lg:grid-cols-[2fr_1fr] lg:px-6">
        <Section
          title={top ? `${baseOf(top.symbol)}-PERP liquidations by price` : "Liquidations by price"}
          hint={map ? `block ${int(map.block)} · ${ago(map.at)}` : status ? "the busiest market" : undefined}
          action={
            top && (
              <Button variant="ghost" size="sm" render={<Link to={`/map?m=${top.pool}`} />} nativeButton={false}>
                Full map
              </Button>
            )
          }
        >
          {map ? (
            <div className="grid gap-3">
              <LiquidationMapChart data={map} height={300} compact />
              <MapLegend />
            </div>
          ) : (
            <Reading
              title={`Reading every open ${top ? baseOf(top.symbol) : ""} position`}
              detail="Liquidation prices come from each account's health, read in one block. The first read of a market walks every account and can take a few minutes on testnet."
              height={300}
            />
          )}
        </Section>
        <Section title="How liquidations ended" hint={st ? `last ${int(st.accounts)} account liquidations` : undefined}>
          <StagesTable compact />
        </Section>
      </div>

      <div className="px-4 lg:px-6">
        <Section
          title="Latest liquidations"
          action={
            <Button variant="ghost" size="sm" render={<Link to="/liquidations" />} nativeButton={false}>
              All
            </Button>
          }
        >
          <LiquidationRows limit={8} />
        </Section>
      </div>
    </BaseLayout>
  )
}
