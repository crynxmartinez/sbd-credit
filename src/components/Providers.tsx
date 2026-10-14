"use client";

import type { ReactNode } from "react";
import { ToastProvider } from "./Toast";

/** What every page needs. The staff app's data library is added only inside the staff layout, see QueryProviders. */
export function Providers({ children }: { children: ReactNode }) {
  return <ToastProvider>{children}</ToastProvider>;
}
