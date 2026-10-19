"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

// A little under the 30 second poll: switching tabs and back does not refetch what was fetched moments ago.
const STALE_MS = 20_000;

/** The staff app's data cache. Customer pages never load it: they are rendered on the server and use no queries. */
export function QueryProviders({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          // "always": run the request even when the browser believes it is offline. The default ("online") PAUSES a request until the
          // network returns, with no timeout and no error: a payment would sit at "Saving…", the person would close the form and
          // enter it again, and both would be sent when the connection came back. Running it lets apiFetch time out and say
          // "may or may not have been saved", and a stale list say how old it is.
          queries: { staleTime: STALE_MS, retry: 1, refetchOnWindowFocus: true, networkMode: "always" },
          mutations: { networkMode: "always" },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
