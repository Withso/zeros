import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ generation: 1, request: vi.fn() }));
vi.mock("../../../platform/cloud-workspaces", () => ({ cloudAccountRequest: state.request }));
vi.mock("../../team/team-store", () => ({ getOrganizationStoreGeneration: () => state.generation }));
import { CloudCustomizationSettingsSchema, cloudCustomizationKey, cloudCustomizationCache, customizationDocument } from "../cloud-customization-client";

describe("cloud customization settings ownership", () => {
  const scope = { revision: 1, servers: [{ id: randomUUID(), name: "remote", transport: "http", url: "https://example.test/mcp", secretRef: randomUUID(), headerKeys: ["Authorization"], envKeys: [] }], skills: [], cursorTeamSettings: "disabled" };
  const snapshot = () => CloudCustomizationSettingsSchema.parse({ organization: scope, member: { ...scope, servers: [] }, canManage: true, oauth: "unsupported", cursorTeamSettings: "unsupported" });
  it("isolates accounts, organizations and replacement sessions while retaining the exact snapshot", async () => {
    const a = cloudCustomizationKey("actor-a", "org"), b = cloudCustomizationKey("actor-b", "org"), c = cloudCustomizationKey("actor-a", "other-org");
    const value = snapshot(); cloudCustomizationCache.setData(a, value);
    expect(cloudCustomizationCache.getSnapshot(b).data).toBeUndefined(); expect(cloudCustomizationCache.getSnapshot(c).data).toBeUndefined();
    cloudCustomizationCache.invalidate(a); expect(cloudCustomizationCache.getSnapshot(a).data).toBe(value);
    state.generation++; expect(cloudCustomizationCache.getSnapshot(cloudCustomizationKey("actor-a", "org")).data).toBeUndefined();
  });
  it("keeps omitted secrets intact on skill edits and rejects secret-bearing public responses", () => {
    const value = snapshot(), document = customizationDocument(value.organization);
    expect(document.servers[0]).not.toHaveProperty("headers"); expect(document.servers[0]).not.toHaveProperty("secretRef");
    expect(CloudCustomizationSettingsSchema.safeParse({ ...value, organization: { ...scope, servers: [{ ...scope.servers[0], headers: { Authorization: "should-not-return" } }] } }).success).toBe(false);
  });
  it("shares revalidation and prevents a late response from overwriting a saved revision or another actor", async () => {
    const key = cloudCustomizationKey("race-actor", "race-org"), other = cloudCustomizationKey("next-actor", "race-org");
    const confirmed = snapshot(); cloudCustomizationCache.setData(key, confirmed);
    let resolve!: (value: typeof confirmed) => void;
    const fetcher = vi.fn(() => new Promise<typeof confirmed>(done => { resolve = done; }));
    const first = cloudCustomizationCache.load(key, fetcher, { force: true });
    const second = cloudCustomizationCache.load(key, fetcher, { force: true });
    await Promise.resolve();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(cloudCustomizationCache.getSnapshot(key).data).toBe(confirmed);
    expect(cloudCustomizationCache.getSnapshot(other).data).toBeUndefined();
    const saved = { ...confirmed, organization: { ...confirmed.organization, revision: 2 } };
    cloudCustomizationCache.setData(key, saved);
    resolve(confirmed); await Promise.all([first, second]);
    expect(cloudCustomizationCache.getSnapshot(key).data).toBe(saved);
    expect(cloudCustomizationCache.getSnapshot(other).data).toBeUndefined();
  });
});
