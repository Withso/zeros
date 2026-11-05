import { beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ user: "user-a", epoch: 1, organization: "11111111-1111-4111-8111-111111111111",
  member: true, listeners: new Set<() => void>(), request: vi.fn() }));
vi.mock("../../team/control-plane", () => ({ CONTROL_PLANE_URL: "https://control.example.test" }));
vi.mock("../../team/active-team", () => ({ getActiveTeamId: () => f.organization,
  subscribeActiveTeam: (callback: () => void) => { f.listeners.add(callback); return () => f.listeners.delete(callback); } }));
vi.mock("../../team/team-store", () => ({
  getTeamStoreState: () => ({ me: { user: { id: f.user }, organizations: f.member ? [{ id: f.organization, isPersonal: false, workspaceCapabilities: { cloud: true } }] : [] } }),
  getOrganizationStoreGeneration: () => f.epoch,
  subscribeOrganizationSnapshots: (callback: () => void) => { f.listeners.add(callback); return () => f.listeners.delete(callback); },
}));
vi.mock("../../../platform/cloud-workspaces", () => ({ cloudAccountRequest: f.request }));

import { cloudEnvironmentCache, cloudEnvironmentKey, cloudEnvironmentError, readCloudEnvironment,
  saveCloudEnvironment, saveCloudEnvironmentFile } from "../cloud-environment-api";

const repository = { id: "123", owner: "team", name: "project" };
const metadata = (revision = 1) => ({ repositoryId: "123", revision, versionId: "22222222-2222-4222-8222-222222222222",
  updatedAt: "2026-01-01T00:00:00Z", variables: [{ name: "APP_SECRET", bytes: 20 }], files: [] });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const notify = () => { for (const callback of f.listeners) callback(); };

beforeEach(() => { f.user = "user-a"; f.epoch++; f.organization = "11111111-1111-4111-8111-111111111111"; f.member = true;
  f.request.mockReset(); f.request.mockImplementation(async (_path, schema) => schema.parse({ environment: metadata() })); });

describe("creator-private cloud environment settings", () => {
  it("sends values only in the explicit PATCH and caches metadata only", async () => {
    const key = cloudEnvironmentKey(f.organization, repository);
    const canary = "synthetic-write-only-value";
    const saved = await saveCloudEnvironment(key, { expectedRevision: 0, variables: { APP_SECRET: canary } });
    expect(f.request.mock.calls[0]?.[0]).toBe(`/v1/cloud-v2/organizations/${f.organization}/environment/123?repository=team%2Fproject`);
    expect(f.request.mock.calls[0]?.[2]).toMatchObject({ method: "PATCH", body: { variables: { APP_SECRET: canary } } });
    expect(JSON.stringify([saved, cloudEnvironmentCache.getSnapshot(key)]).includes(canary)).toBe(false);
    expect(saved.variables).toEqual([{ name: "APP_SECRET", bytes: 20 }]);
  });
  it("refuses a value-bearing metadata response and never publishes it", async () => {
    const key = cloudEnvironmentKey(f.organization, repository);
    f.request.mockImplementation(async (_path, schema) => schema.parse({ environment: { ...metadata(), variables: [{ name: "APP_SECRET", bytes: 20, value: "synthetic-canary" }] } }));
    await expect(saveCloudEnvironment(key, { expectedRevision: 0, clear: true })).rejects.toThrow();
    expect(cloudEnvironmentCache.getSnapshot(key).data).toBeUndefined();
  });
  it.each(["account", "organization", "membership", "hidden"])("cancels a held file read on %s retirement before sending", async reason => {
    const key = cloudEnvironmentKey(f.organization, repository), held = deferred<string>(), controller = new AbortController();
    const pending = saveCloudEnvironmentFile(key, 0, ".env.local", { size: 30, text: () => held.promise }, controller.signal);
    if (reason === "account") { f.epoch++; f.user = "user-b"; }
    if (reason === "organization") f.organization = "33333333-3333-4333-8333-333333333333";
    if (reason === "membership") f.member = false;
    if (reason === "hidden") controller.abort();
    notify(); held.resolve("VALUE=synthetic-only");
    await expect(pending).rejects.toThrow(); expect(f.request).not.toHaveBeenCalled();
  });
  it("keeps the selected path and repository captured before file I/O", async () => {
    const key = cloudEnvironmentKey(f.organization, repository), held = deferred<string>();
    const pending = saveCloudEnvironmentFile(key, 3, "config/.env.local", { size: 30, text: () => held.promise });
    const other = cloudEnvironmentKey(f.organization, { ...repository, id: "456" });
    held.resolve("VALUE=synthetic-only"); await pending;
    expect(f.request.mock.calls[0]?.[2].body).toEqual({ expectedRevision: 3, files: [{ path: "config/.env.local", content: "VALUE=synthetic-only" }] });
    expect(cloudEnvironmentCache.getSnapshot(other).data).toBeUndefined();
  });
  it.each(["read", "write"])("rejects a late %s after account A → B → A", async mode => {
    const key = cloudEnvironmentKey(f.organization, repository), held = deferred<unknown>();
    f.request.mockImplementation(() => held.promise);
    const pending = mode === "read" ? readCloudEnvironment(key) : saveCloudEnvironment(key, { expectedRevision: 0, clear: true });
    f.epoch += 2; notify(); held.resolve({ environment: metadata() });
    await expect(pending).rejects.toThrow(); expect(cloudEnvironmentCache.getSnapshot(key).data).toBeUndefined();
  });
  it("refuses reserved names and oversized files before I/O", async () => {
    const key = cloudEnvironmentKey(f.organization, repository), text = vi.fn();
    await expect(saveCloudEnvironment(key, { expectedRevision: 0, variables: { GH_TOKEN: "synthetic" } })).rejects.toThrow();
    await expect(saveCloudEnvironmentFile(key, 0, ".env", { size: 65537, text })).rejects.toThrow();
    expect(text).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
  });
  it("a late read cannot replace a confirmed write or cross repositories", async () => {
    const key = cloudEnvironmentKey(f.organization, repository), held = deferred<unknown>();
    f.request.mockImplementationOnce(() => held.promise);
    const pending = cloudEnvironmentCache.load(key, () => readCloudEnvironment(key));
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(1));
    f.request.mockImplementation(async (_path, schema) => schema.parse({ environment: metadata(2) }));
    await saveCloudEnvironment(key, { expectedRevision: 1, variables: { NEXT: "synthetic" } });
    held.resolve({ environment: metadata(1) }); await pending;
    expect(cloudEnvironmentCache.getSnapshot(key).data?.revision).toBe(2);
    f.request.mockImplementation(async (_path, schema) => schema.parse({ environment: { ...metadata(), repositoryId: "456" } }));
    await expect(readCloudEnvironment(key)).rejects.toThrow();
  });
  it("renders only closed error copy, including arbitrary server messages", () => {
    const canary = "synthetic-app-canary";
    expect(cloudEnvironmentError(Object.assign(new Error(canary), { code: "cloud_environment_changed" }))).toContain("changed elsewhere");
    expect(cloudEnvironmentError(new Error(canary)).includes(canary)).toBe(false);
  });
});
