import { readBoundedBody } from "./control-plane-policy.mjs";
import { configuredAuthProvider } from "./workos-browser.mjs";
import { fetchWorkOSRailway } from "./workos-railway.mjs";

const MAX_WEBHOOK_BYTES = 64 * 1024;

function json(value, status) {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

/** Compatibility facade for the existing WorkOS endpoint URL. Signature
 * verification and event reduction now happen only on Railway. */
export async function handleWorkOSWebhook(request, env, options = {}) {
  if (request.method !== "POST" || configuredAuthProvider(env) !== "workos") {
    return json({ error: "not_found" }, 404);
  }
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_WEBHOOK_BYTES) {
    return json({ error: "body_too_large" }, 413);
  }
  const bounded = await readBoundedBody(request, MAX_WEBHOOK_BYTES);
  if (!bounded.ok) return json({ error: "body_too_large" }, 413);
  const signature = request.headers.get("workos-signature") || "";
  if (!signature || signature.length > 2_048) {
    return json({ error: "invalid_signature" }, 401);
  }
  try {
    return await fetchWorkOSRailway(
      env,
      "/auth/workos-webhook",
      {
        method: "POST",
        headers: {
          "content-type":
            request.headers.get("content-type") || "application/json",
          "workos-signature": signature,
        },
        body: bounded.body,
      },
      options.fetch || fetch,
    );
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}
