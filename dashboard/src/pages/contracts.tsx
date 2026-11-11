import * as React from "react"
import { BaseLayout } from "@/components/layouts/base-layout"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Section, AddrLink } from "@/components/catch/parts"
import { useCatch } from "@/lib/api"
import { int, baseOf } from "@/lib/format"

export default function ContractsPage() {
  const s = useCatch((st) => st.status)
  const vault = useCatch((st) => st.vault)
  const markets = useCatch((st) => st.markets)
  const d = vault?.deployment
  const rows: [string, string | null | undefined, React.ReactNode][] = [
    ["CatchVault", d?.vault, d ? `Live, deployed at block ${int(d.deployBlock)}` : "Not deployed on this network"],
    ...(vault?.state?.retired || []).map((r): [string, string, React.ReactNode] => [`CatchVault ${r.tag}`, r.vault, `Retired: ${r.retired?.reason ?? ""}`]),
    ["MarginBank", s?.system?.marginBank, "Positions, health, bankruptcy prices, holder lists"],
    ["LiquidationEngine", s?.system?.liquidationEngine, `Penalty ${(s?.engine?.penaltyBps ?? 0) / 100}%, close window ${(s?.engine?.minSpreadBps ?? 0) / 100} to ${(s?.engine?.maxSpreadBps ?? 0) / 100}% from the mark`],
    ["InsuranceFund", s?.system?.insuranceFund, "Stage 5 of the waterfall"],
    ["USDso", s?.system?.collateral, "Collateral and the vault's asset"],
    ...(markets || []).map((m): [string, string, React.ReactNode] => [`${baseOf(m.symbol)}-PERP`, m.pool, "PerpPool"]),
  ]
  return (
    <BaseLayout description="Every address this dashboard reads.">
      <div className="grid gap-4 px-4 lg:px-6">
        <Section title={s ? `${s.network.label}, chain ${s.network.chainId}` : "Network"} hint={s?.head ? `head ${int(s.head)}` : undefined}>
          <div className="overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Contract</TableHead>
                  <TableHead>Address</TableHead>
                  <TableHead>Role</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map(([name, a, note]) => (
                  <TableRow key={name + (a ?? "")}>
                    <TableCell className="font-medium">{name}</TableCell>
                    <TableCell>{a ? <AddrLink address={a} full /> : <span className="text-muted-foreground">—</span>}</TableCell>
                    <TableCell className="whitespace-normal text-muted-foreground">{note}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Section>
        {!!s?.errors?.length && (
          <Section title="Recent read errors">
            {s.errors.map((e, i) => (
              <div key={i} className="font-mono text-xs text-muted-foreground">
                {new Date(e.at).toLocaleTimeString()} {e.msg}
              </div>
            ))}
          </Section>
        )}
      </div>
    </BaseLayout>
  )
}
