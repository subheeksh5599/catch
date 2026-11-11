import * as React from "react"
import { AppSidebar } from "@/components/app-sidebar"
import { SiteHeader } from "@/components/site-header"
import { useSidebarConfig } from "@/hooks/use-sidebar-config"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"

export function BaseLayout({ children, description }: { children: React.ReactNode; description?: React.ReactNode }) {
  const { config } = useSidebarConfig()
  return (
    <SidebarProvider
      style={
        {
          "--sidebar-width": "16rem",
          "--sidebar-width-icon": "3rem",
          "--header-height": "calc(var(--spacing) * 14)",
        } as React.CSSProperties
      }
    >
      <AppSidebar variant={config.variant} collapsible={config.collapsible} side={config.side} />
      <SidebarInset>
        <SiteHeader />
        <div className="@container/main flex flex-1 flex-col">
          <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
            {description && <p className="px-4 text-sm text-muted-foreground lg:px-6">{description}</p>}
            {children}
          </div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
