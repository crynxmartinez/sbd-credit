import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { AppShell } from "@/components/AppShell";
import { getCurrentUser } from "@/lib/server/auth/current-user";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: Readonly<{ children: ReactNode }>) {
  const user = await getCurrentUser();
  if (!user) {
    // Bring them back here after signing in. The login page checks this is a path on this site before using it.
    const here = (await headers()).get("x-pathname");
    redirect(here ? `/login?next=${encodeURIComponent(here)}` : "/login");
  }

  return (
    <Suspense fallback={null}>
      <AppShell user={user}>{children}</AppShell>
    </Suspense>
  );
}
