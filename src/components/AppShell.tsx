"use client";

import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";
import { closeUrlPanel, pushUrlParams } from "@/lib/client/url-state";
import type { CustomerSummary, SessionUser } from "@/lib/types";
import { SessionExpiredBanner } from "./SessionExpiredBanner";
import { Sidebar, MobileNav } from "./Sidebar";
import { UiContext, type UiActions } from "./ui-context";

// The drawer and the form (with the validation they carry) are only needed once someone opens one.
const CustomerDrawer = dynamic(() => import("./CustomerDrawer").then((module) => module.CustomerDrawer));
const CustomerFormModal = dynamic(() => import("./CustomerFormModal").then((module) => module.CustomerFormModal));

type ModalState = { mode: "new" } | { mode: "edit"; customer: CustomerSummary } | null;

const DRAWER_PARAM = "c";

export function AppShell({ user, children }: { user: SessionUser; children: ReactNode }) {
  const searchParams = useSearchParams();
  const [modal, setModal] = useState<ModalState>(null);
  const openCustomerId = searchParams.get(DRAWER_PARAM);

  // Nothing here depends on the URL, so this object is created once. If it changed on every filter keystroke, every
  // row in the table (each reads it) would re-render each time.
  const actions = useMemo<UiActions>(
    () => ({
      user,
      openNew: () => setModal({ mode: "new" }),
      openEdit: (customer) => setModal({ mode: "edit", customer }),
      // The open customer lives in the address bar, so a link to a customer opens straight to them. Opening adds a history
      // entry, so the browser's Back button closes the drawer instead of leaving the page.
      openCustomer: (id) => pushUrlParams({ [DRAWER_PARAM]: id }),
    }),
    [user],
  );

  return (
    <UiContext.Provider value={actions}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <SessionExpiredBanner />
      <div className="app">
        <Sidebar user={user} />
        <main className="main" id="main" tabIndex={-1}>
          <MobileNav user={user} />
          {children}
        </main>
      </div>

      {openCustomerId ? (
        <CustomerDrawer key={openCustomerId} id={openCustomerId} onClose={() => closeUrlPanel({ [DRAWER_PARAM]: null })} />
      ) : null}

      {modal ? (
        <CustomerFormModal
          key={modal.mode === "edit" ? modal.customer.id : "new"}
          customer={modal.mode === "edit" ? modal.customer : null}
          onClose={() => setModal(null)}
          onCreated={(id) => {
            setModal(null);
            pushUrlParams({ [DRAWER_PARAM]: id });
          }}
        />
      ) : null}
    </UiContext.Provider>
  );
}
