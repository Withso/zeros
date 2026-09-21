import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { createCloudWorkspaceInternalRoutes, type CloudWorkspaceInternalSetupService } from "../../apps/control-plane/src/cloud-workspaces/internal-routes";
import { CloudWorkspaceDurabilityRuntime } from "../../apps/desktop/src/engine/cloud-durability-runtime";

const checkpointIt = it.runIf(process.platform === "linux");
const execFileAsync = promisify(execFile);
const roots: string[] = [];
const authority = {
  heartbeatEndpoint: "https://control.example.test/internal/heartbeat",
  workspaceId: "11111111-1111-4111-8111-111111111111",
  organizationId: "22222222-2222-4222-8222-222222222222",
  generation: 1,
  engineInstanceId: "33333333-3333-4333-8333-333333333333",
};
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function checkpointRepository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "zeros-checkpoint-http-"));
  roots.push(root);
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await execFileAsync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "--quiet", "-m", "base"], { cwd: root });
  return root;
}

checkpointIt("sends checkpoint JSON and blob queries accepted by the real control-plane validators", async () => {
  const root = await checkpointRepository();
  await writeFile(path.join(root, "new.txt"), "fixture\n");
  const append = vi.fn(async () => ({ revision: 1 }));
  const commit = vi.fn(async () => ({ checkpointId: "88888888-8888-4888-8888-888888888888" }));
  const routes = createCloudWorkspaceInternalRoutes({
    redeem: vi.fn(), registerEngine: vi.fn(), heartbeat: vi.fn(),
    readContentHead: async () => ({ checkpointId: null, currentRevision: 0, durableRevision: 0, entries: [], nextAfterPath: null }),
    authorizeBlobUpload: async () => undefined,
    putBlob: async ({ bytes }: { bytes: Uint8Array }) => ({ id: "77777777-7777-4777-8777-777777777777", plaintextSha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.byteLength }),
    putBlobBatch: async ({ entries }: { entries: readonly Uint8Array[] }) => ({ blobs: entries.map((bytes, index) => ({ index,
      id: "77777777-7777-4777-8777-777777777777", plaintextSha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.byteLength })) }),
    getBlob: vi.fn(), appendContent: append, commitCheckpoint: commit,
  } as unknown as CloudWorkspaceInternalSetupService);
  const requests: Array<{ path: string; status: number }> = [];
  const runtime = new CloudWorkspaceDurabilityRuntime(root, {
    fetch: (async (input, init) => {
      const response = await routes.fetch(new Request(String(input), init));
      requests.push({ path: new URL(String(input)).pathname, status: response.status });
      return response;
    }) as typeof fetch,
  });
  await runtime.checkpoint({ id: "99999999-9999-4999-8999-999999999999", reason: "manual", deadlineAtMs: Date.now() + 30_000 }, { ...authority, heartbeatToken: "zwh_" + "a".repeat(43) });
  expect(requests.every(r => r.status === 200)).toBe(true);
  expect(requests.some(r => r.path.endsWith("/blobs/batch"))).toBe(true);
  expect(append).toHaveBeenCalledWith(expect.objectContaining({ generation: 1 }));
  expect(commit).toHaveBeenCalledWith(expect.objectContaining({ generation: 1 }));
});
