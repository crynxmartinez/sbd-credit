"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { todayISO } from "@/lib/domain/dates";
import type { CustomerDetail, CustomerListDto } from "@/lib/types";
import type { CustomerCreateInput, CustomerUpdateInput, DecisionInput, LedgerEntryInput } from "@/lib/validation";
import { apiFetch } from "./api";

/** Data refreshes on focus and on this interval, which is how teammates see each other's changes. */
const REFRESH_MS = 30_000;

/** The customer list, with the business day its figures were computed for. The dashboard is derived from this same data. */
export function useCustomers() {
  return useQuery({
    queryKey: ["customers"],
    queryFn: () => apiFetch<CustomerListDto>("/api/customers"),
    refetchInterval: REFRESH_MS,
    // A failed refresh keeps showing the last good data (with a notice) instead of blanking the screen.
    placeholderData: keepPreviousData,
  });
}

/**
 * "Today" for filling in dates: the business day the server computed the figures for. A form that used the browser's own
 * date would, for anyone in a time zone ahead of the books, record entries dated "tomorrow" that do not yet count.
 * Until the list has loaded, the browser's date is the best available guess.
 */
export function useBusinessToday(): string {
  const { data } = useCustomers();
  return data?.asOf ?? todayISO();
}

export function useCustomerDetail(id: string | null) {
  return useQuery({
    queryKey: ["customer", id],
    queryFn: () => apiFetch<CustomerDetail>(`/api/customers/${encodeURIComponent(id ?? "")}`),
    enabled: id !== null,
    refetchInterval: REFRESH_MS,
  });
}

/** After any write, every view that could show the change is refetched, whether the write worked or not. */
function useRefreshAll() {
  const client = useQueryClient();
  return () =>
    Promise.all([
      client.invalidateQueries({ queryKey: ["customers"] }),
      client.invalidateQueries({ queryKey: ["customer"] }),
    ]);
}

const customerPath = (id: string) => `/api/customers/${encodeURIComponent(id)}`;

export function useCreateCustomer() {
  const refresh = useRefreshAll();
  return useMutation({
    mutationFn: (input: CustomerCreateInput) => apiFetch<{ id: string }>("/api/customers", { method: "POST", body: input }),
    onSettled: refresh,
  });
}

export function useUpdateCustomer(id: string) {
  const refresh = useRefreshAll();
  return useMutation({
    mutationFn: (input: CustomerUpdateInput) => apiFetch(customerPath(id), { method: "PATCH", body: input }),
    onSettled: refresh,
  });
}

export function useDecision(id: string) {
  const refresh = useRefreshAll();
  return useMutation({
    mutationFn: (input: DecisionInput) => apiFetch(`${customerPath(id)}/decision`, { method: "POST", body: input }),
    onSettled: refresh,
  });
}

export function useRecordEntry(id: string) {
  const refresh = useRefreshAll();
  return useMutation({
    mutationFn: (input: LedgerEntryInput) =>
      apiFetch<{ id: string; warning: "over_limit" | "overpayment" | null; duplicate: boolean; postDated: boolean }>(`${customerPath(id)}/ledger`, {
        method: "POST",
        body: input,
      }),
    onSettled: refresh,
  });
}

export function useVoidEntry(id: string) {
  const refresh = useRefreshAll();
  return useMutation({
    mutationFn: (input: { entryId: string; reason: string }) =>
      apiFetch(`${customerPath(id)}/ledger/${encodeURIComponent(input.entryId)}/void`, {
        method: "POST",
        body: { reason: input.reason },
      }),
    onSettled: refresh,
  });
}
