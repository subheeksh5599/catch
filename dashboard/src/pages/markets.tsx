import { useNavigate } from "react-router-dom"
import { BaseLayout } from "@/components/layouts/base-layout"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Section, Reading, Sym, Tag } from "@/components/catch/parts"
import { useCatch } from "@/lib/api"
import { usd, price, pct, int } from "@/lib/format"

export default function MarketsPage() {
  const markets = useCatch((s) => s.markets)
  const v = useCatch((s) => s.vault?.state)
  const navigate = useNavigate()
  return (
    <BaseLayout>
      <div className="px-4 lg:px-6">
        <Section title={markets ? `${markets.length} perps, busiest first` : "Markets"} hint="select a row to open its liquidation map">
          {!markets ? (
            <Reading title="Reading every market" height={320} />
          ) : (
            <div className="overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Market</TableHead>
                    <TableHead className="text-right">Mark</TableHead>
                    <TableHead className="text-right" title="Somnia Price Feeds: the median across exchanges, written on chain by Somnia Agents every 500 ms. The keeper quotes a market only while this is under 15 s old, backed by 2+ agents, and the venue mark is within 1.5% of it.">
                      Agents' price
                    </TableHead>
                    <TableHead className="text-right">Open interest</TableHead>
                    <TableHead className="text-right">Funding</TableHead>
                    <TableHead className="text-right">Positions</TableHead>
                    <TableHead className="text-right">1% move</TableHead>
                    <TableHead className="text-right">5% move</TableHead>
                    <TableHead className="text-right">Book in window</TableHead>
                    <TableHead className="text-right">Vault</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {markets.map((m) => {
                    const cl = (m.clusters || []).filter((c): c is NonNullable<typeof c> => !!c)
                    const n = cl.reduce((a, c) => a + c.notional, 0)
                    const rest = cl.reduce((a, c) => a + c.restingInWindow, 0)
                    const vm = v?.markets.find((x) => x.pool.toLowerCase() === m.pool.toLowerCase())
                    return (
                      <TableRow key={m.pool} className="cursor-pointer" onClick={() => navigate(`/map?m=${m.pool}`)}>
                        <TableCell>
                          <Sym symbol={m.symbol} />
                        </TableCell>
                        <TableCell className="num text-right">{price(m.markPrice)}</TableCell>
                        <TableCell className="num text-right">
                          {m.agent ? (
                            <span title={`${m.agent.pair} · ${m.agent.validators} agents · ${(m.agent.ageMs / 1000).toFixed(1)} s old when read`}>
                              {price(m.agent.mark)}{" "}
                              <span className={`text-xs ${m.agent.gapBps != null && m.agent.gapBps > 150 ? "text-long" : "text-muted-foreground"}`}>
                                {m.agent.gapBps == null ? "" : `${(m.agent.gapBps / 100).toFixed(2)}%`}
                              </span>
                            </span>
                          ) : (
                            <span className="text-muted-foreground">none</span>
                          )}
                        </TableCell>
                        <TableCell className="num text-right">{usd(m.openInterest * m.markPrice)}</TableCell>
                        <TableCell className={`num text-right ${(m.fundingRate ?? 0) >= 0 ? "text-short" : "text-long"}`}>{m.fundingRate == null ? "—" : `${(m.fundingRate * 100).toFixed(4)}%`}</TableCell>
                        <TableCell className="num text-right">{m.positions == null ? <span className="text-muted-foreground">queued</span> : int(m.positions)}</TableCell>
                        <TableCell className="num text-right">{m.risk ? usd(m.risk["1%"].long + m.risk["1%"].short) : "—"}</TableCell>
                        <TableCell className="num text-right">{m.risk ? usd(m.risk["5%"].long + m.risk["5%"].short) : "—"}</TableCell>
                        <TableCell className={`num text-right ${n && rest / n < 0.25 ? "text-long" : ""}`}>{n ? pct(rest / n, 0) : "—"}</TableCell>
                        <TableCell className="text-right">{vm?.slots.length ? <Tag tone="vault">{vm.slots.length} order{vm.slots.length > 1 ? "s" : ""}</Tag> : <span className="text-muted-foreground">—</span>}</TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </Section>
      </div>
    </BaseLayout>
  )
}
