import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// Pages resolves extensionless TypeScript imports; Node's test runner does not.
const hook = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL === new URL("./control-plane-proxy.ts", import.meta.url).href && specifier === "./session")
    return next("./session.ts", context);
  return next(specifier, context);
} });
const { proxyControlPlane } = await import("./control-plane-proxy.ts");
hook.deregister();

const org = "6dfb8df2-a31d-42e1-b95f-c37a90f24955", keyId = "de7159b8-b163-44ef-9742-a63099bc4f38";
const base = "https://app.example.test", upstream = "https://api.example.test";
const verified = { sessionId: "synthetic-session", data: { sub: "user", email: "user@example.test", name: null,
  accessToken: "synthetic-session-bearer", refreshToken: null } };
const request = (method, suffix = "", body) => new Request(`${base}/api/v1/organizations/${org}/api-keys${suffix}`, {
  method, headers: { origin: base, "content-type": "application/json", "x-zeros-request": "dashboard", authorization: "Bearer untrusted-browser-value" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

test("API key requests use the verified server session and preserve the one-time create response", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls++;
    assert.equal(url, `${upstream}/v1/organizations/${org}/api-keys`);
    assert.equal(init.headers.authorization === `Bearer ${verified.data.accessToken}`, true);
    assert.equal(init.method, "POST");
    assert.equal(new TextDecoder().decode(init.body), JSON.stringify({ name: "Automation" }));
    return Response.json({ apiKey: { id: keyId, name: "Automation", prefix: "zk_test" }, key: "synthetic-once" }, { status: 201 });
  });
  const response = await proxyControlPlane(request("POST", "", { name: "Automation" }), { CONTROL_PLANE_URL: upstream }, verified);
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const result = await response.json();
  assert.equal(result.key === "synthetic-once", true);
  assert.equal(calls, 1);
});

test("API key revocation accepts a bodyless 204 without relaxing upstream response validation", async t => {
  let html = false;
  t.mock.method(globalThis, "fetch", async () => html ? new Response("<html>upstream error</html>", {
    headers: { "content-type": "text/html" },
  }) : new Response(null, { status: 204 }));
  const response = await proxyControlPlane(request("DELETE", `/${keyId}`, {}), { CONTROL_PLANE_URL: upstream }, verified);
  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
  assert.equal(response.headers.get("cache-control"), "no-store");
  html = true;
  const invalid = await proxyControlPlane(request("GET"), { CONTROL_PLANE_URL: upstream }, verified);
  assert.equal(invalid.status, 502);
  assert.equal((await invalid.json()).error.code, "bad_gateway");
});
