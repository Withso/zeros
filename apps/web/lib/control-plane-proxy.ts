import {
  getVerifiedSessionWithId,
  putSession,
  refreshGrant,
  SESSION_TTL_S,
  type Env,
  type SessionData,
} from "./session";
import {
  allowedControlPlaneRoute,
  cancelUnusedResponseBody,
  readBoundedBody,
  validMutationOrigin,
} from "./control-plane-policy.mjs";

const MAX_BODY_BYTES = 256 * 1024;
function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

async function upstreamRequest(
  env: Env,
  pathAndSearch: string,
  method: string,
  accessToken: string,
  body: ArrayBuffer | undefined,
): Promise<Response> {
  const base = (env.CONTROL_PLANE_URL ?? "https://api.zeros.build").replace(
    /\/+$/,
    "",
  );
  return fetch(`${base}${pathAndSearch}`, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body } : {}),
  });
}

export async function proxyControlPlane(
  request: Request,
  env: Env,
  verifiedSession?: { sessionId: string; data: SessionData },
): Promise<Response> {
  const requestUrl = new URL(request.url);
  const pathname = requestUrl.pathname.replace(/^\/api(?=\/)/, "");
  if (!allowedControlPlaneRoute(request.method, pathname)) {
    return jsonError(404, "not_found", "Not found");
  }
  if (!validMutationOrigin(request)) {
    return jsonError(403, "invalid_origin", "Invalid request origin");
  }
  const declaredLength = Number(request.headers.get("Content-Length") ?? 0);
  if (declaredLength > MAX_BODY_BYTES) {
    return jsonError(413, "body_too_large", "Request body is too large");
  }
  let body: ArrayBuffer | undefined;
  if (!["GET", "HEAD"].includes(request.method)) {
    const bounded = await readBoundedBody(request, MAX_BODY_BYTES);
    if (!bounded.ok) {
      return jsonError(413, "body_too_large", "Request body is too large");
    }
    body = bounded.body;
  }

  // SSR already verified this exact request before choosing the signed-in
  // dashboard. Reuse that coherent snapshot instead of re-reading eventually
  // consistent KV immediately after a refresh-token rotation.
  const found =
    verifiedSession ?? (await getVerifiedSessionWithId(env, request));
  if (!found) return jsonError(401, "signed_out", "Sign in again");
  let session: SessionData = found.data;
  const pathAndSearch = `${pathname}${requestUrl.search}`;
  let upstream = await upstreamRequest(
    env,
    pathAndSearch,
    request.method,
    session.accessToken,
    body,
  );

  // Browser sessions outlive access tokens. Refresh once on an upstream 401,
  // rotate the KV grant, then replay the exact bounded request body.
  if (upstream.status === 401 && session.refreshToken) {
    const granted = await refreshGrant(env, session.refreshToken);
    if (granted.ok) {
      // The first response will never be returned after a successful refresh.
      // Release its stream before replaying so Workers does not retain an
      // unread 401 body for the rest of the request.
      await cancelUnusedResponseBody(upstream);
      session = {
        ...session,
        accessToken: granted.data.access_token,
        refreshToken: granted.data.refresh_token ?? session.refreshToken,
        verifiedAt: Date.now(),
      };
      await putSession(env, found.sessionId, session, SESSION_TTL_S);
      upstream = await upstreamRequest(
        env,
        pathAndSearch,
        request.method,
        session.accessToken,
        body,
      );
    }
  }

  const contentType = upstream.headers.get("Content-Type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return jsonError(502, "bad_gateway", "Organization service returned an invalid response");
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": contentType,
      "cache-control": "no-store",
      pragma: "no-cache",
    },
  });
}
