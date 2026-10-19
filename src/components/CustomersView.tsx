"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { ApiClientError } from "@/lib/client/api";
import { downloadFile } from "@/lib/client/download";
import { useCustomers } from "@/lib/client/queries";
import { replaceUrlParams } from "@/lib/client/url-state";
import {
  filterCustomers,
  isSortKey,
  sortCustomers,
  type SortDirection,
  type SortKey,
  type StatusFilter,
} from "@/lib/domain/customer-list";
import { CUSTOMER_STATUSES, STATUS_LABELS } from "@/lib/domain/constants";
import { can } from "@/lib/domain/roles";
import { CustomerTable } from "./CustomerTable";
import { DataStatus } from "./DataStatus";
import { DownloadIcon, PlusIcon, SearchIcon } from "./icons";
import { useToast } from "./Toast";
import { useUi } from "./ui-context";

const SEARCH_URL_DELAY_MS = 300;
/** The "N customers shown" announcement waits for typing to pause, so a screen reader is not interrupted at every keystroke. */
const ANNOUNCE_DELAY_MS = 800;
const FILTERS: ReadonlyArray<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "All" },
  ...CUSTOMER_STATUSES.map((status) => ({ value: status, label: STATUS_LABELS[status] })),
];

const SORT_LABELS: Record<SortKey, string> = { name: "business", status: "status", limit: "credit limit", balance: "balance", utilization: "utilization", nextDue: "next payment due" };

function isStatusFilter(value: string | null): value is StatusFilter {
  return value === "all" || (value !== null && (CUSTOMER_STATUSES as readonly string[]).includes(value));
}

function useSettled<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}

export function CustomersView() {
  const { user, openNew } = useUi();
  const notify = useToast();
  const [downloading, setDownloading] = useState<string | null>(null);

  async function download(kind: "customers" | "ledger") {
    if (downloading) return;
    setDownloading(kind);
    try {
      await downloadFile(`/api/export/${kind}`, `${kind}.csv`);
    } catch (caught) {
      notify(caught instanceof ApiClientError ? caught.message : "The download failed. Please try again.", "err");
    } finally {
      setDownloading(null);
    }
  }
  const searchParams = useSearchParams();
  const query = useCustomers();
  const { data, isLoading } = query;

  // Read from the address bar once, when the screen opens; after that this screen owns the state and writes it back.
  const initialStatus = searchParams.get("status");
  const initialSort = searchParams.get("sort");
  const [text, setText] = useState(searchParams.get("q") ?? "");
  const [status, setStatus] = useState<StatusFilter>(isStatusFilter(initialStatus) ? initialStatus : "all");
  const [sort, setSort] = useState<{ key: SortKey; direction: SortDirection }>({
    key: isSortKey(initialSort) ? initialSort : "name",
    direction: searchParams.get("dir") === "desc" ? "desc" : "asc",
  });

  // The filters as the address bar says them. When it changes for a reason that is NOT this screen writing it (the sidebar's
  // "Customers" link, Back, a pasted link), the screen follows it, so what is shown always matches the address.
  const paramsKey = `${searchParams.get("q") ?? ""}|${searchParams.get("status") ?? ""}|${searchParams.get("sort") ?? ""}|${searchParams.get("dir") ?? ""}`;
  const [seenKey, setSeenKey] = useState(paramsKey);
  const [writtenKey, setWrittenKey] = useState(paramsKey);
  if (paramsKey !== seenKey) {
    setSeenKey(paramsKey);
    if (paramsKey !== writtenKey) {
      const nextStatus = searchParams.get("status");
      const nextSort = searchParams.get("sort");
      setText(searchParams.get("q") ?? "");
      setStatus(isStatusFilter(nextStatus) ? nextStatus : "all");
      setSort({ key: isSortKey(nextSort) ? nextSort : "name", direction: searchParams.get("dir") === "desc" ? "desc" : "asc" });
      setWrittenKey(paramsKey);
    }
  }

  // Keep filters in the address bar so a filtered list can be shared or bookmarked. The open customer (?c=) is kept.
  useEffect(() => {
    const timer = setTimeout(() => {
      const next = {
        q: text.trim(),
        status: status === "all" ? null : status,
        sort: sort.key === "name" ? null : sort.key,
        dir: sort.direction === "asc" ? null : sort.direction,
      };
      setWrittenKey(`${next.q}|${next.status ?? ""}|${next.sort ?? ""}|${next.dir ?? ""}`);
      replaceUrlParams(next);
    }, SEARCH_URL_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text, status, sort]);

  const customers = data?.customers;
  const visible = useMemo(
    () => (customers ? sortCustomers(filterCustomers(customers, status, text), sort.key, sort.direction) : []),
    [customers, status, text, sort],
  );

  // Nothing is announced until the list has loaded: the count starts at 0, and "0 customers shown" is false.
  const shown = useSettled(customers ? visible.length : null, ANNOUNCE_DELAY_MS);

  const toggleSort = (key: SortKey) =>
    setSort((current) => ({ key, direction: current.key === key && current.direction === "asc" ? "desc" : "asc" }));

  const failed = query.isError && !data;
  const empty = customers && customers.length === 0;
  return (
    <div>
      <div className="topbar">
        <div>
          <h1 className="page-title">Customers</h1>
          <div className="page-sub">All credit applications and accounts.</div>
        </div>
        <div className="topbar-actions">
          {can(user.role, "export") ? (
            <>
              <button type="button" className="btn" onClick={() => download("customers")} disabled={downloading !== null}>
                <DownloadIcon /> {downloading === "customers" ? "Preparing…" : "Customers CSV"}
              </button>
              <button type="button" className="btn" onClick={() => download("ledger")} disabled={downloading !== null}>
                <DownloadIcon /> {downloading === "ledger" ? "Preparing…" : "Ledger CSV"}
              </button>
            </>
          ) : null}
          {can(user.role, "customer.create") ? (
            <button type="button" className="btn btn-primary" onClick={openNew}>
              <PlusIcon size={15} />
              New credit application
            </button>
          ) : null}
        </div>
      </div>

      <DataStatus what="customers" query={{ ...query, hasData: Boolean(data) }} />

      {failed ? null : (
        <>
          <div className="toolbar">
            <div className="search-box">
              <SearchIcon size={15} />
              <label htmlFor="customer-search" className="sr-only">
                Search customers
              </label>
              <input
                id="customer-search"
                type="search"
                placeholder="Search business, contact, email, phone…"
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
            </div>
            <div className="filter-pills" role="group" aria-label="Filter by status">
              {FILTERS.map((filter) => (
                <button
                  key={filter.value}
                  type="button"
                  className={`pill${status === filter.value ? " active" : ""}`}
                  aria-pressed={status === filter.value}
                  onClick={() => setStatus(filter.value)}
                >
                  {filter.label}
                </button>
              ))}
            </div>
          </div>

          <div className="sr-only" role="status">
            {customers && shown !== null ? `${shown} ${shown === 1 ? "customer" : "customers"} shown, sorted by ${SORT_LABELS[sort.key]}, ${sort.direction === "asc" ? "ascending" : "descending"}` : ""}
          </div>

          {empty ? (
            <div className="empty-state">
              <h2>No customers yet</h2>
              <p>Add your first credit application to start tracking approvals, credit limits, and payment reminders.</p>
              {can(user.role, "customer.create") ? (
                <button type="button" className="btn btn-primary" onClick={openNew} style={{ marginTop: 12 }}>
                  <PlusIcon size={15} />
                  New credit application
                </button>
              ) : null}
            </div>
          ) : (
            <>
              <CustomerTable customers={visible} variant="full" loading={isLoading} sort={sort} onSort={toggleSort} caption="All customers" />
              {customers && visible.length === 0 ? (
                <div className="empty-state">
                  <h2>No matches</h2>
                  <p>Try a different search or filter.</p>
                </div>
              ) : null}
            </>
          )}
        </>
      )}
    </div>
  );
}
