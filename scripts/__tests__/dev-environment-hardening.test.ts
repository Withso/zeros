import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { workspaceIdentity, OWNER_BINDING, derivedWorkspaceIdentity } from "../dev-environment/state.mjs";
import { resolveHostedOwner, newHostedGeneration } from "../dev-environment/hosted-state.mjs";
import { run } from "../dev-environment/processes.mjs";
import { archiveHosted } from "../dev-environment/hosted-lifecycle.mjs";

it("refuses to read a binding through a linked private parent", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dev-linked-binding-"));
  try {
    const checkout = path.join(root, "checkout"); fs.mkdirSync(checkout); workspaceIdentity(checkout, {});
    fs.renameSync(path.join(checkout, ".context"), path.join(root, "private"));
    fs.symlinkSync(path.join(root, "private"), path.join(checkout, ".context"));
    expect(() => workspaceIdentity(checkout, {})).toThrow(/private/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
it("discovers a legacy receipt read-only without pinning doctor to that owner", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dev-readonly-owner-"));
  try {
    const derived = derivedWorkspaceIdentity(root, {}), state = newHostedGeneration(derived);
    const owner = await resolveHostedOwner({ read: async () => ({ state }) }, root, {}, { create: false, readonly: true });
    expect(owner.owner).toBe(derived.owner);
    expect(fs.existsSync(path.join(root, OWNER_BINDING))).toBe(false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
it("finishes successfully once the final owned descendant exits after its parent", async () => {
  const result = await run(process.execPath, ["-e", `
    require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 100)'], { stdio: 'ignore' }).unref();
  `], { timeout: 1500 }).then(() => "completed", () => "failed");
  expect(result).toBe("completed");
});
it("applies connection-service protection to ordinary archive before any mutation", async () => {
  const state = newHostedGeneration({ owner: "a".repeat(24), identity: "test" });
  state.resources.railway = { serviceId: "connection-service" };
  const profile: any = { railway: { projectId: "p", serviceId: "connection-service", protectedEnvironmentIds: [] },
    planetscale: { organization: "org", database: "db", protectedBranch: "main" }, cloudflare: {}, registry: { bucket: "registry", encryptionKey: "a".repeat(64) }, storage: { bucket: "objects" }, boat: {},
    protectedResources: { railwayServices: ["connection-service"] } };
  const stop = vi.fn(), lease = { state, save: vi.fn(), fence: vi.fn() };
  await expect(archiveHosted(lease, profile, { stopBackend: stop })).rejects.toThrow(/Protected/);
  expect(stop).not.toHaveBeenCalled();
});
