// app.zeros.build/handoff/redeem  (POST, verifier-authed)
//
// Called by the DESKTOP main process (over HTTPS — no cookie). Authenticated by
// possession of { valid single-use ticket + the handoff-PKCE verifier }. On
// success, hands over the INDEPENDENT Auth0 token pair minted at /handoff/mint
// time — never in a URL.
//
// KV get-then-delete is NOT atomic the way the old Postgres
// `UPDATE ... WHERE consumed_at IS NULL RETURNING` was — a redeem racing within
// the tiny window between the get and the delete could theoretically read the
// same ticket twice. Given the 90s TTL and that this only matters if an
// attacker has already intercepted the ticket in transit (the primary threat
// this mechanism defends against), that's an accepted trade-off; a Durable
// Object would close it fully if it's ever needed.

import { type Env } from "../../lib/session";
import {
  sha256Hex,
  sha256B64url,
  json,
  TOKENISH,
} from "../../lib/handoff-security";
import { clientIp, rateLimit } from "../../lib/ratelimit";

type StoredTicket = {
  challenge: string;
  nonce: string;
  accessToken: string;
  refreshToken: string | null;
  sub: string;
  email: string;
  name: string | null;
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  // Cap brute-force probing of the ticket space (256-bit, so infeasible anyway —
  // this is just an abuse ceiling). Fails open if KV is unavailable.
  if (env.SESSIONS) {
    const rl = await rateLimit(env.SESSIONS, "redeem", clientIp(request), 30, 60, Date.now());
    if (!rl.ok) {
      return json({ error: "rate_limited" }, 429, {
        "cache-control": "no-store",
        "retry-after": String(rl.retryAfter),
      });
    }
  }

  let body: { ticket?: unknown; verifier?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  const ticket = typeof body.ticket === "string" ? body.ticket : "";
  const verifier = typeof body.verifier === "string" ? body.verifier : "";
  if (!TOKENISH.test(ticket) || !TOKENISH.test(verifier)) {
    return json({ error: "bad_request" }, 400);
  }

  const ticketHash = await sha256Hex(ticket);
  const key = `ticket:${ticketHash}`;
  const raw = await env.SESSIONS.get(key);
  if (!raw) return json({ error: "invalid_or_used" }, 401);
  const stored = JSON.parse(raw) as StoredTicket;

  // handoff-PKCE: prove possession of the verifier (it never crossed zeros://)
  // BEFORE consuming the ticket. Deleting first would let an attacker who
  // intercepted the ticket burn it with a junk verifier, denying the legitimate
  // desktop its one redemption; on a mismatch the ticket stays live for the real
  // caller (and dies by TTL regardless).
  const expected = await sha256B64url(verifier);
  if (expected !== stored.challenge) return json({ error: "verifier_mismatch" }, 401);
  await env.SESSIONS.delete(key); // single-use, best-effort (see file header)

  return json({
    access_token: stored.accessToken,
    refresh_token: stored.refreshToken,
    sub: stored.sub,
    email: stored.email,
    name: stored.name,
  });
};
