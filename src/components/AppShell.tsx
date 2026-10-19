"use client";

import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState, type ReactNode } from "react";
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
  // The customer drawer and the forms are loaded on demand, but there is no reason to make the first click wait for them: fetch them
  // shortly after the page is up (a lazy chunk with the validation library was the visible delay on the first open).
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void import("./CustomerDrawer");
      void import("./CustomerFormModal");
    }, 1_500);
    return () => window.clearTimeout(timer);
  }, []);

  const searchParams = useSearchParams();
  const [modal, setModal] = useState<ModalState>(null);
  const openCustomerId = searchParams.get(DRAWER_PARAM);

  // The edit form belongs to the customer drawer. When the drawer goes away (the Back button, a link) the form must too, or it
  // stays open over a page it no longer belongs to. (Adjusting state while rendering, as React documents, rather than in an effect.)
  if (modal?.mode === "edit" && modal.customer.id !== openCustomerId) setModal(null);

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
