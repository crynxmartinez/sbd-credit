"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
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
import { useUi } from "./ui-context";

const SEARCH_URL_DELAY_MS = 300;
const FILTERS: ReadonlyArray<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "All" },
  ...CUSTOMER_STATUSES.map((status) => ({ value: status, label: STATUS_LABELS[status] })),
];

function isStatusFilter(value: string | null): value is StatusFilter {
  return value === "all" || (value !== null && (CUSTOMER_STATUSES as readonly string[]).includes(value));
}

export function CustomersView() {
  const { user, openNew } = useUi();
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

  // Keep filters in the address bar so a filtered list can be shared or bookmarked. The open customer (?c=) is kept.
  useEffect(() => {
    const timer = setTimeout(() => {
      replaceUrlParams({
        q: text.trim(),
        status: status === "all" ? null : status,
        sort: sort.key === "name" ? null : sort.key,
        dir: sort.direction === "asc" ? null : sort.direction,
      });
    }, SEARCH_URL_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text, status, sort]);

  const customers = data?.customers;
  const visible = useMemo(
    () => (customers ? sortCustomers(filterCustomers(customers, status, text), sort.key, sort.direction) : []),
    [customers, status, text, sort],
  );

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
              <a className="btn" href="/api/export/customers" download>
                <DownloadIcon /> Customers CSV
              </a>
              <a className="btn" href="/api/export/ledger" download>
                <DownloadIcon /> Ledger CSV
              </a>
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
            {customers ? `${visible.length} ${visible.length === 1 ? "customer" : "customers"} shown` : ""}
          </div>

          {empty ? (
            <div className="empty-state">
              <h2>No customers yet</h2>
              <p>Add your first credit application to start tracking approvals, credit limits, and payment reminders.</p>
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
