import * as React from "react"
import { LayoutDashboard, Vault, ChartColumn, Rows3, ArrowDownToLine, FileCode2, ArrowLeft, Send } from "lucide-react"
import { Logo } from "@/components/logo"
import { NavMain } from "@/components/nav-main"
import { useCatch } from "@/lib/api"
import { int } from "@/lib/format"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"

const navGroups = [
  {
    label: "Catch",
    items: [
      { title: "Overview", url: "/", icon: LayoutDashboard },
      { title: "Vault", url: "/vault", icon: Vault },
    ],
  },
  {
    label: "Venue data",
    items: [
      { title: "Liquidation map", url: "/map", icon: ChartColumn },
      { title: "Markets", url: "/markets", icon: Rows3 },
      { title: "Liquidations", url: "/liquidations", icon: ArrowDownToLine },
      { title: "Contracts", url: "/contracts", icon: FileCode2 },
    ],
  },
]

function ChainStatus() {
  const status = useCatch((s) => s.status)
  const seen = useCatch((s) => s.headSeenAt)
  const error = useCatch((s) => s.error)
  const stale = !status?.head || Date.now() - seen > 90_000
  return (
    <div className="grid gap-1 rounded-lg border border-sidebar-border bg-sidebar-accent/40 p-3 text-xs">
      <div className="flex items-center gap-2 text-sidebar-foreground">
        <span className={`size-1.5 rounded-full ${error ? "bg-destructive" : stale ? "bg-warning" : "bg-success"}`} />
        <span>{status?.network.label ?? "Connecting"}</span>
      </div>
      <div className="num text-muted-foreground">
        {error ? "engine not answering" : status?.head ? `block ${int(status.head)}${stale ? " · not moving" : ""}` : "reading chain"}
      </div>
    </div>
  )
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  return (
    <Sidebar {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" render={<a href="/" aria-label="Catch home page" />}>
              <div className="flex aspect-square size-8 items-center justify-center text-primary">
                <Logo size={28} />
              </div>
              <div className="grid flex-1 text-left leading-tight">
                <span className="truncate text-base font-medium" style={{ fontFamily: "var(--font-display)" }}>
                  Catch
                </span>
                <span className="truncate text-xs text-muted-foreground">Liquidation backstop</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {navGroups.map((group) => (
          <NavMain key={group.label} label={group.label} items={group.items} />
        ))}
      </SidebarContent>
      <SidebarFooter>
        <ChainStatus />
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton render={<a href="https://t.me/catch_liquidation" target="_blank" rel="noreferrer" />}>
              <Send />
              <span>Live alerts on Telegram</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton render={<a href="/" />}>
              <ArrowLeft />
              <span>Back to site</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}
