import { Outlet, useNavigation } from "react-router-dom"

import { LoadingSpinner } from "@/components/ui/loading-spinner"

/** Thin top bar shown while the next route's code is loading. */
function RouteProgress() {
  return (
    <div
      role="progressbar"
      aria-label="Loading page"
      className="route-progress fixed inset-x-0 top-0 z-50 h-0.5 overflow-hidden bg-primary/15"
    >
      <div className="route-progress-bar h-full w-1/3 bg-primary" />
    </div>
  )
}

export function RootLayout() {
  const navigation = useNavigation()
  return (
    <>
      {navigation.state === "loading" && <RouteProgress />}
      <Outlet />
    </>
  )
}

/** Shown on the very first load, before any route has rendered. */
export function RootFallback() {
  return (
    <div className="flex min-h-svh items-center justify-center">
      <LoadingSpinner />
    </div>
  )
}
