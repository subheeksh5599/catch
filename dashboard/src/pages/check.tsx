import * as React from "react"
import { useSearchParams } from "react-router-dom"
import { BaseLayout } from "@/components/layouts/base-layout"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Section, Reading, Empty, Sym, Tag, StatCard } from "@/components/catch/parts"
import { ShareOnX } from "@/pages/vault"
import { useCatch } from "@/lib/api"
import { usd, price, pct, qty, int, short } from "@/lib/format"

type Close = { filled: number; unfilled: number; coverage: number; avgPrice: number | null; restingNotional: number }
type CheckPosition = {
  pool: string
  symbol: string
  base: string
  side: "long" | "short"
  size: number
  entry: number
  mark: number
  liq: number | null
  distance: number | null
  notionalAtLiq: number | null
  window: { lo: number; hi: number } | null
  close: Close | null
  catch: { orders: number; notional: number; citesYou: boolean } | null
  verdict: "covered" | "partial" | "empty" | "far" | "beyond-zero"
}
type CheckResult = { account: string; block: number; at: number; liquidatable: boolean | null; maxSpreadBps: number | null; positions: CheckPosition[] }

const API = (window as any).CATCH_API || ""
const isAddr = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s)

const VERDICT: Record<CheckPosition["verdict"], { tone: "ok" | "long" | "vault" | "muted"; text: string }> = {
  covered: { tone: "ok", text: "has a buyer" },
  partial: { tone: "vault", text: "partly covered" },
  empty: { tone: "long", text: "no buyer" },
  far: { tone: "muted", text: "more than 15% away" },
  "beyond-zero": { tone: "muted", text: "no liquidation price" },
}

export default function CheckPage() {
  const [params, setParams] = useSearchParams()
  const wallet = useCatch((s) => s.wallet)
  useCatch((s) => s.walletTick)
  const [text, setText] = React.useState(params.get("a") ?? "")
  const [data, setData] = React.useState<CheckResult | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const address = params.get("a") ?? ""

  const run = React.useCallback(async (a: string) => {
    setBusy(true)
    setError(null)
    try {
      const r = await fetch(`${API}/api/check?address=${a}`, { cache: "no-store" })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error || `${r.status}`)
      setData(j)
    } catch (e: any) {
      setError(e?.message ?? String(e))
      setData(null)
    } finally {
      setBusy(false)
    }
  }, [])

  React.useEffect(() => {
    if (isAddr(address)) {
      setText(address)
      run(address)
    }
  }, [address, run])

  const submit = (a: string) => {
    const v = a.trim()
    if (!isAddr(v)) return setError("Paste a 0x… dreamDEX account address")
    if (v.toLowerCase() === address.toLowerCase()) run(v)
    else setParams({ a: v })
  }

  const useWallet = async () => {
    if (!wallet) return
    if (!wallet.account) await wallet.connect().catch(() => {})
    if (wallet.account) submit(wallet.account)
  }

  const judged = (data?.positions || []).filter((p) => ["covered", "partial", "empty"].includes(p.verdict))
  const exposed = judged.filter((p) => p.verdict !== "covered")
  const lead = judged[0] ?? null

  return (
    <BaseLayout description="Paste any dreamDEX account. For each open perp, see where it gets liquidated and whether anyone is waiting in the book to take it when it does. Read from the chain and the venue's book just now; nothing is signed.">
      <div className="grid gap-4 px-4 md:gap-6 lg:px-6">
        <Section title="Is anyone waiting under your liquidation?" hint="When a position is liquidated, dreamDEX closes it into the public order book first, within a fixed window of the trigger price. If nobody is resting there, the loss falls past the book: a backstop bidder, the insurance fund, then auto-deleveraging of profitable traders.">
          <form
            className="flex flex-col gap-2 sm:flex-row"
            onSubmit={(e) => {
              e.preventDefault()
              submit(text)
            }}
          >
            <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="0x… your dreamDEX account" className="num font-mono" spellCheck={false} />
            <Button type="submit" disabled={busy}>{busy ? "Reading…" : "Check"}</Button>
            {wallet && (
              <Button type="button" variant="outline" disabled={busy} onClick={useWallet}>
                {wallet.account ? `Use ${short(wallet.account)}` : "Use my wallet"}
              </Button>
            )}
          </form>
          {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
        </Section>

        {busy && !data && <Reading title="Reading every market for this account" detail="Positions, account health, bankruptcy prices and the live book inside each close window." height={200} />}

        {data && (
          <>
            <div className="grid grid-cols-1 gap-4 @xl/main:grid-cols-2 @5xl/main:grid-cols-4">
              <StatCard label="Open perps" value={int(data.positions.length)} sub={`account ${short(data.account)} · block ${int(data.block)}`} />
              <StatCard
                label="Within 15% of liquidation"
                value={int(judged.length)}
                sub={data.liquidatable ? "the engine reports this account liquidatable right now" : "the rest are further out, or have none"}
              />
              <StatCard label="Without a full buyer" value={<span className={exposed.length ? "text-long" : ""}>{int(exposed.length)}</span>} sub="the book inside the close window holds less than the position" />
              <StatCard
                label="Closest liquidation"
                value={lead ? pct(lead.distance, 1) : "—"}
                sub={lead ? `${lead.base} ${lead.side} at ${price(lead.liq, lead.mark)}` : "nothing within 15%"}
                action={data.positions.length ? <ShareOnX kind="check" id={data.account} label="Share" /> : undefined}
              />
            </div>

            <Section title="Your positions, closest to liquidation first" hint={`Liquidation prices use the venue's single-market solve on your account's live health. The close window is the engine's maximum liquidation spread (${data.maxSpreadBps != null ? `${data.maxSpreadBps / 100}%` : "read from the engine"}), bounded by your bankruptcy price.`}>
              {!data.positions.length ? (
                <Empty>This account holds no dreamDEX perp position right now.</Empty>
              ) : (
                <div className="overflow-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Market</TableHead>
                        <TableHead>Side</TableHead>
                        <TableHead className="text-right">Size</TableHead>
                        <TableHead className="text-right">Mark</TableHead>
                        <TableHead className="text-right">Liquidation</TableHead>
                        <TableHead className="text-right">Away</TableHead>
                        <TableHead className="text-right">Close window</TableHead>
                        <TableHead className="text-right">Book there</TableHead>
                        <TableHead className="text-right">Covers</TableHead>
                        <TableHead className="text-right">Catch</TableHead>
                        <TableHead className="text-right">Verdict</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.positions.map((p) => (
                        <TableRow key={p.pool}>
                          <TableCell><Sym symbol={p.symbol} /></TableCell>
                          <TableCell><Tag tone={p.side === "long" ? "long" : "short"}>{p.side}</Tag></TableCell>
                          <TableCell className="num text-right">{qty(p.size)}</TableCell>
                          <TableCell className="num text-right">{price(p.mark)}</TableCell>
                          <TableCell className="num text-right">{p.liq ? price(p.liq, p.mark) : "—"}</TableCell>
                          <TableCell className="num text-right">{p.distance != null ? pct(p.distance, 1) : "—"}</TableCell>
                          <TableCell className="num text-right text-xs">{p.window ? `${price(p.window.lo, p.mark)} – ${price(p.window.hi, p.mark)}` : "—"}</TableCell>
                          <TableCell className="num text-right">{p.close ? usd(p.close.restingNotional) : "—"}</TableCell>
                          <TableCell className="num text-right">{p.close ? pct(p.close.coverage, 0) : "—"}</TableCell>
                          <TableCell className="text-right">
                            {p.catch?.orders ? <Tag tone="vault">{p.catch.citesYou ? "waiting for you" : `${p.catch.orders} order${p.catch.orders > 1 ? "s" : ""}`}</Tag> : <span className="text-muted-foreground">—</span>}
                          </TableCell>
                          <TableCell className="text-right"><Tag tone={VERDICT[p.verdict].tone}>{VERDICT[p.verdict].text}</Tag></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </Section>

            {exposed.length > 0 && (
              <Section title="What an empty window means for you" hint="The venue's liquidation waterfall, as its LiquidationEngine runs it.">
                <div className="grid gap-2 text-sm text-muted-foreground">
                  <p>
                    The engine sells a liquidated long into bids, and buys back a liquidated short from asks, never further than its window. What the window cannot absorb goes to a
                    backstop bidder at its own price, then to the insurance fund, then to auto-deleveraging, which force-closes profitable traders on the other side.
                  </p>
                  <p>
                    Catch rests orders inside these windows, sized from the whole market's liquidation map, and cancels them in the same block if the positions behind them change.
                    Depositors fund those orders. It stands first where the most liquidation size clusters on the busiest markets, so the windows it covers grow with the vault.
                  </p>
                </div>
              </Section>
            )}
          </>
        )}
      </div>
    </BaseLayout>
  )
}
