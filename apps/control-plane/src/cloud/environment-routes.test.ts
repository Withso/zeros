import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../authz.js";
import { createCloudEnvironmentRoutes } from "./environment-routes.js";
import type { CloudEnvironmentMetadata } from "./environment-contract.js";

function fixture() {
  const userId = randomUUID(), org = randomUUID();
  const metadata: CloudEnvironmentMetadata = { repositoryId: "42", revision: 1, versionId: randomUUID(), updatedAt: new Date().toISOString(),
    variables: [{ name: "APP_SECRET", bytes: 27 }], files: [{ path: "private/.env.local", bytes: 35 }] };
  const store = { get: vi.fn(async () => metadata), patch: vi.fn(async () => metadata) };
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("user", { id: userId } as never); await next(); });
  app.onError((error, c) => error instanceof HttpError ? c.json({ error: { code: error.code } }, error.status) : c.json({ error: { code: "internal" } }, 500));
  app.route("/", createCloudEnvironmentRoutes(store));
  const path = `/v1/cloud-v2/organizations/${org}/environment/42?repository=fixture%2Frepo`;
  return { app, path, store, metadata, userId, org };
}
describe("cloud environment HTTP boundary", () => {
  it("returns only metadata and derives the creator from authentication for reads and writes", async () => {
    const f = fixture();
    const read = await f.app.request(f.path);
    expect(read.status).toBe(200); expect(read.headers.get("cache-control")).toBe("no-store");
    expect(await read.json()).toEqual({ environment: f.metadata });
    expect(f.store.get).toHaveBeenCalledExactlyOnceWith(f.org, f.userId, "42", "fixture/repo");
    const patch = { expectedRevision: 1, variables: { APP_SECRET: 'synthetic-canary-"quote"\nnew' } };
    const response = await f.app.request(f.path, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ environment: f.metadata });
    expect(f.store.patch).toHaveBeenCalledExactlyOnceWith(f.org, f.userId, "42", "fixture/repo", patch);
  });
  it("refuses malformed scope and oversized bodies before the store", async () => {
    const f = fixture();
    for (const path of [f.path.replace("/42?", "/042?"), f.path.replace("fixture%2Frepo", "fixture%2Frepo%0A"), f.path.replace(f.org, "invalid")])
      expect((await f.app.request(path)).status).toBe(422);
    expect(f.store.get).not.toHaveBeenCalled();
    const response = await f.app.request(f.path, { method: "PATCH", body: "x".repeat(2 * 1024 * 1024 + 1) });
    expect(response.status).toBe(413); expect(f.store.patch).not.toHaveBeenCalled();
  });
  it("never serializes unexpected stored fields through a metadata read", async () => {
    const f = fixture();
    f.store.get.mockResolvedValue({ ...f.metadata, secret: 'synthetic-canary-"quote"\nnew' } as CloudEnvironmentMetadata);
    const response = await f.app.request(f.path);
    expect(response.status).toBe(500); expect(await response.json()).toEqual({ error: { code: "internal" } });
  });
});
