import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { CloudWorker } from "../worker";
import { FakeRelay, WORKSPACE_ID, config } from "./worker-fixtures";

// An acting (shared-execution) handoff boot skips bootstrapLease, which is what otherwise waits for this boot's clean
// attestation. Its private ready (transport.readyRuntime + runtimeResume.ready, which completes the handoff marker)
// must wait for an accepted clean attestation and the applied initial configuration; a refused or failed clean never
// promotes it.
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

class CleanRelay extends FakeRelay {
  readyCalls = 0;
  outcome: "accept" | "refuse" = "accept";
  private release!: () => void;
  readonly held = new Promise<void>(resolve => { this.release = resolve; });
  settle(outcome: "accept" | "refuse"): void { this.outcome = outcome; this.release(); }
  async readyRuntime(): Promise<void> { this.readyCalls++; }
  async contextRequest(path: string, body: { contextIds?: string[] }): Promise<unknown> {
    if (path === "execution-leases/boot-clean") {
      await this.held;
      if (this.outcome === "refuse") throw Object.assign(new Error("not retired"), { status: 409 });
      return { retired: 0 };
    }
    if (path === "execution-leases/renew") return { leases: (body.contextIds ?? []).map(contextId => ({ contextId, expiresAt: Date.now() + 30_000 })) };
    throw new Error(`unexpected ${path}`);
  }
}

async function resumed() {
  const directory = await mkdtemp(join(tmpdir(), "zeros-acting-resume-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "checkout"); await mkdir(join(root, ".git"), { recursive: true });
  const relay = new CleanRelay(), lines: string[] = [], ready = vi.fn();
  const worker = new CloudWorker({ directory, homeDirectory: directory, transport: relay, workspaceId: WORKSPACE_ID, drivers: {},
    githubFetch: async () => new Response(null, { status: 200 }), prepareCheckout: async () => ({ createdBranch: false }),
    bootClean: async () => 0, runtimeResume: { instanceId: randomUUID(), ready }, log: line => lines.push(line) });
  cleanups.push(() => worker.dispose());
  worker.start();
  const configured = relay.receive({ ...config, workspace: { ...config.workspace, checkoutPath: root }, actingUser: 1, gitIdentity: null }).catch(() => {});
  return { relay, lines, ready, configured };
}

it("an acting handoff boot holds its private ready until the clean attestation is accepted", async () => {
  const f = await resumed();
  await expect.poll(() => f.lines.includes("runtime-ready waiting=boot-clean")).toBe(true);
  expect(f.relay.readyCalls).toBe(0);
  expect(f.ready).not.toHaveBeenCalled();
  f.relay.settle("accept");
  await expect.poll(() => f.relay.readyCalls).toBe(1);
  expect(f.ready).toHaveBeenCalledOnce();
});

it("a refused clean attestation never promotes the handoff boot or completes its marker", async () => {
  const f = await resumed();
  await expect.poll(() => f.lines.includes("runtime-ready waiting=boot-clean")).toBe(true);
  f.relay.settle("refuse");
  await expect.poll(() => f.lines.includes("runtime-ready refused=boot-clean")).toBe(true);
  await f.configured;
  expect(f.relay.readyCalls).toBe(0);
  expect(f.ready).not.toHaveBeenCalled();
});
