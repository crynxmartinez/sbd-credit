import { redirect } from "next/navigation";
import { LoginForm } from "@/components/LoginForm";
import { safeNextPath } from "@/lib/safe-next";
import { getCurrentUser } from "@/lib/server/auth/current-user";
import { log } from "@/lib/server/log";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const destination = safeNextPath((await searchParams).next);

  let signedIn = false;
  let unavailable = false;
  try {
    signedIn = (await getCurrentUser()) !== null;
  } catch (error) {
    // The database being down must not take the sign-in page with it: show it, and say what is wrong.
    log("error", "login.session_check_failed", { error });
    unavailable = true;
  }
  if (signedIn) redirect(destination);

  return <LoginForm next={destination} unavailable={unavailable} />;
}
