import { ApiClientError, SESSION_EXPIRED_EVENT } from "./api";

/**
 * Downloads a file from the API. A plain <a download> link hides every failure: a 401, a 403 or a 500 becomes a browser
 * message with no reason, or a saved file that is really an error page. Fetching it here means a failure is an error the
 * screen can show in words, and only a real file is ever saved.
 */
export async function downloadFile(path: string, filename: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(path, { credentials: "same-origin", signal: AbortSignal.timeout(60_000) });
  } catch {
    throw new ApiClientError(0, "network", "Couldn't reach the server to download that. Check your connection and try again.");
  }
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
    let message = "The download failed. Please try again.";
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body.error?.message) message = body.error.message;
    } catch {
      // not JSON: keep the generic message
    }
    throw new ApiClientError(response.status, "download_failed", message);
  }
  const url = URL.createObjectURL(await response.blob());
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}
