import * as React from "react"
import { Moon, Sun, Wallet as WalletIcon } from "lucide-react"
import { useLocation } from "react-router-dom"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { useTheme } from "@/hooks/use-theme"
import { useCatch } from "@/lib/api"
import { short } from "@/lib/format"
import { toast } from "@/components/ui/toast"

const TITLES: Record<string, string> = {
  "/": "Overview",
  "/vault": "Vault",
  "/map": "Liquidation map",
  "/markets": "Markets",
  "/liquidations": "Liquidations",
  "/contracts": "Contracts",
}

function ModeToggle() {
  const { theme, setTheme } = useTheme()
  const dark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches)
  return (
    <Button variant="ghost" size="icon" onClick={() => setTheme(dark ? "light" : "dark")} aria-label={`Switch to ${dark ? "light" : "dark"} mode`}>
      {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  )
}

export function ConnectButton() {
  const wallet = useCatch((s) => s.wallet)
  useCatch((s) => s.walletTick)
  const [busy, setBusy] = React.useState(false)
  return (
    <Button
      variant={wallet?.account ? "outline" : "default"}
      size="sm"
      disabled={busy || !wallet}
      onClick={async () => {
        if (!wallet || wallet.account) return
        setBusy(true)
        try {
          await wallet.connect()
        } catch (e: any) {
          toast.add({ title: "Wallet", description: e?.message ?? String(e), type: "error" })
        } finally {
          setBusy(false)
        }
      }}
    >
      <WalletIcon className="size-4" />
      <span className="num">{wallet?.account ? short(wallet.account) : "Connect wallet"}</span>
    </Button>
  )
}

export function SiteHeader() {
  const { pathname } = useLocation()
  const status = useCatch((s) => s.status)
  return (
    <header className="flex h-(--header-height) shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-(--header-height)">
      <div className="flex w-full items-center gap-1 px-4 py-3 lg:gap-2 lg:px-6">
        <SidebarTrigger className="-ml-1" />
        <Separator orientation="vertical" className="mx-2 data-vertical:self-center data-vertical:h-4" />
        <h1 className="text-base font-medium">{TITLES[pathname] ?? "Catch"}</h1>
        <span className="hidden text-sm text-muted-foreground md:inline">{status ? `dreamDEX perps on ${status.network.label}` : ""}</span>
        <div className="ml-auto flex items-center gap-2">
          <ModeToggle />
          <ConnectButton />
        </div>
      </div>
    </header>
  )
}
