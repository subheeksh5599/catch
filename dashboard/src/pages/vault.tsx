import * as React from "react"
import { BaseLayout } from "@/components/layouts/base-layout"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { toast } from "@/components/ui/toast"
import { StatCard, Section, Reading, TxLink, AddrLink, Tag, Sym, Kv, Empty } from "@/components/catch/parts"
import { SharePriceChart } from "@/components/catch/charts"
import { useCatch, navPoints, roundTrips, type VaultState, type Deployment, type VaultEvent } from "@/lib/api"
import { calldata, toUnits, fromUnits } from "@/lib/wallet"
import { usd, qty, price, pct, int, short, fmtDelay } from "@/lib/format"

type Mine = { shares: bigint; assets: bigint; wallet: bigint; unlockAt: number } | null

function useMine(v: VaultState | null | undefined): [Mine, () => void] {
  const wallet = useCatch((s) => s.wallet)
  const tick = useCatch((s) => s.walletTick)
  const [mine, setMine] = React.useState<Mine>(null)
  const [n, setN] = React.useState(0)
  React.useEffect(() => {
    if (!wallet?.account || !v) {
      setMine(null)
      return
    }
    let off = false
    ;(async () => {
      try {
        const [sh, bal, un] = await Promise.all([
          wallet.call(v.address, calldata.balanceOf(wallet.account!)),
          wallet.call(v.asset, calldata.balanceOf(wallet.account!)),
          wallet.call(v.address, calldata.unlockAt(wallet.account!)).catch(() => "0x0"),
        ])
        const shares = BigInt(sh)
        const assets = shares ? BigInt(await wallet.call(v.address, calldata.convertToAssets(shares))) : 0n
        if (!off) setMine({ shares, assets, wallet: BigInt(bal), unlockAt: Number(BigInt(un)) * 1000 })
      } catch {
        if (!off) setMine(null)
      }
    })()
    return () => {
      off = true
    }
  }, [wallet?.account, v?.address, tick, n])
  return [mine, () => setN((x) => x + 1)]
}

function DepositRedeem({ v, mine, reload }: { v: VaultState; mine: Mine; reload: () => void }) {
  const wallet = useCatch((s) => s.wallet)
  useCatch((s) => s.walletTick)
  const refresh = useCatch((s) => s.refresh)
  const [mode, setMode] = React.useState<"deposit" | "redeem">("deposit")
  const [amt, setAmt] = React.useState("")
  const [busy, setBusy] = React.useState<string | null>(null)
  const locked = !!mine && mine.unlockAt > Date.now()
  const x = parseFloat(amt)
  const preview =
    !(x > 0)
      ? mode === "deposit"
        ? `USDso in, shares out at ${v.sharePrice.toFixed(4)} per 1,000`
        : "Shares in, USDso out at the current share price"
      : mode === "deposit"
        ? `${usd(x, { compact: false, digits: 2 })} USDso buys about ${qty((x / v.sharePrice) * 1000)} shares`
        : `${qty(x)} shares redeem for about ${usd((x * v.sharePrice) / 1000, { compact: false, digits: 2 })} USDso`
  const label = !wallet?.account ? "Connect wallet" : mode === "deposit" ? "Deposit USDso" : locked ? "Locked until the delay passes" : "Redeem shares"

  async function go() {
    if (!wallet) return
    try {
      if (!wallet.account) {
        await wallet.connect()
        return
      }
      const amount = toUnits(amt)
      if (!amount) {
        toast.add({ title: "Enter an amount", type: "warning" })
        return
      }
      if (mode === "deposit") {
        const allowance = BigInt(await wallet.call(v.asset, calldata.allowance(wallet.account, v.address)))
        if (allowance < amount) {
          setBusy("Approve USDso in your wallet")
          await wallet.send(v.asset, calldata.approve(v.address, amount))
        }
        setBusy("Confirm the deposit in your wallet")
        const h = await wallet.send(v.address, calldata.deposit(amount, wallet.account))
        toast.add({ title: "Deposited", description: `Transaction ${short(h)}`, type: "success" })
      } else {
        setBusy("Confirm the redemption in your wallet")
        const h = await wallet.send(v.address, calldata.redeem(amount, wallet.account))
        toast.add({ title: "Redeemed", description: `Transaction ${short(h)}`, type: "success" })
      }
      setAmt("")
      reload()
      refresh()
    } catch (e: any) {
      toast.add({ title: "Transaction not sent", description: e?.message ?? String(e), type: "error" })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Section title="Deposit or redeem" action={
      <Tabs value={mode} onValueChange={(m) => setMode(m as "deposit" | "redeem")}>
        <TabsList>
          <TabsTrigger value="deposit">Deposit</TabsTrigger>
          <TabsTrigger value="redeem">Redeem</TabsTrigger>
        </TabsList>
      </Tabs>
    } contentClassName="grid gap-4">
      <Input className="num h-12 text-xl" placeholder="0.00" inputMode="decimal" autoComplete="off" aria-label="Amount" value={amt} onChange={(e) => setAmt(e.target.value)} />
      <p className="text-sm text-muted-foreground">{preview}</p>
      <Kv
        rows={[
          ["In your wallet", mine ? `${usd(fromUnits(mine.wallet), { compact: false, digits: 2 })} USDso` : "—"],
          ["Your shares", mine ? qty(fromUnits(mine.shares)) : "—"],
        ]}
      />
      <div className="rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground">
        {locked
          ? `Your shares unlock at ${new Date(mine!.unlockAt).toLocaleString([], { hour: "numeric", minute: "2-digit", month: "short", day: "numeric" })}. The contract refuses a redemption or transfer before then.`
          : `A deposit locks your shares for ${fmtDelay(v.redeemDelaySeconds)}, so nobody can buy in just before a catch and leave just after it.`}
      </div>
      <Button size="lg" className="w-full" disabled={!!busy || !wallet || (!!wallet?.account && mode === "redeem" && locked)} onClick={go}>
        {busy ?? label}
      </Button>
      <p className="text-xs text-muted-foreground">
        Deposits go straight into the vault's own dreamDEX margin account. A redemption cancels resting orders if it needs their margin. There is no admin key.
      </p>
    </Section>
  )
}

function EarlierVaults({ v }: { v: VaultState }) {
  const rows = (v.retired || []).filter((r) => (r.performance?.deposited ?? 0) > 0)
  if (!rows.length) return null
  return (
    <div className="divide-y rounded-lg border">
      {rows.map((r) => {
        const p = r.performance!
        const back = p.redeemed + p.stillInside
        const res = back / p.deposited - 1
        return (
          <div key={r.tag} className="grid gap-1 p-3 text-sm">
            <div className="flex items-baseline justify-between gap-3">
              <span>
                Earlier vault <span className="font-mono text-xs text-muted-foreground">{r.tag}</span> <AddrLink address={r.vault} />
              </span>
              <b className={`num text-base font-medium ${res >= 0 ? "text-short" : "text-long"}`}>
                {res >= 0 ? "+" : ""}
                {pct(res, 1)}
                {r.lifetimeMs ? <span className="ml-1 text-xs font-normal text-muted-foreground">over {span(r.lifetimeMs)}</span> : null}
              </b>
            </div>
            <div className="text-muted-foreground">
              {usd(p.deposited, { compact: false, digits: 2 })} in, {usd(p.redeemed, { compact: false, digits: 2 })} paid back
              {p.stillInside > 0.01 ? <>, {usd(p.stillInside, { compact: false, digits: 2 })} still inside in open positions</> : " on redemption"}
            </div>
            {r.retired?.reason && <div className="text-xs text-muted-foreground">Replaced: {r.retired.reason}</div>}
            <div>
              <ShareOnX kind="vault" id={r.tag} label={`Share ${r.tag}'s result`} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

function Trades({ v, d }: { v: VaultState; d: Deployment | null | undefined }) {
  const rows = roundTrips(v, d)
  const closed = rows.filter((r) => r.c)
  const sum = closed.reduce((a, r) => a + r.c!.realizedPnl, 0)
  const won = closed.filter((r) => r.c!.realizedPnl > 0).length
  return (
    <Section
      title="Trades"
      hint={rows.length ? `${closed.length} closed, ${won} in profit, ${sum >= 0 ? "+" : ""}${usd(sum, { compact: false, digits: 2 })} realized, as the venue booked it` : undefined}
    >
      {!rows.length ? (
        <Empty>No fills yet on any vault.</Empty>
      ) : (
        <div className="max-h-96 overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Market</TableHead>
                <TableHead>Opened by</TableHead>
                <TableHead className="text-right">Size</TableHead>
                <TableHead className="text-right">Entry</TableHead>
                <TableHead className="text-right">Realized</TableHead>
                <TableHead className="text-right">Tx</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(({ o, c }, i) => (
                <TableRow key={i}>
                  <TableCell>{o ? <Sym symbol={o.base ?? "?"} note={o.newSize < 0 ? "short" : "long"} /> : "—"}</TableCell>
                  <TableCell>{o ? o.kind === "liquidation" ? <Tag tone="vault">Liquidation</Tag> : <span className="text-muted-foreground">Taker order</span> : <span className="text-muted-foreground">before the record</span>}</TableCell>
                  <TableCell className="num text-right">{o ? qty(Math.abs(o.newSize)) : "—"}</TableCell>
                  <TableCell className="num text-right">{o ? price(o.avgEntry) : "—"}</TableCell>
                  <TableCell className={`num text-right ${c ? (c.realizedPnl >= 0 ? "text-short" : "text-long") : "text-muted-foreground"}`}>
                    {c ? `${c.realizedPnl >= 0 ? "+" : ""}${usd(c.realizedPnl, { compact: false, digits: 4 })}` : "no close recorded"}
                  </TableCell>
                  <TableCell className="text-right">{c ? <TxLink hash={c.tx} /> : o ? <TxLink hash={o.tx} /> : null}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Section>
  )
}

export function Proofs({ d }: { d: Deployment | null | undefined }) {
  const status = useCatch((s) => s.status)
  const ev = (d?.evidence || []).filter((e) => e.status === "proven")
  const pick = ["catch", "auto-cancel", "fill", "refusal", "redeem"]
    .map((k) => {
      const list = ev.filter((e) => e.kind === k).sort((a, b) => (b.block ?? 0) - (a.block ?? 0))
      return list.length ? { e: list[0], n: list.length } : null
    })
    .filter((x): x is NonNullable<typeof x> => !!x)
  return (
    <Section title="Live proofs" hint={status ? `by transaction, on ${status.network.label}` : undefined}>
      {!pick.length ? (
        <Empty>The keeper records proofs here as they land on chain.</Empty>
      ) : (
        <div className="max-h-96 divide-y overflow-y-auto overscroll-contain pr-1">
          {pick.map(({ e, n }) => (
            <div key={e.kind} className="grid gap-2 py-3 first:pt-0 last:pb-0">
              <div className="flex items-baseline justify-between gap-3">
                <b className="text-sm font-medium">{e.title}</b>
                <span className="flex shrink-0 items-center gap-2">
                  {e.kind === "catch" && e.txs?.[0] && <ShareOnX kind="catch" id={e.txs[0].tx} />}
                  <Tag tone="ok">{n > 1 ? `Proven ${n}×` : "Proven"}</Tag>
                </span>
              </div>
              <p className="text-sm text-muted-foreground">{e.detail}</p>
              {(e.txs || []).map((t) => (
                <div key={t.tx} className="flex justify-between gap-3 text-xs text-muted-foreground">
                  <span>{t.label}</span>
                  <TxLink hash={t.tx} />
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </Section>
  )
}

const EV_LABEL: Record<string, string> = { Placed: "Order placed", Released: "Order released", Caught: "Position caught", Unwinding: "Unwind resting", Deposited: "Deposit", Redeemed: "Redemption" }
const REASON = ["", "filled", "a backer moved out of the window", "replaced by a larger cluster", "freed for a redemption", "repriced", "mark off the index"]

function detailOf(e: VaultEvent) {
  const a = e.args
  switch (e.event) {
    case "Deposited":
      return `${usd(Number(a.assets) / 1e18, { compact: false, digits: 2 })} by ${short(a.owner)}`
    case "Redeemed":
      return `${usd(Number(a.assets) / 1e18, { compact: false, digits: 2 })} to ${short(a.owner)}`
    case "Placed":
      return `${a.isBid ? "Bid" : "Ask"} at ${price(Number(a.price) / 1e18)}, ${a.backers?.length ?? 0} account${a.backers?.length > 1 ? "s" : ""} cited`
    case "Released":
      return `Slot #${a.slotId}, ${REASON[Number(a.reason)] || a.reason}`
    case "Caught":
      return `Position now ${a.newSize} at ${price(Number(a.avgEntryPrice) / 1e18)}`
    case "Unwinding":
      return `${a.isBid ? "Bid" : "Ask"} at ${price(Number(a.price) / 1e18)}`
    default:
      return ""
  }
}

export default function VaultPage() {
  const vault = useCatch((s) => s.vault)
  const v = vault?.state
  const d = vault?.deployment
  const [mine, reload] = useMine(v)
  const wallet = useCatch((s) => s.wallet)

  if (!vault) {
    return (
      <BaseLayout>
        <div className="px-4 lg:px-6">
          <Reading title="Reading the vault" />
        </div>
      </BaseLayout>
    )
  }
  if (!v) {
    return (
      <BaseLayout>
        <div className="px-4 lg:px-6">
          <Empty>No vault on this network. Deploy one with npm run deploy in engine/.</Empty>
        </div>
      </BaseLayout>
    )
  }
  const orders = v.markets.flatMap((m) => m.slots.map((s) => ({ ...s, m })))
  const capOf = (m: VaultState["markets"][number]) => Math.min((v.totalAssets * v.marketCapBps) / 10000, m.oiCap ?? Infinity)
  const locked = !!mine && mine.unlockAt > Date.now()

  return (
    <BaseLayout description={<>Vault <AddrLink address={v.address} full /></>}>
      <div className="grid grid-cols-1 gap-4 px-4 @xl/main:grid-cols-2 @5xl/main:grid-cols-4 lg:px-6">
        <StatCard label="Vault assets" value={usd(v.totalAssets, { compact: false, digits: 2 })} sub="Idle, bank equity and locked margin" />
        <StatCard label="Share price" value={v.sharePrice.toFixed(4)} sub={`USDso per 1,000 shares · ${qty(v.totalSupply)} shares`} />
        <StatCard label="Free to withdraw" value={usd(v.free, { compact: false, digits: 2 })} sub={`${usd(v.locked, { compact: false, digits: 2 })} locked behind ${orders.length} order${orders.length === 1 ? "" : "s"}`} />
        <StatCard
          label="Your position"
          value={mine ? usd(fromUnits(mine.assets), { compact: false, digits: 2 }) : null}
          reading="Connect a wallet"
          sub={mine ? `${qty(fromUnits(mine.shares))} shares${locked ? ` · unlocks ${new Date(mine.unlockAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}` : "To see your shares"}
          action={mine && mine.shares > 0n && wallet?.account ? <ShareOnX kind="depositor" id={wallet.account} label="Share" /> : undefined}
        />
      </div>

      <div className="grid gap-4 px-4 lg:grid-cols-[1fr_1.3fr] lg:px-6">
        <DepositRedeem v={v} mine={mine} reload={reload} />
        <Section title="Share price" hint="read by the keeper at head, per 1,000 shares" contentClassName="grid gap-4">
          <SharePriceChart points={navPoints(v)} />
          <EarlierVaults v={v} />
        </Section>
      </div>

      <div className="grid items-start gap-4 px-4 lg:grid-cols-[2fr_1fr] lg:px-6">
        <div className="grid min-w-0 gap-4">
          <Trades v={v} d={d} />
          <Section title="Exposure by market" hint={`limit is the lower of ${v.marketCapBps / 100}% of assets and ${v.oiCapBps != null ? `${v.oiCapBps / 100}% of open interest` : "the market cap"}`}>
            {!v.markets.length ? (
              <Empty>No market quoted yet.</Empty>
            ) : (
              <div className="grid gap-3">
                {v.markets
                  .slice()
                  .sort((a, b) => b.exposure - a.exposure)
                  .map((m) => {
                    const cap = capOf(m)
                    const ps = m.price?.status
                    return (
                      <div key={m.pool} className="grid grid-cols-[96px_1fr_auto] items-center gap-3 text-sm sm:grid-cols-[110px_1fr_170px_150px]">
                        <Sym symbol={m.symbol} />
                        <Progress value={Math.min(100, (m.exposure / (cap || 1)) * 100)} />
                        <span className="num text-right">
                          {usd(m.exposure, { compact: false, digits: 2 })} <span className="text-muted-foreground">of {usd(cap, { compact: false, digits: 0 })}</span>
                        </span>
                        <span className={`hidden text-right text-xs sm:block ${ps === 0 ? "text-muted-foreground" : "text-vault"}`}>
                          {ps == null ? "" : ps === 0 ? "price checks out" : ps === 1 ? "index stale, paused" : "mark off index, paused"}
                        </span>
                      </div>
                    )
                  })}
              </div>
            )}
          </Section>
          <Section title="Resting orders" hint="on the venue's book now">
            {!orders.length ? (
              <Empty>No orders resting. The keeper quotes markets with a reachable cluster above the venue minimum.</Empty>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Market</TableHead>
                    <TableHead>Kind</TableHead>
                    <TableHead className="text-right">Price</TableHead>
                    <TableHead className="text-right">Notional</TableHead>
                    <TableHead className="text-right">Accounts cited</TableHead>
                    <TableHead className="text-right">Slot</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {orders.map((o) => (
                    <TableRow key={o.id}>
                      <TableCell>
                        <Sym symbol={o.m.symbol} />
                      </TableCell>
                      <TableCell>{o.unwind ? <Tag tone="vault">Unwind</Tag> : o.side === "bid" ? <Tag tone="long">Bid under longs</Tag> : <Tag tone="short">Ask over shorts</Tag>}</TableCell>
                      <TableCell className="num text-right">{price(o.price)}</TableCell>
                      <TableCell className="num text-right">{o.notional != null ? usd(o.notional, { compact: false, digits: 2 }) : "—"}</TableCell>
                      <TableCell className="num text-right">{o.backers.length}</TableCell>
                      <TableCell className="num text-right font-mono text-xs text-muted-foreground">#{o.id}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Section>
          <Section title="Activity" hint="the vault's own events">
            {!vault.events.length ? (
              <Empty>No events yet.</Empty>
            ) : (
              <div className="max-h-96 overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Event</TableHead>
                      <TableHead>Detail</TableHead>
                      <TableHead className="text-right">Block</TableHead>
                      <TableHead className="text-right">Tx</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {vault.events
                      .filter((e) => EV_LABEL[e.event])
                      .slice(0, 60)
                      .map((e) => (
                        <TableRow key={`${e.tx}${e.event}${e.args.slotId ?? ""}`}>
                          <TableCell>{EV_LABEL[e.event]}</TableCell>
                          <TableCell className="text-muted-foreground">{detailOf(e)}</TableCell>
                          <TableCell className="num text-right font-mono text-xs text-muted-foreground">{int(e.block)}</TableCell>
                          <TableCell className="text-right">
                            <TxLink hash={e.tx} />
                          </TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </Section>
        </div>
        <div className="grid min-w-0 gap-4 lg:sticky lg:top-4 lg:max-h-[calc(100svh-2rem)] lg:overflow-y-auto lg:overscroll-contain lg:pr-1">
          {v.backstop && <Backstop b={v.backstop} vault={v.address} />}
          <Section title="What the contract enforces">
            <ol className="grid gap-3 text-sm">
              {[
                ["Caps", `One order stays under ${v.clusterCapBps / 100}% of assets; one market under ${v.marketCapBps / 100}%${v.oiCapBps != null ? ` and under ${v.oiCapBps / 100}% of that market's open interest` : ""}.`],
                ["Windows", "An order rests only while every account it cites can still be closed at its price. Reactivity re-checks on each of their position updates."],
                ["Entry", "A caught position is offered back at or past its entry, never below."],
                ["Exit", "Redemptions cancel resting orders to free margin. No other address can move funds."],
                ["Maker only", "Orders are post-only. The vault never takes liquidity and cannot liquidate anyone."],
                ...(v.maxIndexDeviationBps != null
                  ? [
                      ["Price check", `No quote while the mark is more than ${v.maxIndexDeviationBps / 100}% from the oracle index or the index is older than ${v.maxIndexAgeSeconds} seconds.`],
                      ["Lock", `New shares can't be redeemed or moved for ${fmtDelay(v.redeemDelaySeconds)}.`],
                    ]
                  : []),
                ...(v.backstop
                  ? [["Takeover", `Asked by the liquidation engine, it takes a whole position over at ${v.backstop.spreadBps / 100}% past the mark, under every cap above, or says no.`]]
                  : []),
              ].map(([t, dsc], i) => (
                <li key={t} className="grid grid-cols-[20px_1fr] gap-2">
                  <span className="num font-mono text-xs text-muted-foreground">{i + 1}</span>
                  <span className="text-muted-foreground">
                    <b className="font-medium text-foreground">{t}.</b> {dsc}
                  </span>
                </li>
              ))}
            </ol>
            <p className="mt-4 text-xs text-muted-foreground">
              Contract <AddrLink address={v.address} />
              {d?.deployTx && (
                <>
                  , deployed in <TxLink hash={d.deployTx} />
                </>
              )}
            </p>
          </Section>
          <Proofs d={d} />
        </div>
      </div>
    </BaseLayout>
  )
}

function Backstop({ b, vault }: { b: NonNullable<VaultState["backstop"]>; vault: string }) {
  const others = (b.bidders || []).filter((x) => x.toLowerCase() !== vault.toLowerCase())
  return (
    <Section title="Liquidation backstop">
      <div className="grid gap-3 text-sm">
        <div className="flex items-center gap-2">
          <span className={`inline-block size-2 rounded-full ${b.registered ? "bg-emerald-500" : "bg-amber-500"}`} />
          <span className="font-medium">{b.registered ? "Registered bidder" : b.registered === false ? "Built, waiting for registration" : "Status unavailable"}</span>
        </div>
        <p className="text-muted-foreground">
          When the order book can't absorb a liquidation, the engine offers the whole position to its registered bidders. Catch answers that call
          ({b.selector}) with a price {b.spreadBps / 100}% past the mark. On a fork of this chain the real engine handed Catch a BTC long,
          and picked Catch over the live bidder.
        </p>
        <p className="text-muted-foreground">
          Registration is a single owner-only transaction on the engine. {others.length} other bidder{others.length === 1 ? " is" : "s are"} registered today.
        </p>
        <a className="text-primary underline-offset-4 hover:underline" href="https://github.com/subheeksh5599/catch/blob/main/docs/stage4-backstop.md" target="_blank" rel="noreferrer">
          How it works and the transaction it needs
        </a>
      </div>
    </Section>
  )
}

/** A share link: the server builds the post and its card from records and chain reads only. */
export function ShareOnX({ kind, id, label = "Post on X" }: { kind: "catch" | "vault" | "depositor"; id: string; label?: string }) {
  const href = `/api/share?kind=${kind}&id=${encodeURIComponent(id)}&post=1`
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium text-foreground hover:bg-muted"
      title="Opens X with the post and a card built from on-chain data"
    >
      <svg viewBox="0 0 24 24" className="size-3" aria-hidden="true">
        <path fill="currentColor" d="M18.244 2H21.5l-7.5 8.57L23 22h-6.828l-5.35-6.99L4.6 22H1.34l8.02-9.17L1 2h7.002l4.835 6.39L18.244 2Zm-1.196 18h1.803L7.03 3.894H5.096L17.048 20Z" />
      </svg>
      {label}
    </a>
  )
}

/** A vault's running time in plain words: "15 hours", "12.5 days". */
function span(ms: number) {
  const h = ms / 3_600_000
  if (h < 48) return `${Math.max(1, Math.round(h))} hour${Math.round(h) === 1 ? "" : "s"}`
  return `${(h / 24).toFixed(1)} days`
}
