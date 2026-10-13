export interface FieldChange {
  field: string;
  label: string;
  from: string | number | null;
  to: string | number | null;
}

type Comparable = string | number | null | undefined;

/**
 * Fields that differ between two versions of a record, for the audit trail.
 * `labels` names the fields worth tracking; anything not listed is ignored.
 */
export function diffFields(
  before: Readonly<Record<string, Comparable>>,
  after: Readonly<Record<string, Comparable>>,
  labels: Readonly<Record<string, string>>,
): FieldChange[] {
  return Object.entries(labels).flatMap(([field, label]) => {
    const from = before[field] ?? null;
    const to = after[field] ?? null;
    return from === to ? [] : [{ field, label, from, to }];
  });
}

/** One line for the history list, e.g. "Updated business name, credit limit". */
export function summarizeChanges(changes: readonly FieldChange[]): string {
  if (changes.length === 0) return "Saved with no changes";
  return `Updated ${changes.map((change) => change.label.toLowerCase()).join(", ")}`;
}
