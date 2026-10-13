"use client";

interface QueryLike {
  isError: boolean;
  error: Error | null;
  dataUpdatedAt: number;
  hasData: boolean;
  refetch: () => unknown;
}

function clock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/**
 * Says so when the data on screen is not fresh. A failed load with nothing to show is an error, never "no customers";
 * a failed refresh keeps the last good data and tells the person how old it is.
 */
export function DataStatus({ what, query }: { what: string; query: QueryLike }) {
  if (!query.isError) return null;
  const detail = query.error?.message ?? "";
  return (
    <div className="conn-note err" role="alert">
      <span>
        {query.hasData
          ? `Couldn't refresh ${what}. Showing what was loaded at ${clock(query.dataUpdatedAt)}.`
          : `Couldn't load ${what}.`}{" "}
        {detail}
      </span>
      <button type="button" className="btn btn-sm" onClick={() => query.refetch()}>
        Retry
      </button>
    </div>
  );
}
