import { Hono } from "hono";
import type pg from "pg";

import { withSystemTx } from "./db.js";
import type { WorkOSDesktopProvider } from "./workos-provider.js";

const PAGE_SIZE = 100;
const MAX_SESSIONS = 1_000;
const REVOKE_CONCURRENCY = 10;
const MAX_REQUEST_BYTES = 1_024;
const MAX_BEARER_BYTES = 64 * 1_024;

function requiredIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

function pageAfter(value: unknown): string | null {
  return requiredIdentifier(value) ? value : null;
}

async function revokeInBatches(
  provider: WorkOSDesktopProvider,
  sessionIds: string[],
): Promise<void> {
  for (
    let offset = 0;
    offset < sessionIds.length;
    offset += REVOKE_CONCURRENCY
  ) {
    await Promise.all(
      sessionIds
        .slice(offset, offset + REVOKE_CONCURRENCY)
        .map((sessionId) => provider.revokeSession(sessionId)),
    );
  }
}

export async function revokeWorkOSDesktopSessions(options: {
  scope: "current" | "all";
  subject: string;
  sessionId: string;
  provider: WorkOSDesktopProvider;
}): Promise<{ revoked: number }> {
  const { scope, subject, sessionId, provider } = options;
  if (!requiredIdentifier(subject) || !requiredIdentifier(sessionId)) {
    throw new TypeError("Verified desktop session identity is incomplete");
  }
  if (scope === "current") {
    await provider.revokeSession(sessionId);
    return { revoked: 1 };
  }

  const sessionIds = new Set<string>();
  const seenCursors = new Set<string>();
  let after: string | null = null;
  do {
    if (after) {
      if (seenCursors.has(after))
        throw new Error("Session pagination repeated");
      seenCursors.add(after);
    }
    const page = await provider.listSessions(
      subject,
      after ? { limit: PAGE_SIZE, after } : { limit: PAGE_SIZE },
    );
    if (!page || !Array.isArray(page.data) || !page.listMetadata) {
      throw new Error("Session list response is invalid");
    }
    for (const session of page.data) {
      if (session.status === "active" && requiredIdentifier(session.id)) {
        sessionIds.add(session.id);
      }
    }
    if (sessionIds.size > MAX_SESSIONS) {
      throw new Error("Session list exceeds the bounded revocation limit");
    }
    after = pageAfter(page.listMetadata.after);
  } while (after);

  await revokeInBatches(provider, [...sessionIds]);
  return { revoked: sessionIds.size };
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  if (
    !header.startsWith("Bearer ") ||
    header.length === 7 ||
    header.length > MAX_BEARER_BYTES ||
    /\s/.test(header.slice(7))
  ) {
    return null;
  }
  return header.slice(7);
}

async function boundedJson(request: Request): Promise<unknown | null> {
  if (
    !(request.headers.get("content-type") ?? "")
      .toLowerCase()
      .startsWith("application/json")
  ) {
    return null;
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) return null;
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_REQUEST_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store", pragma: "no-cache" },
  });
}

export async function enqueueSessionsRevokedNotification(
  pool: pg.Pool,
  providerSubject: string,
): Promise<boolean> {
  if (!requiredIdentifier(providerSubject)) return false;
  return withSystemTx(pool, async (tx) => {
    const inserted = await tx.query(
      `INSERT INTO security_notification_outbox (
         user_id, destination_email, template, payload
       )
       SELECT u.id, u.email, 'sessions_revoked',
              jsonb_build_object('reason', 'user_requested_global_signout')
       FROM user_identities ui
       JOIN users u ON u.id = ui.user_id
       WHERE ui.provider = 'workos'
         AND ui.provider_sub = $1
         AND ui.status = 'active'
         AND u.deleted_at IS NULL
       RETURNING id`,
      [providerSubject],
    );
    return (inserted.rowCount ?? 0) === 1;
  });
}

export type WorkOSDesktopRevocationRoutesOptions = {
  onAllSessionsRevoked?: (input: {
    providerSubject: string;
    revoked: number;
  }) => Promise<void>;
};

export function createWorkOSDesktopRevocationRoutes(
  provider: WorkOSDesktopProvider,
  options: WorkOSDesktopRevocationRoutesOptions = {},
): Hono {
  const app = new Hono();
  app.post("/auth/desktop-revoke", async (c) => {
    const token = bearerToken(c.req.raw);
    const body = await boundedJson(c.req.raw);
    const scope =
      body && typeof body === "object" && "scope" in body ? body.scope : null;
    if (!token || (scope !== "current" && scope !== "all")) {
      return json({ error: "bad_request" }, 400);
    }
    let claims: { subject: string; sessionId: string };
    try {
      claims = await provider.verifyDesktopBearer(token);
    } catch {
      return json({ error: "unauthorized" }, 401);
    }
    try {
      const result = await revokeWorkOSDesktopSessions({
        scope,
        subject: claims.subject,
        sessionId: claims.sessionId,
        provider,
      });
      if (scope === "all" && options.onAllSessionsRevoked) {
        // Revocation is the security boundary. A notification-database outage
        // must never turn successful provider revocation into a failed logout.
        // The durable outbox takes over once this bounded enqueue succeeds.
        await options
          .onAllSessionsRevoked({
            providerSubject: claims.subject,
            revoked: result.revoked,
          })
          .catch(() => {
            console.error(
              "[auth] sessions-revoked notification enqueue failed",
            );
          });
      }
      return json(result);
    } catch {
      return json({ error: "unavailable" }, 503);
    }
  });
  return app;
}
