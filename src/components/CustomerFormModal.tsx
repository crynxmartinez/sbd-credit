"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { ApiClientError } from "@/lib/client/api";
import { useBusinessToday, useCreateCustomer, useCustomers, useUpdateCustomer } from "@/lib/client/queries";
import { PAYMENT_TERMS } from "@/lib/domain/constants";
import { centsToDecimal } from "@/lib/domain/csv";
import { parseMoneyToCents } from "@/lib/domain/money";
import { can } from "@/lib/domain/roles";
import type { CustomerSummary } from "@/lib/types";
import { customerCreateSchema, customerUpdateSchema } from "@/lib/validation";
import { CloseIcon } from "./icons";
import { useToast } from "./Toast";
import { useDialog } from "./useDialog";
import { Field } from "./ui";
import { useUi } from "./ui-context";

interface FormState {
  businessName: string;
  contactName: string;
  phone: string;
  email: string;
  billingAddress: string;
  dateApplied: string;
  requestedLimit: string;
  creditLimit: string;
  paymentTerms: string;
  creditStartDate: string;
  accountingAppName: string;
  accountingProjectUrl: string;
  notes: string;
}

type Errors = Partial<Record<keyof FormState, string>>;

/** The server names fields after the stored value (…Cents); the form names them after what the person types. */
const FIELD_ALIASES: Readonly<Record<string, keyof FormState>> = {
  requestedLimitCents: "requestedLimit",
  creditLimitCents: "creditLimit",
};

const MONEY_HINT = "Enter dollars, like 25000 or 25000.50.";
const FORM_KEYS: ReadonlySet<string> = new Set([
  "businessName", "contactName", "phone", "email", "billingAddress", "dateApplied", "requestedLimit", "creditLimit",
  "paymentTerms", "creditStartDate", "accountingAppName", "accountingProjectUrl", "notes",
]);
const FALLBACK_ERROR = "Check the form and try again.";

function initialState(customer: CustomerSummary | null, today: string): FormState {
  return {
    businessName: customer?.businessName ?? "",
    contactName: customer?.contactName ?? "",
    phone: customer?.phone ?? "",
    email: customer?.email ?? "",
    billingAddress: customer?.billingAddress ?? "",
    dateApplied: customer?.dateApplied ?? today,
    requestedLimit: customer?.requestedLimitCents != null ? centsToDecimal(customer.requestedLimitCents) : "",
    creditLimit: customer ? centsToDecimal(customer.creditLimitCents) : "",
    paymentTerms: customer?.paymentTerms ?? "Net 30",
    creditStartDate: customer?.creditStartDate ?? "",
    accountingAppName: customer?.accountingAppName ?? "",
    accountingProjectUrl: customer?.accountingProjectUrl ?? "",
    notes: customer?.notes ?? "",
  };
}

/** Splits server or schema problems into ones that belong to a visible field and a message for everything else. */
function mapFields(fields: Record<string, string> | undefined): { errors: Errors; other: string | null } {
  const errors: Errors = {};
  let other: string | null = null;
  for (const [name, message] of Object.entries(fields ?? {})) {
    const key = FIELD_ALIASES[name] ?? name;
    if (FORM_KEYS.has(key)) errors[key as keyof FormState] = message;
    else other ??= message;
  }
  return { errors, other };
}

function issuesToFields(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): Record<string, string> {
  return Object.fromEntries(issues.map((issue) => [issue.path.join("."), issue.message]));
}

interface Props {
  customer: CustomerSummary | null;
  onClose: () => void;
  onCreated: (id: string) => void;
}

export function CustomerFormModal({ customer, onClose, onCreated }: Props) {
  const { user } = useUi();
  const notify = useToast();
  const queryClient = useQueryClient();
  const create = useCreateCustomer();
  const update = useUpdateCustomer(customer?.id ?? "");
  const today = useBusinessToday();
  const [form, setForm] = useState<FormState>(() => initialState(customer, today));
  // What the form held when it opened, to tell whether anything has been typed since.
  const [baseline] = useState(() => JSON.stringify(initialState(customer, today)));
  const dirty = JSON.stringify(form) !== baseline;
  function requestClose() {
    if (dirty && !window.confirm("Discard what you have entered in this form?")) return;
    onClose();
  }
  const dialogRef = useDialog(requestClose);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  // One key per form: if a save is retried (a lost reply, a double click) the server recognises it and adds nothing twice.
  const [requestKey] = useState(() => crypto.randomUUID());
  const [stale, setStale] = useState(false);
  // Set only when the person chose "load theirs": the form then holds the newest copy, so it must be saved against it.
  const [loadedVersion, setLoadedVersion] = useState<number | null>(null);

  // The newest copy of this customer. The snapshot the form opened with ages while it is open; a save must be made
  // against the current version, or one "someone else changed this" error would repeat on every attempt.
  const { data: list } = useCustomers({ poll: false });
  const live = customer ? list?.customers.find((candidate) => candidate.id === customer.id) : undefined;

  const editing = customer !== null;
  const showCredit =
    editing && (customer.status === "approved" || customer.status === "suspended") && can(user.role, "customer.change_credit");
  const pending = create.isPending || update.isPending;

  // After a failed submit, move focus to the first field with a problem so it is seen (and announced), even if the
  // modal body has scrolled away from it.
  useEffect(() => {
    if (Object.keys(errors).length === 0) return;
    dialogRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [errors, dialogRef]);

  function showProblems(fields: Record<string, string> | undefined, fallback: string | null = null) {
    const { errors: inline, other } = mapFields(fields);
    setErrors(inline);
    setFormError(other ?? (Object.keys(inline).length === 0 ? (fallback ?? FALLBACK_ERROR) : null));
  }

  function loadTheirs() {
    if (live) {
      setForm(initialState(live, today));
      setLoadedVersion(live.version);
    }
    setErrors({});
    setStale(false);
  }

  const set = (key: keyof FormState) => (event: { target: { value: string } }) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);

    const requested = form.requestedLimit.trim() ? parseMoneyToCents(form.requestedLimit) : null;
    const credit = showCredit ? parseMoneyToCents(form.creditLimit) : undefined;
    const moneyErrors: Errors = {
      ...(form.requestedLimit.trim() && requested === null ? { requestedLimit: MONEY_HINT } : {}),
      ...(showCredit && credit === null ? { creditLimit: MONEY_HINT } : {}),
    };
    if (Object.keys(moneyErrors).length > 0) {
      setErrors(moneyErrors);
      setFormError(null);
      return;
    }

    const profile = {
      businessName: form.businessName,
      contactName: form.contactName,
      phone: form.phone,
      email: form.email,
      billingAddress: form.billingAddress,
      dateApplied: form.dateApplied,
      requestedLimitCents: requested,
      accountingAppName: form.accountingAppName,
      accountingProjectUrl: form.accountingProjectUrl,
      notes: form.notes,
    };

    setStale(false);
    try {
      if (customer) {
        const parsed = customerUpdateSchema.safeParse({
          ...profile,
          // The version the form was OPENED at. If someone else saved since, the server says so and the person chooses. Only
          // AFTER that conflict is shown does a second save go against the newest copy ("keep mine"): using the newest copy
          // straight away would silently overwrite a colleague's change.
          version: stale ? (live?.version ?? customer.version) : (loadedVersion ?? customer.version),
          ...(showCredit
            ? { creditLimitCents: credit ?? undefined, paymentTerms: form.paymentTerms, creditStartDate: form.creditStartDate || null }
            : {}),
        });
        if (!parsed.success) return showProblems(issuesToFields(parsed.error.issues));
        await update.mutateAsync(parsed.data);
        notify("Application updated.");
        onClose();
      } else {
        const parsed = customerCreateSchema.safeParse({ ...profile, requestKey });
        if (!parsed.success) return showProblems(issuesToFields(parsed.error.issues));
        const { id } = await create.mutateAsync(parsed.data);
        notify("Application created.");
        onCreated(id);
      }
    } catch (caught) {
      if (caught instanceof ApiClientError && caught.code === "stale") {
        // The cached copy is the one this form was opened from: bring in the newest, or "keep mine" would be sent against the
        // same old version and fail the same way again.
        await queryClient.refetchQueries({ queryKey: ["customers"] }).catch(() => undefined);
        setStale(true);
      } else if (caught instanceof ApiClientError) {
        const { errors: inline } = mapFields(caught.fields);
        setErrors(inline);
        setFormError(caught.message);
      } else {
        setFormError("Could not save. Please try again.");
      }
    }
  }

  return (
    <div className="overlay">
      <div ref={dialogRef} className="modal" role="dialog" aria-modal="true" aria-labelledby="customer-form-title" tabIndex={-1}>
        <form onSubmit={submit} noValidate>
          <div className="modal-header">
            <h2 id="customer-form-title">{editing ? "Edit credit application" : "New credit application"}</h2>
            <button type="button" className="icon-btn" onClick={requestClose} aria-label="Close">
              <CloseIcon />
            </button>
          </div>
          <div className="modal-body">
            {stale ? (
              <div className="warn-note" role="alert" style={{ marginBottom: 12 }}>
                Someone else changed this customer while you were editing. Press Save to keep your version and replace
                theirs, or{" "}
                <button type="button" className="btn btn-sm" onClick={loadTheirs}>
                  discard mine and load theirs
                </button>
              </div>
            ) : null}
            {formError ? (
              <div className="form-error" role="alert">
                {formError}
              </div>
            ) : null}
            <div className="form-grid">
              <div className="section-divider">Business</div>
              <Field id="f_businessName" label="Business name" required span2 error={errors.businessName}>
                <input id="f_businessName" type="text" value={form.businessName} onChange={set("businessName")} placeholder="e.g. Midwest Fabrication LLC" data-autofocus />
              </Field>
              <Field id="f_contactName" label="Contact name" error={errors.contactName}>
                <input id="f_contactName" type="text" value={form.contactName} onChange={set("contactName")} />
              </Field>
              <Field id="f_phone" label="Phone" error={errors.phone}>
                <input id="f_phone" type="tel" value={form.phone} onChange={set("phone")} />
              </Field>
              <Field id="f_email" label="Email" span2 error={errors.email}>
                <input id="f_email" type="email" value={form.email} onChange={set("email")} />
              </Field>
              <Field id="f_billingAddress" label="Billing address" span2 error={errors.billingAddress}>
                <input id="f_billingAddress" type="text" value={form.billingAddress} onChange={set("billingAddress")} />
              </Field>

              <div className="section-divider">Application</div>
              <Field id="f_dateApplied" label="Date applied" error={errors.dateApplied}>
                <input id="f_dateApplied" type="date" value={form.dateApplied} onChange={set("dateApplied")} />
              </Field>
              <Field id="f_requestedLimit" label="Requested limit ($)" error={errors.requestedLimit}>
                <input id="f_requestedLimit" type="text" inputMode="decimal" value={form.requestedLimit} onChange={set("requestedLimit")} />
              </Field>

              {showCredit ? (
                <>
                  <div className="section-divider">Credit terms</div>
                  <Field id="f_creditLimit" label="Credit limit ($)" error={errors.creditLimit}>
                    <input id="f_creditLimit" type="text" inputMode="decimal" value={form.creditLimit} onChange={set("creditLimit")} />
                  </Field>
                  <Field id="f_paymentTerms" label="Payment terms" error={errors.paymentTerms}>
                    <select id="f_paymentTerms" value={form.paymentTerms} onChange={set("paymentTerms")}>
                      {PAYMENT_TERMS.map((terms) => (
                        <option key={terms}>{terms}</option>
                      ))}
                    </select>
                  </Field>
                  <Field id="f_creditStartDate" label="Credit start date" span2 error={errors.creditStartDate}>
                    <input id="f_creditStartDate" type="date" value={form.creditStartDate} onChange={set("creditStartDate")} />
                  </Field>
                </>
              ) : null}

              <div className="section-divider">Accounting link</div>
              <Field id="f_accountingAppName" label="Accounting app" error={errors.accountingAppName}>
                <input id="f_accountingAppName" type="text" value={form.accountingAppName} onChange={set("accountingAppName")} placeholder="e.g. QuickBooks" />
              </Field>
              <Field id="f_accountingProjectUrl" label="Project / customer URL" error={errors.accountingProjectUrl}>
                <input id="f_accountingProjectUrl" type="url" value={form.accountingProjectUrl} onChange={set("accountingProjectUrl")} placeholder="https://…" />
              </Field>

              <div className="section-divider">Notes</div>
              <Field id="f_notes" label="Internal notes" span2 error={errors.notes}>
                <textarea id="f_notes" value={form.notes} onChange={set("notes")} placeholder="Internal notes…" />
              </Field>
            </div>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn" onClick={requestClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={pending}>
              {pending ? "Saving…" : editing ? "Save changes" : "Create application"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
