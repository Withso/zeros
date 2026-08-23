import assert from "node:assert/strict";
import test from "node:test";

import { handleWorkOSDesktopRevocationRequest } from "./workos-desktop-revocation.mjs";

const CONTROL_PLANE_URL = "https://api-alpha.zeros.build";

test("Pages forwards only a bounded scope and bearer to Railway", async () => {
  let forwarded;
  const request = new Request(
    "https://app-alpha.zeros.build/auth/desktop-revoke",
    {
      method: "POST",
      headers: {
        authorization: "Bearer signed-access-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ scope: "all" }),
    },
  );
  const response = await handleWorkOSDesktopRevocationRequest(
    request,
    { AUTH_PROVIDER: "workos", CONTROL_PLANE_URL },
    {
      fetch: async (url, init) => {
        forwarded = { url, init };
        return Response.json({ revoked: 2 });
      },
    },
  );

  assert.equal(response.status, 200);
  assert.equal(forwarded.url, `${CONTROL_PLANE_URL}/auth/desktop-revoke`);
  assert.equal(
    forwarded.init.headers.authorization,
    "Bearer signed-access-token",
  );
  assert.deepEqual(JSON.parse(new TextDecoder().decode(forwarded.init.body)), {
    scope: "all",
  });
});

test("the compatibility revocation facade is unavailable in Auth0 mode", async () => {
  const response = await handleWorkOSDesktopRevocationRequest(
    new Request("https://app.zeros.build/auth/desktop-revoke", {
      method: "POST",
      headers: {
        authorization: "Bearer token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ scope: "current" }),
    }),
    { AUTH_PROVIDER: "auth0", CONTROL_PLANE_URL },
  );
  assert.equal(response.status, 404);
});
