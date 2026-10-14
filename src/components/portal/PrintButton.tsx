"use client";

/** Prints the page. The print styles hide the header buttons and leave a clean one-page summary of the account. */
export function PrintButton() {
  return (
    <button type="button" className="btn btn-sm no-print" onClick={() => window.print()}>
      Print this page
    </button>
  );
}
