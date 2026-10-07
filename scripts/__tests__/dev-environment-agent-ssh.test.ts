import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { ensureDevRailwayCli, retireHostedAgentSsh, startHostedAgentOverSsh } from "../dev-environment/hosted-agent-ssh.mjs";
import { railwayEnvironmentName } from "../dev-environment/railway.mjs";

function fixture() {
  const bytes = Buffer.from("synthetic-public-key"), fingerprint = "SHA256:" + createHash("sha256").update(bytes).digest("base64").replace(/=+$/, "");
  const key = { projectId: "test-project", publicKey: `ssh-ed25519 ${bytes.toString("base64")}`, fingerprint, privateKey: "private-key-sentinel", create: { version: 1, phase: "planned" } };
  const state: any = { owner: "a".repeat(24), generation: "11111111-1111-4111-8111-111111111111", resources: { agentSsh: key } };
  state.resources.railway = { id: "22222222-2222-4222-8222-222222222222", name: railwayEnvironmentName(state), projectId: key.projectId, serviceId: "test-service" };
  const lease: any = { state, save: vi.fn(), fence: vi.fn() };
  const registered = [{ id: "other", fingerprint: "SHA256:unrelated" }, { id: "owned", fingerprint }];
  const request = vi.fn(async (query, variables) => {
    if (query.includes("query DevEnvironments")) return { environments: { edges: [{ node: state.resources.railway }], pageInfo: { hasNextPage: false } } };
    if (query.includes("query DevSshKeys")) return { sshPublicKeys: { edges: registered.map(node => ({ node })), pageInfo: { hasNextPage: false } } };
    if (query.includes("mutation CreateDevSshKey")) { expect(variables.input.publicKey).toBe(key.publicKey); registered.push({ id: "owned", fingerprint }); return { sshPublicKeyCreate: { id: "owned", fingerprint } }; }
    expect(query).toContain("mutation DeleteDevSshKey"); expect(variables).toEqual({ id: "owned" });
    registered.splice(registered.findIndex(row => row.id === variables.id), 1); return { sshPublicKeyDelete: true };
  });
  const execute = vi.fn(async (_command, args) => {
    if (args[0] === "--version") return "railway 5.47.1";
    // The pinned CLI scans only ~/.ssh and the SSH agent, even with --key.
    // Registration must not depend on scanning or modifying a user's keys.
    if (args[1] === "keys") throw new Error("Key outside ~/.ssh cannot be discovered");
    expect(args).toContain("/app/dist/dev-agent-qualification.js"); return '{"started":true}';
  });
  return { key, lease, execute, request, registered, profile: { railway: { projectId: key.projectId, serviceId: "test-service", protectedEnvironmentIds: ["protected"], apiToken: "private-token-sentinel" } } };
}
it("reconciles a lost SSH registration response and revokes only the receipt's exact key", async () => {
  const f = fixture(); await retireHostedAgentSsh(f.lease, f.profile, f.request);
  expect(f.lease.state.resources.agentSsh).toBeUndefined(); expect(f.lease.fence).toHaveBeenCalledOnce();
  expect(f.registered).toEqual([{ id: "other", fingerprint: "SHA256:unrelated" }]);
  expect(JSON.stringify(f.request.mock.calls)).not.toContain("private-");
});
it("keeps the encrypted key receipt if provider removal cannot be confirmed", async () => {
  const f = fixture(); const original = f.request.getMockImplementation()!;
  f.request.mockImplementation(async (query, variables) => query.includes("mutation") ? { sshPublicKeyDelete: true } : original(query, variables));
  await expect(retireHostedAgentSsh(f.lease, f.profile, f.request)).rejects.toThrow(/unconfirmed/);
  expect(f.lease.state.resources.agentSsh).toBe(f.key);
});
it("refuses mismatched key material before touching provider access", async () => {
  const f = fixture(); f.key.fingerprint = "SHA256:other";
  await expect(retireHostedAgentSsh(f.lease, f.profile, f.request)).rejects.toThrow(/ownership/);
  expect(f.request).not.toHaveBeenCalled();
});
it("refuses native SSH dispatch before key registration or local transport preparation", async () => {
  const f = fixture(), directory = fs.mkdtempSync(path.join(os.tmpdir(), "dev-ssh-")); f.registered.pop();
  try {
    await expect(startHostedAgentOverSsh(f.lease, f.profile, directory, { probe: true }, f.execute, f.request))
      .rejects.toMatchObject({ status: 409, code: "release_worker_images_retired" });
    expect(f.request).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled();
    expect(f.lease.save).not.toHaveBeenCalled(); expect(f.lease.fence).not.toHaveBeenCalled();
    expect(f.lease.state.resources.agentSsh).toBe(f.key); expect(fs.readdirSync(directory)).toEqual([]);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
it("does not treat a partial key inventory as proof of deletion", async () => {
  const f = fixture(); f.request.mockResolvedValue({ sshPublicKeys: { edges: [], pageInfo: { hasNextPage: true } } } as any);
  await expect(retireHostedAgentSsh(f.lease, f.profile, f.request)).rejects.toThrow(/incomplete/);
  expect(f.lease.state.resources.agentSsh).toBe(f.key); expect(f.lease.fence).not.toHaveBeenCalled();
});
it("retains an uncertain SSH create after an empty inventory and does not register it twice", async () => {
  const f = fixture(), directory = fs.mkdtempSync(path.join(os.tmpdir(), "dev-ssh-uncertain-")); f.registered.pop();
  (f.key as any).create = { version: 1, phase: "uncertain", dispatchedAt: new Date().toISOString() };
  try {
    await expect(retireHostedAgentSsh(f.lease, f.profile, f.request)).rejects.toThrow(/unconfirmed/);
    await expect(startHostedAgentOverSsh(f.lease, f.profile, directory, {}, f.execute, f.request)).rejects.toThrow();
    expect(f.request.mock.calls.filter(([query]) => query.includes("CreateDevSshKey"))).toHaveLength(0);
    expect(f.lease.state.resources.agentSsh).toBe(f.key);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
it("keeps pinned Railway CLI checks available independently of retired native SSH dispatch", async () => {
  const f = fixture(), directory = fs.mkdtempSync(path.join(os.tmpdir(), "dev-ssh-journal-")); f.registered.pop();
  try {
    expect(await ensureDevRailwayCli(f.execute)).toBe("railway");
    expect(f.execute).toHaveBeenCalledOnce(); expect(f.request).not.toHaveBeenCalled();
    expect(f.lease.state.resources.agentSsh).toBe(f.key); expect(f.lease.save).not.toHaveBeenCalled();
  }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
