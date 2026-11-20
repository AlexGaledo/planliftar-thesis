/**
 * Providers + router.
 *
 * - TanStack Query owns server state (health checks, job polling). Retries are
 *   kept low: a dead laptop server should surface an error quickly at a demo.
 * - The router is a data router (createBrowserRouter) so each route can lazy-load
 *   its own chunk; three.js, Recharts and model-viewer only download when needed.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router-dom";
import { router } from "./router";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 10_000 },
  },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} future={{ v7_startTransition: true }} />
    </QueryClientProvider>
  );
}
