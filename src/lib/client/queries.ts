"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { todayISO } from "@/lib/domain/dates";
import type { CustomerDetail, CustomerListDto, PortalContactDto, PortalInviteResult } from "@/lib/types";
import type { CustomerCreateInput, CustomerUpdateInput, DecisionInput, LedgerEntryInput } from "@/lib/validation";
import { apiFetch } from "./api";

/** Data refreshes on focus and on this interval, which is how teammates see each other's changes. */
const REFRESH_MS = 30_000;

/**
 * The customer list, with the business day its figures were computed for. The dashboard is derived from this same data.
 *
 * Only the screen that SHOWS the list polls it. Everything else that reads it (a form wanting today's date, the open
 * drawer) passes `poll: false`: each reader sets its own timer, so without this an open drawer made the same request
 * three or four times every 30 seconds.
 */
export function useCustomers({ poll = true }: { poll?: boolean } = {}) {
  return useQuery({
    queryKey: ["customers"],
    queryFn: () => apiFetch<CustomerListDto>("/api/customers"),
    refetchInterval: poll ? REFRESH_MS : false,
    // The poll IS the retry: a second attempt straight after a slow or failed one doubles the load on a server that is struggling
    // (and the abandoned first request still runs to the end there).
    retry: poll ? false : 1,
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
  const { data } = useCustomers({ poll: false });
  return data?.asOf ?? todayISO();
}

/** The time zone the books are kept in, for showing a timestamp on the day the books say it happened. */
export function useBusinessTimeZone(): string {
  const { data } = useCustomers({ poll: false });
  return data?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function useCustomerDetail(id: string | null) {
  return useQuery({
    queryKey: ["customer", id],
    queryFn: () => apiFetch<CustomerDetail>(`/api/customers/${encodeURIComponent(id ?? "")}`),
    enabled: id !== null,
    refetchInterval: REFRESH_MS,
  });
}

/**
 * After any write, every view that could show the change is refetched, whether the write worked or not.
 *
 * The refresh runs in the background: it is NOT returned to the mutation, which would keep "Saving..." on screen for the
 * extra round trips of the refetch after the save itself had already succeeded.
 */
function useRefreshAll() {
  const client = useQueryClient();
  return () => {
    void Promise.all([
      client.invalidateQueries({ queryKey: ["customers"] }),
      client.invalidateQueries({ queryKey: ["customer"] }),
    ]);
  };
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

export function useReverseEntry(id: string) {
  const refresh = useRefreshAll();
  return useMutation({
    mutationFn: (input: { entryId: string; reason: string; requestKey: string }) =>
      apiFetch<{ id: string; duplicate: boolean }>(`${customerPath(id)}/ledger/${encodeURIComponent(input.entryId)}/reverse`, {
        method: "POST",
        body: { reason: input.reason, requestKey: input.requestKey },
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

/** The people at a customer who may sign in to the customer portal (admins only). */
export function usePortalContacts(customerId: string) {
  return useQuery({
    queryKey: ["portal-contacts", customerId],
    queryFn: () => apiFetch<PortalContactDto[]>(`${customerPath(customerId)}/portal`),
  });
}

function useRefreshContacts(customerId: string) {
  const client = useQueryClient();
  // In the background, like useRefreshAll: returning the promise kept "Creating…" on screen for the refetch after the link already
  // existed, and a person who closed the drawer in that moment lost a link that is shown only once.
  return () => {
    void Promise.all([client.invalidateQueries({ queryKey: ["portal-contacts", customerId] }), client.invalidateQueries({ queryKey: ["customer", customerId] })]);
  };
}

export function useInviteContact(customerId: string) {
  const refresh = useRefreshContacts(customerId);
  return useMutation({
    mutationFn: (input: { name: string; email: string }) => apiFetch<PortalInviteResult>(`${customerPath(customerId)}/portal`, { method: "POST", body: input }),
    onSettled: refresh,
    // The result holds the one-time link: do not keep it around once nothing is showing it.
    gcTime: 0,
  });
}

export function useReinviteContact(customerId: string) {
  const refresh = useRefreshContacts(customerId);
  return useMutation({
    mutationFn: (contactId: string) =>
      apiFetch<PortalInviteResult>(`${customerPath(customerId)}/portal/${encodeURIComponent(contactId)}/reinvite`, { method: "POST" }),
    onSettled: refresh,
    gcTime: 0,
  });
}

export function useSetContactActive(customerId: string) {
  const refresh = useRefreshContacts(customerId);
  return useMutation({
    mutationFn: (input: { contactId: string; active: boolean }) =>
      apiFetch<PortalContactDto>(`${customerPath(customerId)}/portal/${encodeURIComponent(input.contactId)}`, { method: "PATCH", body: { active: input.active } }),
    onSettled: refresh,
  });
}
