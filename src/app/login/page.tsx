import { redirect } from "next/navigation";
import { LoginForm } from "@/components/LoginForm";
import { safeNextFor } from "@/lib/safe-next";
import { getCurrentCustomerUser } from "@/lib/server/auth/customer-session";
import { getCurrentUser } from "@/lib/server/auth/current-user";
import { log } from "@/lib/server/log";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;

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
