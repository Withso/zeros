import {
  cancelUnusedResponseBody,
  readBoundedBody,
} from "./control-plane-policy.mjs";

const MAX_WEBHOOK_BYTES = 64 * 1024;
const SIGNATURE_TOLERANCE_MS = 3 * 60 * 1_000;
const EVENT_ID = /^[A-Za-z0-9_-]{1,512}$/;
const LIFECYCLE_EVENTS = new Set(["user.updated", "user.deleted"]);

function json(value, status) {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function hexBytes(value) {
  if (!/^[a-f0-9]{64}$/i.test(value)) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

async function signatureValid(rawBody, header, secret, now) {
  const match = /^t=(\d+)\s*,\s*v1=([a-f0-9]{64})$/i.exec(header);
  if (!match) return false;
  const timestamp = Number(match[1]);
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > SIGNATURE_TOLERANCE_MS) {
    return false;
  }
  const signature = hexBytes(match[2]);
  if (!signature) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signedPayload = `${timestamp}.${new TextDecoder().decode(rawBody)}`;
  return crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    encoder.encode(signedPayload),
  );
}

function safeAvatar(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function lifecycleEvent(value) {
  if (!value || typeof value !== "object") return null;
  if (!EVENT_ID.test(value.id) || !LIFECYCLE_EVENTS.has(value.event)) return null;
  if (
    typeof value.created_at !== "string" ||
    !Number.isFinite(Date.parse(value.created_at)) ||
    !value.data ||
    typeof value.data !== "object"
  ) {
    return null;
  }
  const user = value.data;
  if (
    !EVENT_ID.test(user.id) ||
    typeof user.email !== "string" ||
    user.email.length < 3 ||
    user.email.length > 320 ||
    typeof user.email_verified !== "boolean" ||
    !(
      user.name === null ||
      user.name === undefined ||
      (typeof user.name === "string" && user.name.length <= 500)
    )
  ) {
    return null;
  }
  return {
    eventId: value.id,
    eventType: value.event,
    createdAt: value.created_at,
    user: {
      id: user.id,
      email: user.email,
      emailVerified: user.email_verified,
      name: typeof user.name === "string" ? user.name : null,
      profilePictureUrl: safeAvatar(user.profile_picture_url),
    },
  };
}

function exactControlPlaneUrl(raw) {
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("CONTROL_PLANE_URL must be an HTTPS origin");
  }
  return url.origin;
}

export async function handleWorkOSWebhook(request, env, options = {}) {
  if (request.method !== "POST") return json({ error: "not_found" }, 404);
  if (
    typeof env.WORKOS_WEBHOOK_SECRET !== "string" ||
    env.WORKOS_WEBHOOK_SECRET.length < 16 ||
    typeof env.AUTH_BROKER_SECRET !== "string" ||
    env.AUTH_BROKER_SECRET.length < 32
  ) {
    return json({ error: "unavailable" }, 503);
  }
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_WEBHOOK_BYTES) return json({ error: "body_too_large" }, 413);
  const bounded = await readBoundedBody(request, MAX_WEBHOOK_BYTES);
  if (!bounded.ok) return json({ error: "body_too_large" }, 413);
  const body = new Uint8Array(bounded.body);
  const valid = await signatureValid(
    body,
    request.headers.get("workos-signature") || "",
    env.WORKOS_WEBHOOK_SECRET,
    (options.now || Date.now)(),
  );
  if (!valid) return json({ error: "invalid_signature" }, 401);

  let rawEvent;
  try {
    rawEvent = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return json({ error: "invalid_event" }, 400);
  }
  if (!LIFECYCLE_EVENTS.has(rawEvent?.event)) {
    return json({ accepted: true, ignored: true }, 202);
  }
  const event = lifecycleEvent(rawEvent);
  if (!event) return json({ error: "invalid_event" }, 400);

  let controlPlane;
  try {
    controlPlane = exactControlPlaneUrl(env.CONTROL_PLANE_URL || "");
  } catch {
    return json({ error: "unavailable" }, 503);
  }
  let response;
  try {
    response = await (options.fetch || fetch)(
      `${controlPlane}/internal/auth/workos/events`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-zeros-auth-broker": env.AUTH_BROKER_SECRET,
        },
        body: JSON.stringify(event),
      },
    );
  } catch {
    return json({ error: "unavailable" }, 503);
  }
  await cancelUnusedResponseBody(response);
  return response.ok
    ? json({ accepted: true }, 202)
    : json({ error: "unavailable" }, 503);
}
