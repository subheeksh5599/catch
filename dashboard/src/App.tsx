import * as React from "react"
import { createHashRouter, RouterProvider } from "react-router-dom"
import { ThemeProvider } from "@/components/theme-provider"
import { SidebarConfigProvider } from "@/contexts/sidebar-context"
import { Toaster } from "@/components/ui/toast"
import { RootFallback, RootLayout } from "@/components/router/root-layout"
import { startPolling } from "@/lib/api"
import OverviewPage from "@/pages/overview"
import VaultPage from "@/pages/vault"
import MapPage from "@/pages/map"
import MarketsPage from "@/pages/markets"
import LiquidationsPage from "@/pages/liquidations"
import ContractsPage from "@/pages/contracts"

// Hash routes (/app/#/vault) so any static host serves every page without rewrite rules.
const router = createHashRouter([
  {
    element: <RootLayout />,
    HydrateFallback: RootFallback,
    children: [
      { path: "/", element: <OverviewPage /> },
      { path: "/vault", element: <VaultPage /> },
      { path: "/map", element: <MapPage /> },
      { path: "/markets", element: <MarketsPage /> },
      { path: "/liquidations", element: <LiquidationsPage /> },
      { path: "/contracts", element: <ContractsPage /> },
      { path: "*", element: <OverviewPage /> },
    ],
  },
])

export default function App() {
  React.useEffect(() => startPolling(), [])
  return (
    <ThemeProvider defaultTheme="dark" storageKey="catch-theme">
      <SidebarConfigProvider>
        <Toaster>
          <RouterProvider router={router} />
        </Toaster>
      </SidebarConfigProvider>
    </ThemeProvider>
  )
}
