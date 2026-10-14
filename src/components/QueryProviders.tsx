"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

// A little under the 30 second poll: switching tabs and back does not refetch what was fetched moments ago.
const STALE_MS = 20_000;

/** The staff app's data cache. Customer pages never load it: they are rendered on the server and use no queries. */
export function QueryProviders({ children }: { children: ReactNode }) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { staleTime: STALE_MS, retry: 1, refetchOnWindowFocus: true } } }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
