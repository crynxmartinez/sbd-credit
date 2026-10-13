"use client";

import { createContext, useContext } from "react";
import type { CustomerSummary, SessionUser } from "@/lib/types";

export interface UiActions {
  user: SessionUser;
  openNew: () => void;
  openEdit: (customer: CustomerSummary) => void;
  openCustomer: (id: string) => void;
}

export const UiContext = createContext<UiActions | null>(null);

export function useUi(): UiActions {
  const value = useContext(UiContext);
  if (!value) throw new Error("useUi must be used inside AppShell.");
  return value;
}
