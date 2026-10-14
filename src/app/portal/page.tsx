import { redirect } from "next/navigation";
import { PortalCredit } from "@/components/portal/PortalCredit";
import { getCurrentCustomerUser } from "@/lib/server/auth/customer-session";
import { businessToday } from "@/lib/server/as-of";
import { getPortalView } from "@/lib/server/services/portal";

export const dynamic = "force-dynamic";

export default async function PortalPage() {
  // The layout has already sent anyone who is not signed in elsewhere; this reads the same contact again for its customer.
  const customer = await getCurrentCustomerUser();
  // A session that ended between the layout and here: sign in again rather than show a dead end.
  if (!customer) redirect(`/login?next=${encodeURIComponent("/portal")}`);

  const view = await getPortalView(customer, businessToday());
  if (!view) {
    return (
      <div className="portal-card" role="alert">
        <h1 className="page-title">We couldn&apos;t load your account</h1>
        <p className="page-sub">Please try again in a moment, or contact us if it keeps happening.</p>
      </div>
    );
  }
  return <PortalCredit view={view} />;
}
