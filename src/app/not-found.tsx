import Link from "next/link";

export const metadata = { title: "Page not found — Steel Building Depot" };

export default function NotFound() {
  return (
    <main className="login-wrap">
      <div className="login-card">
        <div className="login-brand">
          <div className="brand-name">
            STEEL BUILDING
            <br />
            DEPOT
          </div>
        </div>
        <div className="login-body">
          <h1 style={{ fontSize: 20, margin: 0 }}>Page not found</h1>
          <p style={{ margin: 0, color: "var(--text-dim)" }}>That page does not exist, or the link is out of date.</p>
          <Link href="/" className="btn btn-primary">
            Go to the dashboard
          </Link>
        </div>
      </div>
    </main>
  );
}
