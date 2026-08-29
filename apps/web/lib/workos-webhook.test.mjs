import assert from "node:assert/strict";
import test from "node:test";

import { handleWorkOSWebhook } from "./workos-webhook.mjs";

const CONTROL_PLANE_URL = "https://api-alpha.zeros.build";
const SIGNATURE = `t=1800000000000, v1=${"a".repeat(64)}`;

function request(body, signature = SIGNATURE) {
  return new Request("https://app-alpha.zeros.build/auth/workos-webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(signature ? { "workos-signature": signature } : {}),
    },
    body,
  });
}

test("Pages preserves the exact signed webhook bytes for Railway", async () => {
  const raw = JSON.stringify(
    { id: "event_01TEST", data: { order: [3, 2, 1] } },
    null,
    2,
  );
  let forwarded;
  const response = await handleWorkOSWebhook(
    request(raw),
    { AUTH_PROVIDER: "workos", CONTROL_PLANE_URL },
    {
      fetch: async (url, init) => {
        forwarded = { url, init };
        return Response.json({ accepted: true }, { status: 202 });
      },
    },
  );

  assert.equal(response.status, 202);
  assert.equal(forwarded.url, `${CONTROL_PLANE_URL}/auth/workos-webhook`);
  assert.equal(forwarded.init.headers["workos-signature"], SIGNATURE);
  assert.equal(new TextDecoder().decode(forwarded.init.body), raw);
});

test("missing signatures and oversized bodies stop at Pages", async () => {
  let forwarded = false;
  const fetch = async () => {
    forwarded = true;
    return Response.json({ accepted: true }, { status: 202 });
  };
  assert.equal(
    (
      await handleWorkOSWebhook(
        request("{}", ""),
        { AUTH_PROVIDER: "workos", CONTROL_PLANE_URL },
        { fetch },
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await handleWorkOSWebhook(
        request("x".repeat(65 * 1024)),
        { AUTH_PROVIDER: "workos", CONTROL_PLANE_URL },
        { fetch },
      )
    ).status,
    413,
  );
  assert.equal(forwarded, false);
});

test("Railway signature failures remain visible to WorkOS", async () => {
  const response = await handleWorkOSWebhook(
    request("{}"),
    { AUTH_PROVIDER: "workos", CONTROL_PLANE_URL },
    {
      fetch: async () =>
        Response.json({ error: "invalid_signature" }, { status: 401 }),
    },
  );
  assert.equal(response.status, 401);
});
