"use client";

import "./legacy-tokens.css";
import "./app.css";

/**
 * The last line of defence: replaces the whole page when the root layout itself fails. It must bring its own
 * document and styles, because nothing above it has rendered.
 */
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="en">
      <head>
        <title>Something went wrong — Steel Building Depot</title>
      </head>
      <body>
        <main className="login-wrap">
          <div className="login-card" role="alert">
            <div className="login-brand">
              <div className="brand-name">
                STEEL BUILDING
                <br />
                DEPOT
              </div>
            </div>
            <div className="login-body">
              <h1 style={{ fontSize: 20, margin: 0 }}>Something went wrong</h1>
              <p style={{ margin: 0, color: "var(--text-dim)" }}>
                The app could not load. Your data has not been changed.
                {error.digest ? (
                  <>
                    {" "}
                    Reference: <span className="mono">{error.digest}</span>
                  </>
                ) : null}
              </p>
              <button type="button" className="btn btn-primary" onClick={() => retry()}>
                Try again
              </button>
            </div>
          </div>
        </main>
      </body>
    </html>
  );
}
