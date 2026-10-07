import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CloudPortForwardingPreferences } from "../cloud-workspace-port-forwarding-store";

const roots: string[] = [];
const owner = { accountId: "account-a", deviceId: "11111111-1111-4111-8111-111111111111", organizationId: "22222222-2222-4222-8222-222222222222", workspaceId: "33333333-3333-4333-8333-333333333333" };
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "zeros-forward-prefs-"));
  roots.push(root);
  return path.join(root, "preferences.json");
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("main cloud forwarding preferences", () => {
  it("defaults forwarding off and auto on without creating persisted entries on read", async () => {
    const filePath = await fixture(), store = new CloudPortForwardingPreferences(filePath);
    expect(store.read(owner)).toEqual({ forwardingEnabled: false, autoForwardEnabled: true });
    await expect(readFile(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("restores exact account/device/org/workspace intent and keeps all other owners isolated", async () => {
    const filePath = await fixture(), store = new CloudPortForwardingPreferences(filePath);
    store.set(owner, { forwardingEnabled: true, autoForwardEnabled: false });
    const restored = new CloudPortForwardingPreferences(filePath);
    expect(restored.read(owner)).toEqual({ forwardingEnabled: true, autoForwardEnabled: false });
    for (const other of [{ ...owner, accountId: "account-b" }, { ...owner, deviceId: owner.workspaceId }, { ...owner, organizationId: owner.workspaceId }, { ...owner, workspaceId: owner.organizationId }])
      expect(restored.read(other)).toEqual({ forwardingEnabled: false, autoForwardEnabled: true });
    expect(await readFile(filePath, "utf8")).not.toContain(owner.accountId);
  });
  it("bounds entries and prunes exact workspace and account owners without losing siblings", async () => {
    const filePath = await fixture(), store = new CloudPortForwardingPreferences(filePath, { maxEntries: 2 });
    const otherWorkspace = { ...owner, workspaceId: owner.organizationId }, otherAccount = { ...owner, accountId: "account-b" };
    store.set(owner, { forwardingEnabled: true });
    store.set(otherWorkspace, { forwardingEnabled: true });
    store.set(otherAccount, { forwardingEnabled: true });
    expect(store.read(owner).forwardingEnabled).toBe(false);
    store.removeWorkspace(owner);
    expect(store.read(otherWorkspace).forwardingEnabled).toBe(true);
    expect(store.read(otherAccount).forwardingEnabled).toBe(false);
    store.removeAccount(owner.accountId);
    expect(new CloudPortForwardingPreferences(filePath).read(otherWorkspace).forwardingEnabled).toBe(false);
  });
  it("fails closed on corrupt or oversized persisted data and malformed preference updates", async () => {
    const filePath = await fixture();
    for (const document of ["{", JSON.stringify({ version: 1, entries: [{ forwardingEnabled: "true" }] }), " ".repeat(65537)]) {
      await writeFile(filePath, document);
      const store = new CloudPortForwardingPreferences(filePath);
      expect(store.read(owner).forwardingEnabled).toBe(false);
      expect(() => store.set(owner, { forwardingEnabled: "true" as unknown as boolean })).toThrow();
    }
  });
  it("keeps omitted switches boolean when a partial update explicitly contains undefined", async () => {
    const filePath = await fixture(), store = new CloudPortForwardingPreferences(filePath);
    expect(store.set(owner, { forwardingEnabled: true, autoForwardEnabled: undefined })).toEqual({ forwardingEnabled: true, autoForwardEnabled: true });
    expect(new CloudPortForwardingPreferences(filePath).read(owner)).toEqual({ forwardingEnabled: true, autoForwardEnabled: true });
  });
});
