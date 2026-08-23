import { readBoundedBody } from "./control-plane-policy.mjs";
import { configuredAuthProvider } from "./workos-browser.mjs";
import { fetchWorkOSRailway } from "./workos-railway.mjs";

const MAX_REQUEST_BYTES = 1_024;
const MAX_BEARER_BYTES = 64 * 1_024;

function json(value, status = 200) {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
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

/** Compatibility facade for already-released desktops. New desktop builds call
 * Railway directly; Pages forwards only the verified-shape bearer and scope. */
export async function handleWorkOSDesktopRevocationRequest(
  request,
  env,
  options = {},
) {
  if (configuredAuthProvider(env) !== "workos") {
    return json({ error: "not_found" }, 404);
  }
  const authorization = bearerHeader(request);
  if (
    !authorization ||
    !(request.headers.get("content-type") || "")
      .toLowerCase()
      .startsWith("application/json")
  ) {
    return json({ error: "bad_request" }, 400);
  }
  const bounded = await readBoundedBody(request, MAX_REQUEST_BYTES);
  if (!bounded.ok) return json({ error: "bad_request" }, 400);
  let scope;
  try {
    scope = JSON.parse(new TextDecoder().decode(bounded.body))?.scope;
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  if (scope !== "current" && scope !== "all") {
    return json({ error: "bad_request" }, 400);
  }

  try {
    return await fetchWorkOSRailway(
      env,
      "/auth/desktop-revoke",
      {
        method: "POST",
        headers: {
          authorization,
          "content-type": "application/json",
        },
        body: bounded.body,
      },
      options.fetch || fetch,
    );
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}
