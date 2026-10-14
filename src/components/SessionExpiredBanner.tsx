"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { SESSION_EXPIRED_EVENT } from "@/lib/client/api";

/**
 * Shown when the server says the session has ended. The page is NOT left: what the person was typing is still on screen.
 * They sign in again in another tab, come back, and carry on. (Leaving at once would throw away a half-entered payment.)
 */
export function SessionExpiredBanner() {
  const client = useQueryClient();
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    const onExpired = () => setExpired(true);
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, []);

  if (!expired) return null;
  const here = `${window.location.pathname}${window.location.search}`;
  return (
    <div className="session-banner" role="alert">
      <span>
        <b>Your session has ended.</b> Nothing you have typed here is lost. Sign in again in a new tab, then come back and carry on.
      </span>
      <span className="action-row">
        <a className="btn btn-sm btn-primary" href={`/login?next=${encodeURIComponent(here)}`} target="_blank" rel="noopener noreferrer">
          Sign in (new tab)
        </a>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            setExpired(false);
            void client.invalidateQueries();
          }}
        >
          I&apos;ve signed in
        </button>
      </span>
    </div>
  );
}
