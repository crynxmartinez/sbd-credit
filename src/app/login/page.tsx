import { redirect } from "next/navigation";
import { LoginForm } from "@/components/LoginForm";
import { safeNextFor } from "@/lib/safe-next";
import { getCurrentCustomerUser } from "@/lib/server/auth/customer-session";
import { getCurrentUser } from "@/lib/server/auth/current-user";
import { log } from "@/lib/server/log";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in — Steel Building Depot", robots: { index: false, follow: false } };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const { next: rawNext } = await searchParams;
  // A repeated ?next= arrives as an array: take the first, which safeNextFor then checks like any other.
  const next = Array.isArray(rawNext) ? rawNext[0] : rawNext;

  let signedIn: "staff" | "customer" | null = null;
  let unavailable = false;
  try {
    if (await getCurrentUser()) signedIn = "staff";
    else if (await getCurrentCustomerUser()) signedIn = "customer";
  } catch (error) {
    // The database being down must not take the sign-in page with it: show it, and say what is wrong.
    log("error", "login.session_check_failed", { error });
    unavailable = true;
  }
  // Already signed in: go where this kind of person belongs (never a staff page for a customer, or the reverse).
  if (signedIn) redirect(safeNextFor(signedIn, next));

  return <LoginForm next={next} unavailable={unavailable} />;
}
