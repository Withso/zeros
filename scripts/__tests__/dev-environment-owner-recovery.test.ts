import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as owners from "../dev-environment/state.mjs";
import * as recovery from "../dev-environment/hosted-state.mjs";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dev-owner-recovery-")); roots.push(root);
  const legacy = owners.derivedWorkspaceIdentity(root, {});
  const record = { state: recovery.newHostedGeneration(legacy), etag: "1" };
  const store = { read: vi.fn(async (owner: string) => owner === legacy.owner ? record : null) };
  return { root, legacy, record, store };
}
it("adopts an existing path-derived registry key without renaming live resources", async () => {
  const f = fixture();
  const identity = await (recovery as any).resolveHostedOwner(f.store, f.root, {});
  expect(identity.owner).toBe(f.legacy.owner);
  expect(owners.workspaceIdentity(f.root, {}).owner).toBe(f.legacy.owner);
});
it("authenticates an explicitly selected generation and refuses stale archive selection", async () => {
  const f = fixture();
  await expect((recovery as any).selectHostedOwner(f.store, f.legacy.owner, "11111111-1111-4111-8111-111111111111")).rejects.toThrow(/generation/);
  expect((await (recovery as any).selectHostedOwner(f.store, f.legacy.owner, f.record.state.generation)).owner).toBe(f.legacy.owner);
});
it("never reports absence for a pinned checkout when an alternate legacy receipt exists", async () => {
  const f = fixture(); owners.workspaceIdentity(f.root, {});
  await expect((recovery as any).resolveHostedOwner(f.store, f.root, {})).rejects.toThrow(/bound|doctor|adopt/);
});
it("explicitly replaces an unused binding after authenticating the selected legacy generation", async () => {
  const f = fixture(); owners.workspaceIdentity(f.root, {});
  await (recovery as any).adoptHostedOwner(f.store, f.root, f.legacy.owner, f.record.state.generation, {});
  expect(owners.workspaceIdentity(f.root, {}).owner).toBe(f.legacy.owner);
});
it("refuses to abandon a bound active generation during adoption", async () => {
  const f = fixture(), bound = owners.workspaceIdentity(f.root, {}), active = recovery.newHostedGeneration(bound);
  f.store.read.mockImplementation(async owner => owner === bound.owner ? { state: active, etag: "1" } : f.record);
  await expect((recovery as any).adoptHostedOwner(f.store, f.root, f.legacy.owner, f.record.state.generation, {})).rejects.toThrow(/archive|active/);
  expect(owners.workspaceIdentity(f.root, {}).owner).toBe(bound.owner);
});
