import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import type { UtilizationLevel } from "@/lib/domain/alerts";
import { STATUS_LABELS, type CustomerStatus } from "@/lib/domain/constants";

export function StatusBadge({ status }: { status: CustomerStatus }) {
  return <span className={`badge badge-${status}`}>{STATUS_LABELS[status]}</span>;
}

export function UtilBar({ pct, level, wide }: { pct: number; level: UtilizationLevel; wide?: boolean }) {
  const cls = level === "ok" ? "util-bar" : `util-bar ${level}`;
  return (
    <>
      <div className="util-bar-wrap" style={wide ? { width: "100%" } : undefined} role="img" aria-label={`${pct}% of credit limit used`}>
        <div className={cls} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <div className="util-pct">{wide ? `${pct}% of credit limit used` : `${pct}%`}</div>
    </>
  );
}

interface FieldProps {
  id: string;
  label: string;
  error?: string;
  hint?: string;
  required?: boolean;
  span2?: boolean;
  /** One form control whose id matches `id`. */
  children: ReactNode;
}

/**
 * A labelled form field. The label is tied to its input (clicking it focuses the field), and the input is told about
 * its error, hint and required state so a screen reader announces them when the field is focused.
 */
export function Field({ id, label, error, hint, required, span2, children }: FieldProps) {
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  const control = isValidElement(children)
    ? cloneElement(children as ReactElement<Record<string, unknown>>, {
        "aria-invalid": error ? true : undefined,
        "aria-describedby": describedBy,
        "aria-required": required ? true : undefined,
      })
    : children;

  return (
    <div className={`field${span2 ? " span2" : ""}`}>
      <label htmlFor={id}>
        {label}
        {required ? " *" : ""}
      </label>
      {control}
      {hint && !error ? (
        <span className="field-hint" id={`${id}-hint`}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <span className="field-error" id={`${id}-error`} role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
