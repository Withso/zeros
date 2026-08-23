import assert from "node:assert/strict";
import test from "node:test";

import {
  handleWorkOSDesktopRevocationRequest,
  revokeWorkOSDesktopSessions,
} from "./workos-desktop-revocation.mjs";

test("current-device revocation targets the exact verified session", async () => {
  const revoked = [];
  const listed = [];
  const result = await revokeWorkOSDesktopSessions({
    scope: "current",
    subject: "user_example",
    sessionId: "session_exact",
    provider: {
      async listSessions(subject, options) {
        listed.push({ subject, options });
        return { data: [], listMetadata: { after: null } };
      },
      async revokeSession(sessionId) {
        revoked.push(sessionId);
      },
    },
  });

  assert.deepEqual(result, { revoked: 1 });
  assert.deepEqual(revoked, ["session_exact"]);
  assert.deepEqual(listed, []);
});

test("all-device revocation paginates and revokes every active session", async () => {
  const revoked = [];
  const calls = [];
  const pages = new Map([
    [
      undefined,
      { data: [{ id: "session_1", status: "active" }], after: "next" },
    ],
    ["next", { data: [{ id: "session_2", status: "active" }], after: null }],
  ]);
  const result = await revokeWorkOSDesktopSessions({
    scope: "all",
    subject: "user_example",
    sessionId: "session_current",
    provider: {
      async listSessions(subject, options) {
        calls.push({ subject, options });
        const page = pages.get(options.after);
        return {
          data: page.data,
          listMetadata: { after: page.after },
        };
      },
      async revokeSession(sessionId) {
        revoked.push(sessionId);
      },
    },
  });

  assert.deepEqual(result, { revoked: 2 });
  assert.deepEqual(revoked.sort(), ["session_1", "session_2"]);
  assert.deepEqual(calls, [
    { subject: "user_example", options: { limit: 100 } },
    {
      subject: "user_example",
      options: { limit: 100, after: "next" },
    },
  ]);
});

test("Pages forwards only a bounded scope and bearer to the private Worker", async () => {
  let forwarded;
  const env = {
    AUTH_PROVIDER: "workos",
    AUTH_SESSIONS: {
      idFromName(name) {
        assert.equal(name, "desktop-session-management-v1");
        return name;
      },
      get() {
        return {
          async fetch(request) {
            forwarded = request;
            return Response.json({ revoked: 1 });
          },
        };
      },
    },
  };
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

  const response = await handleWorkOSDesktopRevocationRequest(request, env);
  assert.equal(response.status, 200);
  assert.equal(
    forwarded.headers.get("authorization"),
    "Bearer signed-access-token",
  );
  assert.deepEqual(await forwarded.json(), { scope: "all" });
});

test("the revocation endpoint is unavailable in Auth0 mode", async () => {
  const response = await handleWorkOSDesktopRevocationRequest(
    new Request("https://app.zeros.build/auth/desktop-revoke", {
      method: "POST",
      headers: {
        authorization: "Bearer token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ scope: "current" }),
    }),
    { AUTH_PROVIDER: "auth0" },
  );
  assert.equal(response.status, 404);
});
