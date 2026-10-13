"use client";

import { useEffect } from "react";

/**
 * Shown when something throws while rendering. Used by the app-level and root error boundaries. It keeps the person
 * oriented: what happened, that their data is safe, and a reference that finds the full detail in the server log.
 */
export default function ErrorPanel({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    // The server already logged the full detail under this digest; the browser only leaves a trace for support.
    console.error("Screen failed to render", error.digest ?? error.message);
  }, [error]);

  return (
    <div className="empty-state" role="alert">
      <h1 style={{ fontSize: 22 }}>Something went wrong</h1>
      <p>This screen could not be shown. Your data has not been changed.</p>
      {error.digest ? (
        <p style={{ marginTop: 10 }}>
          If it keeps happening, tell support this reference: <span className="mono">{error.digest}</span>
        </p>
      ) : null}
      <div className="action-row" style={{ justifyContent: "center", marginTop: 18 }}>
        <button type="button" className="btn btn-primary" onClick={() => retry()}>
          Try again
        </button>
      </div>
    </div>
  );
}
