import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudWorkspaceBackendConfig } from "../config.js";
import { withSystemTx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { createComputerTemplateBoatAdapters } from "./computer-template-boat.js";
import { DatabaseCloudComputerV2Service } from "./computer-v2.js";
import { loadCloudRuntimeConfig } from "./runtime-config.js";
import { loadPinnedCloudRuntime, selectCloudRuntime } from "./runtime-selection.js";
import { runtimeBase, seedRuntimeBase, seedRuntimeBundle } from "./runtime-test-fixtures.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";
import { computerTestAccount, computerTestWallet, seedComputerTemplate } from "./computer-workspace-test-fixtures.js";
import { selectComputerWorkspaceSource } from "./computer-workspace-source.js";

const candidate = { ...runtimeBase, id: "zeros-v2-test-candidate", imageRef: `boat:zeros-v2-test-candidate@sha256:${"c".repeat(64)}`,
  compatibilityId: `bc1-${"8".repeat(64)}` };
const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;

database("explicit runtime base rollout with PostgreSQL", () => {
  let pool: pg.Pool;
  let a: Awaited<ReturnType<typeof seedReadyCloudWorkspace>>, b: typeof a;
  let legacy: Awaited<ReturnType<typeof seedRuntimeBundle>>;
  let config: CloudWorkspaceBackendConfig;
  const policy = () => ({ version: 1, defaultBaseImageId: runtimeBase.id,
    candidate: { baseImageId: candidate.id, organizationIds: [a.organizationId] } });
  const service = () => new DatabaseCloudComputerV2Service(pool, config);
  const apply = (value: unknown = policy()) => {
    config.runtime = loadCloudRuntimeConfig({ CLOUD_RUNTIME_BASE_ROLLOUT_JSON: JSON.stringify(value) });
  };
  const adapters = () => createComputerTemplateBoatAdapters({ pool,
    client: { request: vi.fn(async () => { throw new Error("unexpected provider I/O"); }) },
    accountScope: computerTestAccount, billingOrg: computerTestWallet, deploymentChannel: "alpha",
    qualificationMode: config.runtime!.qualificationMode, baseRollout: config.runtime!.baseRollout,
  });
  const select = (org: string) => withSystemTx(pool, tx => adapters().runtime.select(tx, org));
  const request = async (owner = b) => service().build(owner.organizationId, owner.userId, {
    expectedRevision: (await service().read(owner.organizationId, owner.userId)).revision,
    operationId: randomUUID(), draft: { repositories: [], installScript: "", timeoutSeconds: 900 },
  });
  const observe = (owner: typeof a, id: string) => service().getBuildRuntime(owner.organizationId, owner.userId, id);
  const claim = async () => {
    const { runtime, operations } = adapters();
    return service().claimNextBuild(1, { operations, accountScope: computerTestAccount, billingOrg: computerTestWallet,
      selectRuntime: async (tx, organizationId) => {
        const selected = await runtime.select(tx, organizationId);
        return selected && { baseImageId: selected.baseImageId, runtimeId: selected.descriptor.runtimeId };
      },
      loadRuntime: async (tx, pin) => await runtime.load(tx, pin) !== null,
    });
  };
  const qualify = (options: Parameters<typeof seedRuntimeBundle>[1] = {}) => withSystemTx(pool, tx =>
    seedRuntimeBundle(tx, { digit: "1", releaseOrder: 2, baseCompatibilityId: candidate.compatibilityId, ...options }));
  const candidatePin = (runtime: Awaited<ReturnType<typeof seedRuntimeBundle>>) => ({ ...runtime.pin, baseImageId: candidate.id });

  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    legacy = await withSystemTx(pool, async tx => {
      await seedRuntimeBase(tx, runtimeBase, new Date(Date.now() - 60_000));
      await seedRuntimeBase(tx, candidate, new Date(Date.now() - 30_000));
      return seedRuntimeBundle(tx);
    });
    a = await seedReadyCloudWorkspace(pool, { runtimeV4: false });
    b = await seedReadyCloudWorkspace(pool, { runtimeV4: false });
    config = { settingsSecretKeyV1: randomBytes(32).toString("base64url") } as CloudWorkspaceBackendConfig;
    apply();
  });

  it("registered_unqualified_candidate_keeps_other_org_claims_on_default", async () => {
    const asked = await request();
    expect((await observe(b, asked.build.id)).selected?.baseImageId).toBe(runtimeBase.id);
    expect((await claim())?.build.id).toBe(asked.build.id);
    expect((await pool.query("SELECT state,base_image_id FROM cloud_computer_v2_builds WHERE id=$1", [asked.build.id])).rows[0])
      .toEqual({ state: "running", base_image_id: runtimeBase.id });
    expect(await select(a.organizationId)).toBeNull();
  });

  it.each(["partial", "smoke", "revoked"])("keeps %s candidate evidence outside other organizations", async failure => {
    const runtime = await qualify(failure === "partial" ? { kinds: ["codex-chatgpt"] }
      : failure === "smoke" ? { mode: "smoke" } : {});
    if (failure === "revoked") await withSystemTx(pool, tx => tx.query(`UPDATE cloud_runtime_qualifications
      SET revoked_at=now(),enabled=false,mcp_qualified=false WHERE runtime_id=$1 AND credential_kind='codex-chatgpt'`, [runtime.pin.runtimeId]));
    expect(await select(b.organizationId)).toMatchObject({ baseImageId: runtimeBase.id });
    expect(await select(a.organizationId)).toBeNull();
  });

  it("only_locked_fixture_org_selects_candidate, with A to B to A observation", async () => {
    await qualify();
    const first = await request(a), second = await request(b);
    const runtime = adapters().runtime;
    const received: string[] = [];
    for (const expected of [a, b]) {
      const selected = await service().claimNextBuild(1, { operations: adapters().operations,
        accountScope: computerTestAccount, billingOrg: computerTestWallet,
        selectRuntime: async (tx, organizationId) => {
          received.push(organizationId);
          const result = await runtime.select(tx, organizationId);
          return result && { baseImageId: result.baseImageId, runtimeId: result.descriptor.runtimeId };
        },
      });
      expect(selected?.organizationId).toBe(expected.organizationId);
    }
    expect(received).toEqual([a.organizationId, b.organizationId]);
    for (const [owner, id, base] of [[a, first.build.id, candidate.id], [b, second.build.id, runtimeBase.id],
      [a, first.build.id, candidate.id]] as const) {
      expect(await observe(owner, id)).toMatchObject({ baseImageId: base, selected: { baseImageId: base } });
    }
    await expect(service().getBuildRuntime(a.organizationId, b.userId, first.build.id)).rejects.toMatchObject({ status: 404 });
  });

  it("candidate_success_does_not_promote_global_default", async () => {
    await qualify();
    expect(await select(a.organizationId)).toMatchObject({ baseImageId: candidate.id });
    expect(await select(b.organizationId)).toMatchObject({ baseImageId: runtimeBase.id });
    // Selection/observation has no promotion write, even for a fully qualified candidate.
    expect(await select(b.organizationId)).toMatchObject({ baseImageId: runtimeBase.id });
  });

  it("revocation_while_selection_waits_refuses_exact_target", async () => {
    await qualify();
    const held = await pool.connect();
    let selecting: Promise<unknown> | undefined;
    try {
      await held.query("BEGIN");
      await held.query("SELECT 1 FROM cloud_runtime_base_images WHERE base_image_id=$1 FOR UPDATE", [runtimeBase.id]);
      let waitingPid!: number;
      let entered!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      selecting = withSystemTx(pool, async tx => {
        waitingPid = (await tx.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
        entered();
        return adapters().runtime.select(tx, b.organizationId);
      });
      await started;
      await vi.waitFor(async () => {
        expect((await pool.query("SELECT cardinality(pg_blocking_pids($1)) AS blockers", [waitingPid])).rows[0].blockers).toBeGreaterThan(0);
      }, { timeout: 1000, interval: 10 });
      await held.query("UPDATE cloud_runtime_base_images SET revoked_at=now() WHERE base_image_id=$1", [runtimeBase.id]);
      await held.query("COMMIT");
      expect(await selecting).toBeNull();
      expect(await select(a.organizationId)).toMatchObject({ baseImageId: candidate.id });
    } finally {
      await held.query("ROLLBACK");
      held.release();
      await selecting;
    }
  });

  it("claimed_build_and_saved_template_pins_survive_policy_change", async () => {
    const next = await qualify();
    // Build on the old base, then change policy. A handoff must reload that saved pin.
    apply({ ...policy(), candidate: null });
    const asked = await request(b);
    expect((await claim())?.build.id).toBe(asked.build.id);
    const before = (await pool.query("SELECT base_image_id,runtime_id,deadline_at FROM cloud_computer_v2_builds WHERE id=$1", [asked.build.id])).rows[0];
    expect(before.base_image_id).toBe(runtimeBase.id);
    apply({ version: 1, defaultBaseImageId: candidate.id, candidate: null });
    expect(await service().handoffBuild(asked.build.id, 1, { started: false, after: 0, discardStreams: [] })).toBe(true);
    expect((await claim())?.build.id).toBe(asked.build.id);
    expect((await pool.query("SELECT base_image_id,runtime_id,deadline_at FROM cloud_computer_v2_builds WHERE id=$1", [asked.build.id])).rows[0]).toEqual(before);
    expect(await withSystemTx(pool, tx => loadPinnedCloudRuntime(tx, legacy.pin, "full"))).toMatchObject({ descriptor: legacy.descriptor });

    await withSystemTx(pool, tx => seedComputerTemplate(tx, { organizationId: a.organizationId, ownerUserId: a.userId,
      installationId: randomUUID(), repositories: [], sourceSandboxId: "bx_23456789" }));
    expect(await withSystemTx(pool, tx => selectComputerWorkspaceSource(tx, { organizationId: a.organizationId,
      qualificationMode: "full", accountScope: computerTestAccount, billingOrg: computerTestWallet })))
      .toMatchObject({ runtime: legacy.pin });
    expect(await withSystemTx(pool, tx => selectCloudRuntime(tx, "full", runtimeBase.id))).toMatchObject({ pin: legacy.pin });
    expect(await withSystemTx(pool, tx => loadPinnedCloudRuntime(tx, candidatePin(next), "full"))).not.toBeNull();
  });

  it("explicit_default_rollback_keeps_candidate_pins_valid", async () => {
    const next = await qualify();
    apply({ version: 1, defaultBaseImageId: candidate.id, candidate: null });
    const asked = await request(a);
    expect((await claim())?.build.id).toBe(asked.build.id);
    apply({ version: 1, defaultBaseImageId: runtimeBase.id, candidate: null });
    expect(await observe(a, asked.build.id)).toMatchObject({ baseImageId: candidate.id, selected: { baseImageId: runtimeBase.id } });
    expect(await select(a.organizationId)).toMatchObject({ baseImageId: runtimeBase.id });
    expect(await withSystemTx(pool, tx => loadPinnedCloudRuntime(tx, candidatePin(next), "full"))).toMatchObject({ descriptor: next.descriptor });
    expect((await pool.query("SELECT count(*)::int AS count FROM cloud_runtime_base_images WHERE revoked_at IS NOT NULL")).rows[0].count).toBe(0);
  });

  it("does not change legacy newest-base behavior when the policy is absent", async () => {
    config.runtime = loadCloudRuntimeConfig({});
    expect(await select(b.organizationId)).toBeNull();
    await qualify();
    expect(await select(b.organizationId)).toMatchObject({ baseImageId: candidate.id });
  });

  it("refuses missing explicit targets rather than discovering another base", async () => {
    await qualify();
    apply({ version: 1, defaultBaseImageId: "zeros-v2-test-missing", candidate: null });
    expect(await select(b.organizationId)).toBeNull();
    const asked = await request();
    expect((await observe(b, asked.build.id)).selected).toBeNull();
    expect(await claim()).toBeNull();
    expect((await pool.query("SELECT state,error_code FROM cloud_computer_v2_builds WHERE id=$1", [asked.build.id])).rows[0])
      .toEqual({ state: "failed", error_code: "runtime_unavailable" });
  });
});
