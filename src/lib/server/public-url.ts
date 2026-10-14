type Env = Readonly<Record<string, string | undefined>>;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const DEV_DEFAULT = "http://127.0.0.1:3200";

/**
 * The address customers are sent to. It comes from configuration and NEVER from the request's Host header, which a
 * caller can forge: an invitation link built from it could point a customer at someone else's site.
 */
export function publicBaseUrl(env: Env = process.env): string {
  const raw = env.PUBLIC_BASE_URL?.trim();
  if (!raw) {
    if (env.NODE_ENV === "production") throw new Error("PUBLIC_BASE_URL is not set. It is the address customers use, such as https://credit.example.com.");
    return DEV_DEFAULT;
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("PUBLIC_BASE_URL is not a valid web address.");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname))) {
    throw new Error("PUBLIC_BASE_URL must start with https:// (plain http is only for this machine).");
  }
  return url.origin;
}

/** The link an admin sends a customer. The token is in the fragment, so it is never sent to a server, a log or a Referer. */
export function inviteLink(token: string, env: Env = process.env): string {
  return `${publicBaseUrl(env)}/accept-invite#t=${token}`;
}
