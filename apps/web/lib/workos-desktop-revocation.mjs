import { configuredAuthProvider } from "./workos-browser.mjs";

const INTERNAL_ORIGIN = "https://auth-session.internal";
const MANAGEMENT_OBJECT = "desktop-session-management-v1";
const PAGE_SIZE = 100;
const MAX_SESSIONS = 1_000;
const REVOKE_CONCURRENCY = 10;
const MAX_REQUEST_BYTES = 1_024;
const MAX_BEARER_BYTES = 64 * 1_024;

function json(value, status = 200) {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function requiredIdentifier(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

function pageAfter(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512
    ? value
    : null;
}

async function revokeInBatches(provider, sessionIds) {
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

/**
 * Management core used only after the Worker has cryptographically verified a
 * Desktop-Application access token. It receives the verified subject/session,
 * never derives identity from an unverified request body.
 */
export async function revokeWorkOSDesktopSessions({
  scope,
  subject,
  sessionId,
  provider,
}) {
  if (!requiredIdentifier(subject) || !requiredIdentifier(sessionId)) {
    throw new TypeError("verified desktop session identity is incomplete");
  }
  if (scope === "current") {
    await provider.revokeSession(sessionId);
    return { revoked: 1 };
  }
  if (scope !== "all") throw new TypeError("invalid revocation scope");

  const sessionIds = new Set();
  const seenCursors = new Set();
  let after = null;
  do {
    if (after) {
      if (seenCursors.has(after))
        throw new Error("session pagination repeated");
      seenCursors.add(after);
    }
    const options = after ? { limit: PAGE_SIZE, after } : { limit: PAGE_SIZE };
    const page = await provider.listSessions(subject, options);
    if (!page || !Array.isArray(page.data) || !page.listMetadata) {
      throw new Error("session list response is invalid");
    }
    for (const session of page.data) {
      if (session?.status === "active" && requiredIdentifier(session.id)) {
        sessionIds.add(session.id);
      }
    }
    if (sessionIds.size > MAX_SESSIONS) {
      throw new Error("session list exceeds the bounded revocation limit");
    }
    after = pageAfter(page.listMetadata.after);
  } while (after);

  await revokeInBatches(provider, [...sessionIds]);
  return { revoked: sessionIds.size };
}

function bearerHeader(request) {
  const value = request.headers.get("authorization") || "";
  if (
    value.length > MAX_BEARER_BYTES ||
    !value.startsWith("Bearer ") ||
    /\s/.test(value.slice(7)) ||
    value.length === 7
  ) {
    return null;
  }
  return value;
}

async function boundedScope(request) {
  const length = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(length) && length > MAX_REQUEST_BYTES) return null;
  if (
    !(request.headers.get("content-type") || "")
      .toLowerCase()
      .startsWith("application/json")
  ) {
    return null;
  }
  const text = await request.text().catch(() => "");
  if (!text || text.length > MAX_REQUEST_BYTES) return null;
  try {
    const body = JSON.parse(text);
    return body?.scope === "current" || body?.scope === "all"
      ? body.scope
      : null;
  } catch {
    return null;
  }
}

/** Pages-facing boundary. The opaque bearer is forwarded over the private
 * Durable Object binding; neither the WorkOS API key nor management response
 * details cross back into the desktop. */
export async function handleWorkOSDesktopRevocationRequest(request, env) {
  if (configuredAuthProvider(env) !== "workos") {
    return json({ error: "not_found" }, 404);
  }
  const authorization = bearerHeader(request);
  const scope = await boundedScope(request);
  if (!authorization || !scope) return json({ error: "bad_request" }, 400);
  if (!env.AUTH_SESSIONS) return json({ error: "unavailable" }, 503);

  let response;
  try {
    const namespace = env.AUTH_SESSIONS;
    const stub = namespace.get(namespace.idFromName(MANAGEMENT_OBJECT));
    response = await stub.fetch(
      new Request(`${INTERNAL_ORIGIN}/desktop/revoke`, {
        method: "POST",
        headers: {
          authorization,
          "content-type": "application/json",
        },
        body: JSON.stringify({ scope }),
      }),
    );
  } catch {
    return json({ error: "unavailable" }, 503);
  }
  if (!response.ok) {
    return json(
      { error: response.status === 401 ? "unauthorized" : "unavailable" },
      response.status === 401 ? 401 : 503,
    );
  }
  const body = await response.json().catch(() => null);
  if (
    !body ||
    typeof body.revoked !== "number" ||
    !Number.isSafeInteger(body.revoked) ||
    body.revoked < 0 ||
    body.revoked > MAX_SESSIONS
  ) {
    return json({ error: "unavailable" }, 503);
  }
  return json({ revoked: body.revoked });
}
