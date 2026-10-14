import type { NextRequest } from "next/server";
import { z } from "zod";
import { addressBucket, clientAddress, trustedHopsFromEnv } from "@/lib/server/auth/client-address";
import { attemptLimit } from "@/lib/server/auth/limits";
import { createRateLimiter } from "@/lib/server/auth/rate-limit";
import { ApiError, assertSameOrigin, ok, readJson, route } from "@/lib/server/http";
import { acceptInvite } from "@/lib/server/services/portal-access";

const acceptSchema = z.object({
  // 32 random bytes in base64url. Anything of another shape cannot be a real link.
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/, "This link is not valid or has expired. Ask us to send you a new one."),
  password: z.string().min(1, "Choose a password.").max(200),
});

/** Per client address. A token cannot be guessed, but this still caps the cost of the hashing each valid-looking try causes. */
const limiter = createRateLimiter({
  limit: attemptLimit(process.env.ACCEPT_ATTEMPTS_PER_ADDRESS, 20, process.env.NODE_ENV === "production"),
  windowMs: 10 * 60_000,
});
const TRUSTED_HOPS = trustedHopsFromEnv(process.env.TRUSTED_PROXY_HOPS);

export function POST(request: NextRequest) {
  return route(async () => {
    assertSameOrigin(request);
    if (!limiter.take(addressBucket(clientAddress(request.headers, TRUSTED_HOPS)))) {
      throw new ApiError(429, "rate_limited", "Too many attempts. Please wait a few minutes and try again.");
    }
    const { token, password } = await readJson(request, acceptSchema);
    await acceptInvite(token, password);
    return ok({ accepted: true });
  });
}
