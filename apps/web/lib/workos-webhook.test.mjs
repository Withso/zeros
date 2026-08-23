import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { handleWorkOSWebhook } from "./workos-webhook.mjs";

const NOW = 1_800_000_000_000;
const SIGNING_SECRET = "webhook-signing-secret-for-tests";
const BROKER_SECRET = "b".repeat(48);
const CONTROL_PLANE_URL = "https://api-alpha.zeros.build";

function userEvent(overrides = {}) {
  return {
    id: "event_01TEST",
    event: "user.updated",
    created_at: "2027-01-15T08:00:00.000Z",
    data: {
      id: "user_01TEST",
      email: "user@example.com",
      email_verified: true,
      name: "Updated User",
      profile_picture_url: "https://images.example.com/user.png",
    },
    ...overrides,
  };
}

function signedRequest(payload, options = {}) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const timestamp = options.timestamp ?? NOW;
  const signature = createHmac("sha256", SIGNING_SECRET)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  return new Request("https://app-alpha.zeros.build/auth/workos-webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "workos-signature": `t=${timestamp}, v1=${options.signature ?? signature}`,
    },
    body,
  });
}

function env() {
  return {
    WORKOS_WEBHOOK_SECRET: SIGNING_SECRET,
    AUTH_BROKER_SECRET: BROKER_SECRET,
    CONTROL_PLANE_URL,
  };
}

test("a verified user lifecycle event is reduced and forwarded to the control plane", async () => {
  const calls = [];
  const response = await handleWorkOSWebhook(signedRequest(userEvent()), env(), {
    now: () => NOW,
    fetch: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return Response.json({ ok: true, status: "applied" });
    },
  });

  assert.equal(response.status, 202);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${CONTROL_PLANE_URL}/internal/auth/workos/events`);
  assert.equal(calls[0].init.headers["x-zeros-auth-broker"], BROKER_SECRET);
  assert.deepEqual(calls[0].body, {
    eventId: "event_01TEST",
    eventType: "user.updated",
    createdAt: "2027-01-15T08:00:00.000Z",
    user: {
      id: "user_01TEST",
      email: "user@example.com",
      emailVerified: true,
      name: "Updated User",
      profilePictureUrl: "https://images.example.com/user.png",
    },
  });
});

test("signature verification covers the exact raw request body", async () => {
  let forwarded = false;
  const request = signedRequest(JSON.stringify(userEvent(), null, 2), {
    signature: "0".repeat(64),
  });
  const response = await handleWorkOSWebhook(request, env(), {
    now: () => NOW,
    fetch: async () => {
      forwarded = true;
      return Response.json({ ok: true });
    },
  });

  assert.equal(response.status, 401);
  assert.equal(forwarded, false);
});

test("stale and future webhook timestamps are rejected", async () => {
  for (const timestamp of [NOW - 180_001, NOW + 180_001]) {
    const response = await handleWorkOSWebhook(
      signedRequest(userEvent(), { timestamp }),
      env(),
      { now: () => NOW, fetch: async () => Response.json({ ok: true }) },
    );
    assert.equal(response.status, 401);
  }
});

test("unsubscribed event types are acknowledged without forwarding", async () => {
  let forwarded = false;
  const response = await handleWorkOSWebhook(
    signedRequest(userEvent({ event: "organization.created" })),
    env(),
    {
      now: () => NOW,
      fetch: async () => {
        forwarded = true;
        return Response.json({ ok: true });
      },
    },
  );
  assert.equal(response.status, 202);
  assert.equal(forwarded, false);
});

test("control-plane outages stay retryable to WorkOS", async () => {
  const response = await handleWorkOSWebhook(signedRequest(userEvent()), env(), {
    now: () => NOW,
    fetch: async () => new Response("unavailable", { status: 503 }),
  });
  assert.equal(response.status, 503);
});

test("oversized webhook bodies are rejected before signature work", async () => {
  const body = "x".repeat(65 * 1024);
  const response = await handleWorkOSWebhook(signedRequest(body), env(), {
    now: () => NOW,
    fetch: async () => Response.json({ ok: true }),
  });
  assert.equal(response.status, 413);
});
