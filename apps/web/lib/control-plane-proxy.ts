import {
  getVerifiedSessionWithId,
  refreshBrowserSession,
  type Env,
  type SessionSnapshot,
  type SessionData,
} from "./session";
import {
  allowedControlPlaneRoute,
  cancelUnusedResponseBody,
  jsonContentTypeOrCancel,
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
  verifiedSession?: SessionSnapshot,
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
  if (found.refreshStatus === "transient") {
    return jsonError(
      503,
      "auth_unavailable",
      "Sign-in service is temporarily unavailable; retry shortly",
    );
  }
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
  // rotate the Railway-held grant, then replay the exact bounded request body.
  if (upstream.status === 401) {
    const granted = await refreshBrowserSession(
      env,
      found.sessionId,
      session,
      found.revision,
    );
    if (granted.ok) {
      // The first response will never be returned after a successful refresh.
      // Release its stream before replaying so Workers does not retain an
      // unread 401 body for the rest of the request.
      await cancelUnusedResponseBody(upstream);
      session = granted.data;
      upstream = await upstreamRequest(
        env,
        pathAndSearch,
        request.method,
        session.accessToken,
        body,
      );
    } else {
      await cancelUnusedResponseBody(upstream);
      return granted.terminal
        ? jsonError(401, "signed_out", "Sign in again")
        : jsonError(
            503,
            "auth_unavailable",
            "Sign-in service is temporarily unavailable; retry shortly",
          );
    }
  }

  const contentType = await jsonContentTypeOrCancel(upstream);
  if (!contentType) {
    return jsonError(
      502,
      "bad_gateway",
      "Organization service returned an invalid response",
    );
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
