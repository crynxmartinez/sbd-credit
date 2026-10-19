"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { SESSION_EXPIRED_EVENT } from "@/lib/client/api";

/**
 * Shown when the server says the session has ended. The page is NOT left: what the person was typing is still on screen.
 * They sign in again in another tab, come back, and carry on. (Leaving at once would throw away a half-entered payment.)
 */
export function SessionExpiredBanner() {
  const client = useQueryClient();
  const [expired, setExpired] = useState(false);
  const bannerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onExpired = () => setExpired(true);
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, []);

  // The overlays start BELOW the banner (see --banner-h in app.css), so it never covers a dialog's header or Close button.
  useEffect(() => {
    const root = document.documentElement;
    const node = bannerRef.current;
    if (!expired || !node) {
      root.style.removeProperty("--banner-h");
      return;
    }
    const update = () => root.style.setProperty("--banner-h", `${node.offsetHeight}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--banner-h");
    };
  }, [expired]);

  if (!expired) return null;
  const here = `${window.location.pathname}${window.location.search}`;
  return (
    <div ref={bannerRef} className="session-banner" role="alert" data-dialog-companion>
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
