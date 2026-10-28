import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../authz.js";
import { createCloudGithubConnectionRoutes } from "./github-connection-routes.js";
import type { CloudGithubConnections } from "./github-connections.js";

const organizationId = "11111111-1111-4111-8111-111111111111";
const generation = "a".repeat(64);
const status = {
  generation,
  selectedMethod: null,
  appAvailable: true,
  installUrl: "https://github.com/apps/example/installations/new",
  methods: {
    "github-app": { configured: false, health: "not-connected" },
    pat: { configured: false, health: "not-connected" },
  },
};

function fixture() {
  const userId = randomUUID();
  const service = {
    status: vi.fn(async () => ({
      ...status,
      accessToken: "secret-projection-canary",
    })),
    repositories: vi.fn(async () => ({
      generation,
      repositories: [],
      nextPage: null,
      complete: true,
      token: "secret-projection-canary",
    })),
    begin: vi.fn(async () => ({
      generation,
      url: "https://github.com/login/oauth/authorize?state=synthetic",
      verifier: "secret-projection-canary",
    })),
    connectPat: vi.fn(async () => {}),
    store: {
      select: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
      cancelOauth: vi.fn(async () => {}),
    },
  };
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("user", { id: userId } as never);
    await next();
  });
  app.onError((error, c) =>
    error instanceof HttpError
      ? c.json({ error: { code: error.code } }, error.status)
      : error instanceof HTTPException
        ? error.getResponse()
        : c.json({ error: { code: "internal" } }, 500),
  );
  app.route(
    "/",
    createCloudGithubConnectionRoutes(
      service as unknown as CloudGithubConnections,
    ),
  );
  const post = (body: unknown) =>
    app.request("/v1/cloud-v2/github/connection", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { app, post, service, scope: { organizationId, userId } };
}

describe("cloud GitHub connection HTTP boundary", () => {
  it("scopes reads to the authenticated person and strips fields outside the public schemas", async () => {
    const f = fixture();
    for (const path of ["connection", "repositories"]) {
      const response = await f.app.request(
        `/v1/cloud-v2/github/${path}?organizationId=${organizationId}`,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).not.toContain("secret-projection-canary");
    }
    expect(f.service.status).toHaveBeenCalledWith(f.scope);
    expect(f.service.repositories).toHaveBeenCalledWith(f.scope, 1);
  });

  it("passes a PAT only to its scoped save operation and never includes it in a response", async () => {
    const f = fixture();
    const response = await f.post({
      organizationId,
      expected: generation,
      action: "pat",
      token: "synthetic-personal-token",
    });
    expect(response.status).toBe(200);
    expect(f.service.connectPat).toHaveBeenCalledExactlyOnceWith(
      f.scope,
      generation,
      "synthetic-personal-token",
    );
    expect(await response.json()).toEqual(status);
  });

  it.each(["select", "disconnect", "cancel", "oauth"] as const)(
    "fences %s with the supplied generation and authenticated scope",
    async (action) => {
      const f = fixture();
      const response = await f.post({
        organizationId,
        expected: generation,
        action,
        ...(["select", "disconnect"].includes(action) ? { method: "pat" } : {}),
      });
      expect(response.status).toBe(200);
      if (action === "oauth")
        expect(f.service.begin).toHaveBeenCalledExactlyOnceWith(
          f.scope,
          generation,
        );
      else if (action === "cancel")
        expect(f.service.store.cancelOauth).toHaveBeenCalledExactlyOnceWith(
          f.scope,
          generation,
        );
      else
        expect(f.service.store[action]).toHaveBeenCalledExactlyOnceWith(
          f.scope,
          generation,
          "pat",
        );
      expect(await response.text()).not.toContain("secret-projection-canary");
    },
  );

  it("rejects supplied identities, invalid generations, extra fields and oversized input before calling services", async () => {
    const f = fixture();
    for (const body of [
      {
        organizationId,
        expected: generation,
        action: "pat",
        token: "synthetic",
        userId: randomUUID(),
      },
      { organizationId, expected: "stale", action: "select", method: "pat" },
      {
        organizationId,
        expected: generation,
        action: "oauth",
        unexpected: true,
      },
    ])
      expect((await f.post(body)).status).toBe(422);
    expect(
      (
        await f.post({
          organizationId,
          expected: generation,
          action: "pat",
          token: "x".repeat(9000),
        })
      ).status,
    ).toBe(413);
    expect(f.service.connectPat).not.toHaveBeenCalled();
    expect(f.service.store.select).not.toHaveBeenCalled();
    expect(f.service.begin).not.toHaveBeenCalled();
    for (const page of ["0", "101", "NaN"])
      expect(
        (
          await f.app.request(
            `/v1/cloud-v2/github/repositories?organizationId=${organizationId}&page=${page}`,
          )
        ).status,
      ).toBe(422);
    expect(f.service.repositories).not.toHaveBeenCalled();
  });

  it("retains generation and membership rejections instead of returning a connection snapshot", async () => {
    const f = fixture();
    f.service.store.disconnect.mockRejectedValueOnce(
      new HttpError(409, "github_authorization_changed", "Changed"),
    );
    expect(
      (
        await f.post({
          organizationId,
          expected: generation,
          action: "disconnect",
          method: "pat",
        })
      ).status,
    ).toBe(409);
    expect(f.service.status).not.toHaveBeenCalled();
    f.service.status.mockRejectedValueOnce(
      new HttpError(404, "not_found", "Unavailable"),
    );
    expect(
      (
        await f.app.request(
          `/v1/cloud-v2/github/connection?organizationId=${organizationId}`,
        )
      ).status,
    ).toBe(404);
  });
});
