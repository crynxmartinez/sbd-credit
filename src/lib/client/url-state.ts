/**
 * Updates the address bar's query string in place. This is the browser's own history API, which Next's router
 * notices (useSearchParams updates), so filters and the open customer stay shareable without asking the server to
 * re-render the page on every keystroke or click.
 *
 * A value of null (or an empty string) removes the key. The current path and every other key are kept.
 */
export function replaceUrlParams(updates: Readonly<Record<string, string | null>>): void {
  const params = new URLSearchParams(window.location.search);
  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === "") params.delete(key);
    else params.set(key, value);
  }
  const query = params.toString();
  const next = `${window.location.pathname}${query ? `?${query}` : ""}`;
  if (next !== `${window.location.pathname}${window.location.search}`) {
    window.history.replaceState(null, "", next);
  }
}
