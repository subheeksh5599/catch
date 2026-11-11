import { BaseLayout } from "@/components/layouts/base-layout"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { StatCard, Section, Reading, AddrLink } from "@/components/catch/parts"
import { STAGE_LABEL } from "@/components/catch/charts"
import { StagesTable, LiquidationRows } from "@/pages/overview"
import { useCatch } from "@/lib/api"
import { pct, int, ago } from "@/lib/format"

export default function LiquidationsPage() {
  const liq = useCatch((s) => s.liq)
  const status = useCatch((s) => s.status)
  const st = liq?.stats
  const e = status?.engine
  return (
    <BaseLayout description="From the venue's LiquidationEngine events.">
      <div className="grid grid-cols-1 gap-4 px-4 @xl/main:grid-cols-2 @5xl/main:grid-cols-4 lg:px-6">
        <StatCard label="Account liquidations read" value={st ? int(st.accounts) : null} sub={st?.from ? `since ${new Date(st.from).toLocaleDateString()}` : undefined} />
        <StatCard label="Sent to an empty book" value={st ? pct(st.emptyBookShare) : null} sub={st ? `${int(st.emptyBook)} accounts` : undefined} />
        <StatCard label="Went past the book" value={st ? pct(st.pastBookShare) : null} sub="bidder, insurance fund or ADL" />
        <StatCard
          label="Engine close window"
          value={e ? `${e.minSpreadBps / 100} to ${e.maxSpreadBps / 100}%` : null}
          sub={e ? `from the mark · ${int(e.bidderCount)} registered bidder${e.bidderCount === 1 ? "" : "s"}` : undefined}
        />
      </div>
      <div className="grid items-start gap-4 px-4 lg:grid-cols-[2fr_1fr] lg:px-6">
        <Section title="Position liquidations" hint="most recent first">
          <div className="max-h-[640px] overflow-auto">
            <LiquidationRows limit={200} />
          </div>
        </Section>
        <div className="grid gap-4">
          <Section title="Stage reached">
            <StagesTable />
          </Section>
          <Section title="Recent accounts">
            {!liq ? (
              <Reading title="Reading" height={160} />
            ) : (
              <div className="max-h-96 overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Account</TableHead>
                      <TableHead>Stage</TableHead>
                      <TableHead className="text-right">Closed</TableHead>
                      <TableHead className="text-right">When</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {liq.recentAccounts.map((r) => (
                      <TableRow key={r.txHash + r.account}>
                        <TableCell>
                          <AddrLink address={r.account} />
                        </TableCell>
                        <TableCell className="text-muted-foreground">{STAGE_LABEL[r.stage] ?? r.stage}</TableCell>
                        <TableCell className={`num text-right ${r.stage === "CLOBPartial" && !r.positionsProcessed ? "text-long" : ""}`}>{r.positionsProcessed}</TableCell>
                        <TableCell className="num text-right text-muted-foreground">{ago(r.at)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </Section>
        </div>
      </div>
    </BaseLayout>
  )
}
