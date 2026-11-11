import * as React from "react"
import { cn } from "@/lib/utils"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle, CardAction } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { useCatch, explorerTx, explorerAddr } from "@/lib/api"
import { short, baseOf } from "@/lib/format"

/** KPI card in the template's section-cards style. `value` null renders what is being read. */
export function StatCard({ label, value, foot, sub, reading = "Reading…", action }: { label: string; value: React.ReactNode | null; foot?: React.ReactNode; sub?: React.ReactNode; reading?: string; action?: React.ReactNode }) {
  return (
    <Card className="@container/card bg-linear-to-t from-primary/5 to-card shadow-xs">
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="num text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
          {value ?? <span className="text-base font-normal text-muted-foreground">{reading}</span>}
        </CardTitle>
        {action && <CardAction>{action}</CardAction>}
      </CardHeader>
      {(foot || sub) && (
        <CardFooter className="flex-col items-start gap-1 text-sm">
          {foot && <div className="line-clamp-1 flex gap-2 font-medium">{foot}</div>}
          {sub && <div className="text-muted-foreground">{sub}</div>}
        </CardFooter>
      )}
    </Card>
  )
}

export function Section({ title, hint, action, children, className, contentClassName }: { title: React.ReactNode; hint?: React.ReactNode; action?: React.ReactNode; children: React.ReactNode; className?: string; contentClassName?: string }) {
  return (
    <Card className={cn("min-w-0 shadow-xs", className)}>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        {hint && <CardDescription>{hint}</CardDescription>}
        {action && <CardAction>{action}</CardAction>}
      </CardHeader>
      <CardContent className={cn("min-w-0", contentClassName)}>{children}</CardContent>
    </Card>
  )
}

export function Reading({ title, detail, height = 240 }: { title: string; detail?: string; height?: number }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed bg-muted/30 p-6 text-center" style={{ minHeight: height }}>
      <Skeleton className="h-2 w-24" />
      <div className="text-sm font-medium">{title}</div>
      {detail && <div className="max-w-md text-xs text-muted-foreground">{detail}</div>}
    </div>
  )
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">{children}</div>
}

export function TxLink({ hash, label }: { hash: string; label?: string }) {
  const net = useCatch((s) => s.status?.network)
  const href = explorerTx(net, hash)
  const text = label ?? short(hash)
  return href ? (
    <a className="num font-mono text-xs text-primary hover:underline" href={href} target="_blank" rel="noopener">
      {text}
    </a>
  ) : (
    <span className="num font-mono text-xs text-muted-foreground" title={hash}>
      {text}
    </span>
  )
}

export function AddrLink({ address, full }: { address: string; full?: boolean }) {
  const net = useCatch((s) => s.status?.network)
  const href = explorerAddr(net, address)
  const text = full ? address : short(address)
  return href ? (
    <a className="num font-mono text-xs text-primary hover:underline" href={href} target="_blank" rel="noopener">
      {text}
    </a>
  ) : (
    <span className="num font-mono text-xs text-muted-foreground" title={address}>
      {text}
    </span>
  )
}

export function Sym({ symbol, note = "PERP" }: { symbol: string; note?: string }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="font-medium">{baseOf(symbol)}</span>
      <span className="text-xs text-muted-foreground">{note}</span>
    </span>
  )
}

const TONES = {
  long: "bg-long/15 text-long",
  short: "bg-short/15 text-short",
  vault: "bg-vault/15 text-vault",
  ok: "bg-success/15 text-success",
  muted: "bg-muted text-muted-foreground",
  info: "bg-primary/15 text-primary",
}

export function Tag({ tone = "muted", children, className }: { tone?: keyof typeof TONES; children: React.ReactNode; className?: string }) {
  return <span className={cn("inline-flex h-5 shrink-0 items-center rounded-full px-2 text-xs font-medium whitespace-nowrap", TONES[tone], className)}>{children}</span>
}

export function Kv({ rows }: { rows: [React.ReactNode, React.ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-sm">
      {rows.map(([k, v], i) => (
        <React.Fragment key={i}>
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="num text-right">{v}</dd>
        </React.Fragment>
      ))}
    </dl>
  )
}
