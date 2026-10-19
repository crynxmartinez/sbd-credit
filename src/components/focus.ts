/**
 * Where keyboard focus goes after the control that had it is removed (an action completes and its button goes away). Left alone,
 * the browser drops it onto the page body, behind the open dialog, and the next Tab starts from the top. These name a place
 * that still exists.
 */
export function focusDrawerTitle(): void {
  document.getElementById("drawer-title")?.focus();
}

/** After "Cancel" on a form that replaced a button: back to that button (it is a new element, so find it by id). */
export function focusById(id: string): void {
  // After React has put the button back.
  window.setTimeout(() => document.getElementById(id)?.focus(), 0);
}
