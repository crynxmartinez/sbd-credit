import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { PortalShell } from "@/components/portal/PortalShell";
import { getCurrentCustomerUser } from "@/lib/server/auth/customer-session";
import { getCurrentUser } from "@/lib/server/auth/current-user";

export const dynamic = "force-dynamic";

export const metadata = { title: "My credit — Steel Building Depot", robots: { index: false, follow: false } };

export default async function PortalLayout({ children }: Readonly<{ children: ReactNode }>) {
  const customer = await getCurrentCustomerUser();
  if (!customer) {
    // Staff belong in the staff app. Anyone else signs in first and is brought back here.
    if (await getCurrentUser()) redirect("/");
    redirect(`/login?next=${encodeURIComponent("/portal")}`);
  }
  return <PortalShell name={customer.name}>{children}</PortalShell>;
}
