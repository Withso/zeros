import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptedControlPlaneResponseType,
  allowedControlPlaneRoute,
  allowedOpsControlPlaneRoute,
  cancelUnusedResponseBody,
  jsonContentTypeOrCancel,
  readBoundedBody,
  readBoundedResponseBody,
  validMutationOrigin,
} from "./control-plane-policy.mjs";

const ORG = "6dfb8df2-a31d-42e1-b95f-c37a90f24955";
const USER = "de7159b8-b163-44ef-9742-a63099bc4f38";

test("proxy allow-list exposes only dashboard organization operations", () => {
  assert.equal(allowedControlPlaneRoute("GET", "/v1/me"), true);
  assert.equal(allowedControlPlaneRoute("GET", "/v1/auth/snapshot"), true);
  assert.equal(allowedControlPlaneRoute("GET", "/v1/auth/events"), true);
  assert.equal(allowedControlPlaneRoute("POST", "/v1/organizations"), true);
  assert.equal(allowedControlPlaneRoute("GET", "/v1/account/deletion"), true);
  assert.equal(allowedControlPlaneRoute("POST", "/v1/account/deletion"), true);
  assert.equal(
    allowedControlPlaneRoute("POST", "/v1/account/deletion/restore"),
    true,
  );
  assert.equal(allowedControlPlaneRoute("GET", "/v1/deletions"), true);
  assert.equal(
    allowedControlPlaneRoute("POST", `/v1/organizations/${ORG}/restore`),
    true,
  );
  assert.equal(
    allowedControlPlaneRoute("PATCH", `/v1/organizations/${ORG}/members/${USER}`),
    true,
  );
  assert.equal(allowedControlPlaneRoute("GET", "/v1/github/installations"), false);
  assert.equal(allowedControlPlaneRoute("DELETE", "/v1/organizations/not-a-uuid"), false);
  assert.equal(allowedControlPlaneRoute("GET", `/v1/organizations/${ORG}/../me`), false);
});

test("Ops proxy exposes only exact-code staff lifecycle routes", () => {
  assert.equal(allowedOpsControlPlaneRoute("GET", "/v1/ops/session"), true);
  assert.equal(
    allowedOpsControlPlaneRoute(
      "POST",
      "/v1/ops/deletions/ZD-ABCD-2345/lookup",
    ),
    true,
  );
  assert.equal(
    allowedOpsControlPlaneRoute(
      "POST",
      "/v1/internal/account-recoveries/ZR-ABCD-2345/approve",
    ),
    true,
  );
  assert.equal(allowedOpsControlPlaneRoute("GET", "/v1/me"), false);
  assert.equal(
    allowedOpsControlPlaneRoute(
      "POST",
      "/v1/ops/deletions/not-a-code/restore",
    ),
    false,
  );
  assert.equal(allowedOpsControlPlaneRoute("GET", "/v1/ops/users"), false);
});

test("proxy accepts JSON snapshots and SSE streams only on their exact routes", () => {
  assert.equal(
    acceptedControlPlaneResponseType(
      "/v1/auth/events",
      "text/event-stream; charset=utf-8",
    ),
    "sse",
  );
  assert.equal(
    acceptedControlPlaneResponseType("/v1/auth/events", "application/json"),
    null,
  );
  assert.equal(
    acceptedControlPlaneResponseType("/v1/auth/snapshot", "application/json"),
    "json",
  );
  assert.equal(
    acceptedControlPlaneResponseType("/v1/me", "text/event-stream"),
    null,
  );
});

test("mutations require same-origin JSON plus a non-simple dashboard header", () => {
  const good = new Request(`https://app.zeros.build/api/v1/organizations/${ORG}`, {
    method: "PATCH",
    headers: {
      origin: "https://app.zeros.build",
      "content-type": "application/json",
      "x-zeros-request": "dashboard",
    },
    body: "{}",
  });
  assert.equal(validMutationOrigin(good), true);
  assert.equal(
    validMutationOrigin(
      new Request(good.url, {
        method: "PATCH",
        headers: {
          origin: "https://evil.example",
          "content-type": "application/json",
          "x-zeros-request": "dashboard",
        },
        body: "{}",
      }),
    ),
    false,
  );
  assert.equal(validMutationOrigin(new Request(good.url)), true);
  assert.equal(
    validMutationOrigin(
      new Request(good.url, {
        method: "PATCH",
        headers: {
          origin: "https://app.zeros.build",
          "content-type": "application/jsonp",
          "x-zeros-request": "dashboard",
        },
        body: "{}",
      }),
    ),
    false,
  );
});

test("chunked request bodies stop at the proxy limit instead of buffering the tail", async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3, 4]));
      controller.enqueue(new Uint8Array([5, 6, 7, 8]));
    },
    cancel() {
      cancelled = true;
    },
  });
  const request = new Request("https://app.zeros.build/api/v1/organizations", {
    method: "POST",
    body: stream,
    duplex: "half",
  });

  assert.deepEqual(await readBoundedBody(request, 5), { ok: false });
  assert.equal(cancelled, true);
});

test("bounded request bodies are replayable exact bytes", async () => {
  const request = new Request("https://app.zeros.build/api/v1/organizations", {
    method: "POST",
    body: "{}",
  });
  const result = await readBoundedBody(request, 8);
  assert.equal(result.ok, true);
  assert.equal(new TextDecoder().decode(result.body), "{}");
});

test("oversized upstream JSON is cancelled before it can cross the browser boundary", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(6));
        controller.enqueue(new Uint8Array(6));
      },
      cancel() {
        cancelled = true;
      },
    }),
    { headers: { "content-type": "application/json" } },
  );

  assert.deepEqual(await readBoundedResponseBody(response, 8), { ok: false });
  assert.equal(cancelled, true);
});

test("declared oversized upstream JSON is rejected without reading it", async () => {
  let pulled = false;
  const response = new Response(
    new ReadableStream({
      pull(controller) {
        pulled = true;
        controller.enqueue(new Uint8Array(1));
      },
    }),
    { headers: { "content-length": "999" } },
  );

  assert.deepEqual(await readBoundedResponseBody(response, 8), { ok: false });
  assert.equal(pulled, false);
});

test("a superseded upstream response releases its unread body", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"error":"expired"}'));
      },
      cancel() {
        cancelled = true;
      },
    }),
    { status: 401 },
  );

  await cancelUnusedResponseBody(response);

  assert.equal(cancelled, true);
});

test("a non-JSON upstream response is released before proxy rejection", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("<h1>Bad gateway</h1>"));
      },
      cancel() {
        cancelled = true;
      },
    }),
    { headers: { "content-type": "text/html" } },
  );

  assert.equal(await jsonContentTypeOrCancel(response), null);
  assert.equal(cancelled, true);
});
