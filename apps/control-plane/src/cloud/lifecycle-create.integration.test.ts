import { generateKeyPairSync, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudV2Store } from "./store.js";
import { CloudV2Lifecycle } from "./lifecycle.js";
import type { CloudV2Compute } from "./boat.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { grantTestPro } from "../test-pro.js";

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
d("cloud initial allocation cleanup", () => {
  let pool: pg.Pool, store: CloudV2Store, workspaceId: string;
  const gate = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }); });
  afterAll(() => pool.end());
  afterEach(() => vi.restoreAllMocks());
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    const creator = randomUUID(), organization = randomUUID();
    store = new CloudV2Store(pool); workspaceId = randomUUID();
    await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'User')", [creator, `${creator}@example.test`]);
    await grantTestPro(pool, creator);
    await pool.query(`INSERT INTO organizations(id,slug,name,created_by,is_personal,cloud_workspaces_allowed)
      VALUES($1,$2,'Org',$3,false,true)`, [organization, `org-${organization}`, creator]);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner')", [organization, creator]);
    await store.createWorkspace({ id: workspaceId, organizationId: organization, creatorUserId: creator,
      repository: "Owner/Project", branch: "zeros/create", baseBranch: "main", name: "Project", computerBuildId: null });
    vi.spyOn(store, "workspaceImage").mockResolvedValue({ from: "fixture-snapshot", prune: [] });
  });

  it("retires a held create reply when another lifecycle replica deletes the workspace", async () => {
    const entered = gate(), release = gate(), deletingClaimed = gate(), allocated = new Set<string>();
    const compute = {
      create: vi.fn(async () => {
        entered.resolve(); await release.promise;
        allocated.add("bx_fixture1");
        return { sandboxId: "bx_fixture1" };
      }),
      delete: vi.fn(async (id: string) => { allocated.delete(id); }),
      findSandbox: vi.fn(async () => allocated.has("bx_fixture1") ? "bx_fixture1" : null),
      exec: vi.fn(async () => ({ exitCode: 0, stdout: "", timedOut: false })),
      hostPort: vi.fn(async () => ({ url: "https://fixture-41783.on.boat.dev", token: "synthetic-port-token" })),
    } as unknown as CloudV2Compute;
    const claimed = store.claimPending.bind(store);
    vi.spyOn(store, "claimPending").mockImplementation(async (...args) => {
      const rows = await claimed(...args);
      if (rows.some(row => row.state === "deleting")) deletingClaimed.resolve();
      return rows;
    });
    const deps = { store, compute, runtime: { sha256: "b".repeat(64), url: async () => "https://example.test/runtime.tar.gz" },
      publicKeys: [generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString()],
      sealPortToken: () => ({ encrypted: true }), stopWorker: async () => true, bootEnv: () => ({}),
      sandboxName: () => `zeros-fixture-${workspaceId}`, sleep: async () => {} };
    const creating = new CloudV2Lifecycle(deps).tick();
    let deleting: Promise<void> | undefined;
    try {
      await entered.promise;
      await store.transition(workspaceId, ["creating"], "deleting");
      deleting = new CloudV2Lifecycle(deps).tick();
      await deletingClaimed.promise;
      release.resolve(); await Promise.all([creating, deleting]);
      const { rows } = await pool.query("SELECT state,boat_sandbox_id,worker_token_hash FROM cloud_v2_workspaces WHERE id=$1", [workspaceId]);
      expect(allocated.size).toBe(0);
      expect(rows[0].state).toBe("deleted");
      expect(rows[0].worker_token_hash).toBeNull();
    } finally { release.resolve(); await Promise.allSettled([creating, deleting]); }
  });

  it.each([false, true])("cleans a create returned after deletion completed, retaining a failed cleanup for retry (%s)", async failCleanup => {
    const entered = gate(), release = gate(), allocated = new Set<string>();
    let deletes = 0;
    const compute = {
      create: vi.fn(async () => { entered.resolve(); await release.promise; allocated.add("bx_fixture1"); return { sandboxId: "bx_fixture1" }; }),
      delete: vi.fn(async (id: string) => { if (failCleanup && ++deletes === 1) throw new Error("Cleanup transport unavailable"); allocated.delete(id); }),
      exec: vi.fn(async () => ({ exitCode: 0, stdout: "", timedOut: false })),
      hostPort: vi.fn(async () => ({ url: "https://fixture-41783.on.boat.dev", token: "synthetic-port-token" })),
    } as unknown as CloudV2Compute;
    const deps = { store, compute, runtime: { sha256: "b".repeat(64), url: async () => "https://example.test/runtime.tar.gz" },
      publicKeys: [generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString()],
      sealPortToken: () => ({ encrypted: true }), stopWorker: async () => true, bootEnv: () => ({}),
      sandboxName: () => `zeros-fixture-${workspaceId}`, sleep: async () => {} };
    const creating = new CloudV2Lifecycle(deps).tick();
    const state = async () => (await pool.query("SELECT state,boat_sandbox_id FROM cloud_v2_workspaces WHERE id=$1", [workspaceId])).rows[0];
    try {
      await entered.promise;
      await store.transition(workspaceId, ["creating"], "deleting");
      await new CloudV2Lifecycle(deps).tick();
      expect((await state()).state).toBe("deleted");
      release.resolve(); await creating;
      expect(vi.mocked(compute.exec).mock.calls.length).toBe(0);
      expect(vi.mocked(compute.hostPort).mock.calls.length).toBe(0);
      if (failCleanup) {
        expect(await state()).toMatchObject({ state: "deleting", boat_sandbox_id: "bx_fixture1" });
        await pool.query("UPDATE cloud_v2_workspaces SET next_attempt_at=NULL WHERE id=$1", [workspaceId]);
        await new CloudV2Lifecycle(deps).tick();
      }
      expect(allocated.size).toBe(0);
      expect((await state()).state).toBe("deleted");
      expect(compute.create).toHaveBeenCalledOnce();
    } finally { release.resolve(); await creating; }
  });

  it.each(["completion", "exhausted failure"])("keeps late cleanup pending across an earlier deletion's %s with no VM", async outcome => {
    const entered = gate(), release = gate(), finalizing = gate(), finish = gate(), allocated = new Set<string>();
    let deletes = 0, completions = 0;
    const compute = {
      create: vi.fn(async () => { entered.resolve(); await release.promise; allocated.add("bx_fixture1"); return { sandboxId: "bx_fixture1" }; }),
      delete: vi.fn(async (id: string) => { if (++deletes === 1) throw new Error("Cleanup transport unavailable"); allocated.delete(id); }),
      exec: vi.fn(async () => ({ exitCode: 0, stdout: "", timedOut: false })),
      hostPort: vi.fn(async () => ({ url: "https://fixture-41783.on.boat.dev", token: "synthetic-port-token" })),
    } as unknown as CloudV2Compute;
    const transition = store.transition.bind(store);
    vi.spyOn(store, "transition").mockImplementation(async (...args) => {
      if (args[2] === "deleted" && ++completions === 1) {
        finalizing.resolve(); await finish.promise;
        if (outcome === "exhausted failure") throw new Error("Earlier deletion finalization failed");
      }
      return transition(...args);
    });
    const deps = { store, compute, runtime: { sha256: "b".repeat(64), url: async () => "https://example.test/runtime.tar.gz" },
      publicKeys: [generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString()],
      sealPortToken: () => ({ encrypted: true }), stopWorker: async () => true, bootEnv: () => ({}),
      sandboxName: () => `zeros-fixture-${workspaceId}`, sleep: async () => {} };
    const creating = new CloudV2Lifecycle(deps).tick();
    let deleting: Promise<void> | undefined;
    try {
      await entered.promise;
      await store.transition(workspaceId, ["creating"], "deleting");
      if (outcome === "exhausted failure") await pool.query("UPDATE cloud_v2_workspaces SET attempts=7 WHERE id=$1", [workspaceId]);
      deleting = new CloudV2Lifecycle(deps).tick();
      await finalizing.promise;
      release.resolve(); await creating;
      finish.resolve(); await deleting;
      const { rows } = await pool.query("SELECT state,boat_sandbox_id FROM cloud_v2_workspaces WHERE id=$1", [workspaceId]);
      expect(rows[0]).toMatchObject({ state: "deleting", boat_sandbox_id: "bx_fixture1" });
      expect(vi.mocked(compute.exec).mock.calls.length).toBe(0);
      await pool.query("UPDATE cloud_v2_workspaces SET next_attempt_at=NULL WHERE id=$1", [workspaceId]);
      await new CloudV2Lifecycle(deps).tick();
      expect(allocated.size).toBe(0);
      expect((await pool.query("SELECT state FROM cloud_v2_workspaces WHERE id=$1", [workspaceId])).rows[0].state).toBe("deleted");
    } finally { release.resolve(); finish.resolve(); await Promise.allSettled([creating, deleting]); }
  });

  it("records a healthy returned create before provisioning its assigned VM", async () => {
    const compute = {
      create: vi.fn(async () => ({ sandboxId: "bx_fixture1" })),
      delete: vi.fn(async () => {}),
      exec: vi.fn(async () => ({ exitCode: 0, stdout: "", timedOut: false })),
      hostPort: vi.fn(async () => ({ url: "https://fixture-41783.on.boat.dev", token: "synthetic-port-token" })),
    } as unknown as CloudV2Compute;
    const prepareRepository = vi.fn(async () => {
      const { rows } = await pool.query("SELECT boat_sandbox_id FROM cloud_v2_workspaces WHERE id=$1", [workspaceId]);
      expect(rows[0].boat_sandbox_id).toBe("bx_fixture1");
    });
    await new CloudV2Lifecycle({ store, compute, prepareRepository,
      runtime: { sha256: "b".repeat(64), url: async () => "https://example.test/runtime.tar.gz" },
      publicKeys: [generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString()],
      sealPortToken: () => ({ encrypted: true }), stopWorker: async () => true, bootEnv: () => ({}),
      sandboxName: () => `zeros-fixture-${workspaceId}`, sleep: async () => {} }).tick();
    expect(prepareRepository).toHaveBeenCalledOnce();
    expect(vi.mocked(compute.exec).mock.calls.length).toBe(2);
    expect(vi.mocked(compute.hostPort).mock.calls.length).toBe(1);
    expect(vi.mocked(compute.delete).mock.calls.length).toBe(0);
  });

  it.each(["failed", "assigned", "running", "stopping", "restoring", "replacement"])("does not provision a held initial reply after %s supersedes the creating step", async boundary => {
    const entered = gate(), release = gate();
    const compute = {
      create: vi.fn(async () => { entered.resolve(); await release.promise; return { sandboxId: "bx_fixture1" }; }),
      delete: vi.fn(async () => {}),
      exec: vi.fn(async () => ({ exitCode: 0, stdout: "", timedOut: false })),
      hostPort: vi.fn(async () => ({ url: "https://fixture-41783.on.boat.dev", token: "synthetic-port-token" })),
    } as unknown as CloudV2Compute;
    const prepareRepository = vi.fn(async () => {});
    const deps = { store, compute, prepareRepository, runtime: { sha256: "b".repeat(64), url: async () => "https://example.test/runtime.tar.gz" },
      publicKeys: [generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString()],
      sealPortToken: () => ({ encrypted: true }), stopWorker: async () => true, bootEnv: () => ({}),
      sandboxName: () => `zeros-fixture-${workspaceId}`, sleep: async () => {} };
    const creating = new CloudV2Lifecycle(deps).tick();
    try {
      await entered.promise;
      if (boundary === "failed") await store.transition(workspaceId, ["creating"], "failed");
      else if (boundary === "assigned") await store.defer(workspaceId, "creating", 0, { boatSandboxId: "bx_replacement" });
      else if (boundary === "running" || boundary === "stopping")
        await store.transition(workspaceId, ["creating"], boundary, { boatSandboxId: "bx_fixture1" });
      else await pool.query(`UPDATE cloud_v2_workspaces SET state='starting',boat_sandbox_id=$7,
        restore_pending=true,restore_attempt=$2,restore_create=$3,stop_generation=stop_generation+$6,
        checkpoint_object=$4,checkpoint_key='{"sealed":"fixture"}',checkpoint_sha256=$5,checkpoint_bytes=100,
        checkpoint_saved_at=clock_timestamp() WHERE id=$1`,
      [workspaceId, randomUUID(), { from: "fixture-snapshot", name: "fixture-replacement", env: {}, requestedAt: new Date().toISOString() },
        `cloud-v2/checkpoints/${workspaceId}/${randomUUID()}.zck`, "a".repeat(64), boundary === "replacement" ? 1 : 0,
        boundary === "restoring" ? null : "bx_replacement"]);
      release.resolve(); await creating;
      expect(vi.mocked(compute.exec).mock.calls.length).toBe(0);
      expect(prepareRepository.mock.calls.length).toBe(0);
      expect(vi.mocked(compute.hostPort).mock.calls.length).toBe(0);
      const { rows } = await pool.query("SELECT state,boat_sandbox_id FROM cloud_v2_workspaces WHERE id=$1", [workspaceId]);
      const expected = boundary === "failed" || boundary === "running" || boundary === "stopping"
        ? { state: boundary, boat_sandbox_id: "bx_fixture1" }
        : { state: boundary === "assigned" ? "creating" : "starting", boat_sandbox_id: boundary === "restoring" ? null : "bx_replacement" };
      expect(rows[0]).toMatchObject(expected);
      if (boundary === "failed") {
        await store.transition(workspaceId, ["failed"], "deleting");
        await new CloudV2Lifecycle(deps).tick();
        expect(compute.delete).toHaveBeenCalledWith("bx_fixture1");
      } else expect(vi.mocked(compute.delete).mock.calls.length).toBe(0);
    } finally { release.resolve(); await creating; }
  });
});
