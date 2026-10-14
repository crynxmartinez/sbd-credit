import { AcceptInviteForm } from "@/components/portal/AcceptInviteForm";

export const dynamic = "force-dynamic";

export const metadata = { title: "Set your password — Steel Building Depot", robots: { index: false, follow: false } };

/**
 * The invitation link is /accept-invite#t=<token>. The token is in the fragment, which a browser never sends to any
 * server, so it cannot reach an access log or a Referer header, and nothing here can use it just by loading the page:
 * only an explicit submit does.
 */
export default function AcceptInvitePage() {
  return <AcceptInviteForm />;
}
