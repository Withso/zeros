const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}";

export function allowedControlPlaneRoute(method, pathname) {
  if (method === "GET" && pathname === "/v1/me") return true;
  if (
    method === "GET" &&
    (pathname === "/v1/auth/snapshot" || pathname === "/v1/auth/events")
  ) {
    return true;
  }
  if (method === "POST" && pathname === "/v1/invitations/accept") return true;
  if (method === "POST" && pathname === "/v1/organizations") return true;
  const root = new RegExp(`^/v1/organizations/${UUID}$`);
  if (root.test(pathname)) return ["GET", "PATCH", "DELETE"].includes(method);
  const members = new RegExp(`^/v1/organizations/${UUID}/members$`);
  if (members.test(pathname)) return method === "GET";
  const member = new RegExp(`^/v1/organizations/${UUID}/members/${UUID}$`);
  if (member.test(pathname)) return method === "PATCH" || method === "DELETE";
  const invitations = new RegExp(`^/v1/organizations/${UUID}/invitations$`);
  if (invitations.test(pathname)) return method === "GET" || method === "POST";
  const invitation = new RegExp(`^/v1/organizations/${UUID}/invitations/${UUID}$`);
  if (invitation.test(pathname)) return method === "DELETE";
  const teams = new RegExp(`^/v1/organizations/${UUID}/teams$`);
  if (teams.test(pathname)) return method === "GET" || method === "POST";
  const billing = new RegExp(`^/v1/organizations/${UUID}/billing$`);
  return billing.test(pathname) && method === "GET";
}

/** The dashboard proxy is deliberately content-type strict. An SSE body is
 * accepted only for the exact security-event route; every other response is
 * JSON so an upstream HTML error page cannot become trusted app content. */
export function acceptedControlPlaneResponseType(pathname, contentType) {
  const mediaType = String(contentType || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (pathname === "/v1/auth/events") {
    return mediaType === "text/event-stream" ? "sse" : null;
  }
  return mediaType === "application/json" ? "json" : null;
}

export function validMutationOrigin(request) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return true;
  const origin = request.headers.get("Origin");
  const expected = new URL(request.url).origin;
  const contentType = request.headers.get("Content-Type") ?? "";
  return (
    origin === expected &&
    request.headers.get("X-Zeros-Request") === "dashboard" &&
    /^application\/json(?:\s*;|$)/i.test(contentType)
  );
}

/** Release a response body that will not be returned or consumed. */
export async function cancelUnusedResponseBody(response) {
  await response.body?.cancel().catch(() => undefined);
}

/** Return a JSON response's content type. Invalid upstream formats are never
 * forwarded, so release their body before the caller synthesizes a 502. */
export async function jsonContentTypeOrCancel(response) {
  const contentType = response.headers.get("Content-Type") ?? "";
  if (contentType.toLowerCase().includes("application/json")) {
    return contentType;
  }
  await cancelUnusedResponseBody(response);
  return null;
}

/** Consume a fetch body incrementally and stop reading as soon as it crosses
 * the proxy ceiling. This keeps a chunked request from allocating up to the
 * platform-wide request limit before the dashboard's much smaller bound runs. */
export async function readBoundedBody(request, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("maxBytes must be a non-negative safe integer");
  }
  return readBoundedStream(request.body, maxBytes);
}

async function readBoundedStream(stream, maxBytes) {
  if (!stream) return { ok: true, body: new ArrayBuffer(0) };

  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      total += chunk.byteLength;
      if (total > maxBytes) {
        await reader.cancel("body too large").catch(() => undefined);
        return { ok: false };
      }
      chunks.push(chunk.slice());
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, body: body.buffer };
}

/** Bound upstream JSON before it crosses the same-origin browser facade. A
 * declared overage is rejected without consuming it; chunked responses are
 * cancelled at the first byte beyond the limit. */
export async function readBoundedResponseBody(response, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("maxBytes must be a non-negative safe integer");
  }
  const rawLength = response.headers.get("content-length")?.trim() ?? "";
  if (/^\d+$/.test(rawLength) && Number(rawLength) > maxBytes) {
    await cancelUnusedResponseBody(response);
    return { ok: false };
  }
  return readBoundedStream(response.body, maxBytes);
}
