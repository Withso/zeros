import { randomUUID } from "node:crypto";
import type pg from "pg";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthedUser } from "../auth.js";
import { HttpError, type StaffRole } from "../authz.js";
import type { CloudWorkspaceBackendConfig } from "../config.js";
import { createCloudComputerV2Routes } from "./computer-v2-routes.js";
import { DatabaseCloudComputerV2Service } from "./computer-v2.js";
import { createCloudWorkspaceRoutes } from "./routes.js";

const pool = {} as pg.Pool,
  config = {} as CloudWorkspaceBackendConfig;
const org = randomUUID(),
  buildId = randomUUID(),
  root = `/v1/organizations/${org}/cloud-computer/v2`;
const draft = {
  expectedRevision: 0,
  repositories: [],
  installScript: "",
  timeoutSeconds: 900,
};
const operation = () => ({ expectedRevision: 0, operationId: randomUUID() });
const paths = [
  ["GET", "", undefined, "read"],
  ["PUT", "/draft", draft, "saveDraft"],
  ["POST", "/discard", { expectedRevision: 0 }, "discard"],
  ["POST", "/builds", operation(), "build"],
  ["GET", `/builds/${buildId}`, undefined, "getBuild"],
  ["GET", `/builds/${buildId}/log`, undefined, "logs"],
  ["POST", `/builds/${buildId}/cancel`, { expectedRevision: 0 }, "cancel"],
  ["POST", "/versions/1/activate", operation(), "activate"],
  ["POST", "/versions/1/rebuild", operation(), "rebuild"],
] as const;
function configure(staffRole: StaffRole | null = "developer", parent = false) {
  const service = {
    read: vi.fn().mockResolvedValue({ state: "not_built", canManage: false }),
    saveDraft: vi.fn().mockResolvedValue({ revision: 1 }),
    discard: vi.fn().mockResolvedValue({ revision: 1 }),
    build: vi.fn().mockResolvedValue({ build: { id: buildId } }),
    getBuild: vi.fn().mockResolvedValue({ id: buildId }),
    logs: vi.fn().mockResolvedValue({ entries: [] }),
    cancel: vi.fn().mockResolvedValue({ cancelled: true }),
    activate: vi.fn().mockResolvedValue({ activated: true }),
    rebuild: vi.fn().mockResolvedValue({ build: { id: buildId } }),
  };
  const app = new Hono(),
    user = { id: randomUUID(), staffRole } as AuthedUser;
  app.use("*", async (c, next) => {
    c.set("user", user);
    await next();
  });
  if (parent) {
    vi.spyOn(
      DatabaseCloudComputerV2Service.prototype,
      "saveDraft",
    ).mockImplementation(service.saveDraft);
    vi.spyOn(
      DatabaseCloudComputerV2Service.prototype,
      "logs",
    ).mockImplementation(service.logs);
    app.route("/", createCloudWorkspaceRoutes(pool, config));
  } else app.route("/", createCloudComputerV2Routes(pool, config, { service }));
  app.onError((error, c) => {
    if (error instanceof HttpError)
      return c.json(
        {
          error: error.code,
          ...(error.details ? { details: error.details } : {}),
        },
        error.status,
      );
    throw error;
  });
  const request = (method: string, suffix: string, body?: unknown) =>
    app.request(root + suffix, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    });
  return { app, service, user, request };
}
afterEach(() => {
  vi.restoreAllMocks();
});
describe("Cloud Computer v2 staff route boundary", () => {
  it.each([null, "support_admin"] as const)(
    "denies every endpoint to %s before service access",
    async (role) => {
      const { service, request } = configure(role);
      for (const [method, suffix, body] of paths) {
        const response = await request(method, suffix, body);
        expect(response.status).toBe(404);
        expect(response.headers.get("cache-control")).toBe("no-store");
      }
      for (const method of Object.values(service))
        expect(method).not.toHaveBeenCalled();
    },
  );
  it.each(["developer", "platform_owner"] as const)(
    "uses the authenticated %s actor for every route",
    async (role) => {
      const { service, request, user } = configure(role);
      for (const [method, suffix, body, name] of paths) {
        const response = await request(method, suffix, body);
        expect(response.status).toBe(
          name === "build" || name === "rebuild" ? 202 : 200,
        );
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(service[name].mock.calls[0]?.slice(0, 2)).toEqual([
          org,
          user.id,
        ]);
      }
    },
  );
  it("validates inputs before calling a service and never echoes secret input", async () => {
    const { request, service } = configure();
    const invalid: Array<[string, string, unknown]> = [
      ["PUT", "/draft", { ...draft, actorUserId: randomUUID() }],
      ["PUT", "/draft", { ...draft, installScript: "é".repeat(8193) }],
      [
        "PUT",
        "/draft",
        {
          ...draft,
          environment: [
            {
              op: "preserve",
              name: "SETTING",
              value: "synthetic-private-value",
            },
          ],
        },
      ],
      ["POST", "/discard", { expectedRevision: 0, operationId: randomUUID() }],
      ["POST", "/builds", { ...operation(), previousBuildId: randomUUID() }],
      ["POST", `/builds/${buildId}/cancel`, {}],
      ["POST", "/versions/0/activate", operation()],
      [
        "POST",
        "/versions/1/rebuild",
        { ...operation(), templateId: randomUUID() },
      ],
      ["GET", "?limit=101", undefined],
      ["GET", `?organization=${org}`, undefined],
      ["GET", `/builds/${buildId}/log?after=-1`, undefined],
      ["GET", `/builds/${buildId}/log?limit=101`, undefined],
      ["GET", "/builds/not-an-id", undefined],
    ];
    for (const [method, suffix, body] of invalid) {
      const response = await request(method, suffix, body);
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ error: "invalid_input" });
    }
    for (const method of Object.values(service))
      expect(method).not.toHaveBeenCalled();
    expect(
      (
        await request("PUT", "/draft", {
          ...draft,
          installScript: "x".repeat(262_144),
        })
      ).status,
    ).toBe(413);
  });
  it("preserves domain 409 recovery context and role failures", async () => {
    const { request, service } = configure();
    service.build.mockRejectedValue(
      new HttpError(409, "cloud_computer_build_active", "Already running", {
        currentBuildId: buildId,
      }),
    );
    const response = await request("POST", "/builds", operation());
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "cloud_computer_build_active",
      details: { currentBuildId: buildId },
    });
    for (const name of [
      "saveDraft",
      "discard",
      "build",
      "cancel",
      "activate",
      "rebuild",
    ] as const)
      service[name].mockRejectedValue(
        new HttpError(403, "forbidden", "Requires admin role"),
      );
    for (const [method, suffix, body, name] of paths)
      if (method !== "GET") {
        expect((await request(method, suffix, body)).status).toBe(403);
        expect(service[name]).toHaveBeenCalled();
      }
  });
  it("keeps v2 request bounds when mounted beside the legacy computer router", async () => {
    const { request, service } = configure("developer", true);
    const response = await request("PUT", "/draft", {
      ...draft,
      environment: [
        { op: "set", name: "FIRST_SETTING", value: "x".repeat(50_000) },
        { op: "set", name: "SECOND_SETTING", value: "y".repeat(50_000) },
      ],
    });
    expect(response.status).toBe(200);
    expect(service.saveDraft).toHaveBeenCalledOnce();
  });
  it("keeps log polling in its own rate budget when mounted beside legacy routes", async () => {
    const { request, service } = configure("developer", true);
    for (let index = 0; index < 65; index++)
      expect((await request("GET", `/builds/${buildId}/log`)).status).toBe(200);
    expect(service.logs).toHaveBeenCalledTimes(65);
  });
});
