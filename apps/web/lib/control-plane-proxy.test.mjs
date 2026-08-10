import assert from "node:assert/strict";
import test from "node:test";
import {
  allowedControlPlaneRoute,
  cancelUnusedResponseBody,
  jsonContentTypeOrCancel,
  readBoundedBody,
  validMutationOrigin,
} from "./control-plane-policy.mjs";

const ORG = "6dfb8df2-a31d-42e1-b95f-c37a90f24955";
const USER = "de7159b8-b163-44ef-9742-a63099bc4f38";

test("proxy allow-list exposes only dashboard organization operations", () => {
  assert.equal(allowedControlPlaneRoute("GET", "/v1/me"), true);
  assert.equal(allowedControlPlaneRoute("POST", "/v1/organizations"), true);
  assert.equal(
    allowedControlPlaneRoute("PATCH", `/v1/organizations/${ORG}/members/${USER}`),
    true,
  );
  assert.equal(allowedControlPlaneRoute("GET", "/v1/github/installations"), false);
  assert.equal(allowedControlPlaneRoute("DELETE", "/v1/organizations/not-a-uuid"), false);
  assert.equal(allowedControlPlaneRoute("GET", `/v1/organizations/${ORG}/../me`), false);
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
