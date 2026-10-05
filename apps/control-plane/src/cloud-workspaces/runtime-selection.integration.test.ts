import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withSystemTx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { selectCloudRuntime, loadPinnedCloudRuntime, runtimeCredentialQualificationJoin } from "./runtime-selection.js";
import { runtimeBase, seedRuntimeBase, seedRuntimeBundle } from "./runtime-test-fixtures.js";
import { CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION } from "./engine-protocol-version.js";

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)("v4 runtime selection", () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = new pg.Pool({ connectionString: url, max: 4 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    await withSystemTx(pool, tx => seedRuntimeBase(tx));
  });
  const select = (mode: "full" | "smoke" = "full") => withSystemTx(pool, tx => selectCloudRuntime(tx, mode));

  it("chooses the newest confirmed release with every required kind and the deployed protocol", async () => {
    const older = await withSystemTx(pool, async tx => {
      const qualified = await seedRuntimeBundle(tx);
      await seedRuntimeBundle(tx, { digit: "1", releaseOrder: 2, kinds: ["claude-setup-token", "codex-chatgpt"] });
      await seedRuntimeBundle(tx, { digit: "2", releaseOrder: 3, engineProtocolVersion: CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION - 1 });
      await seedRuntimeBundle(tx, { digit: "3", releaseOrder: 4, confirmed: false });
      return qualified;
    });
    expect(await select()).toMatchObject({ pin: older.pin, base: runtimeBase, descriptor: older.descriptor });
    const newer = await withSystemTx(pool, tx => seedRuntimeBundle(tx, { digit: "4", releaseOrder: 5 }));
    expect(await select()).toMatchObject({ pin: newer.pin });
    // Existing pins resolve independently of the advancing channel head.
    expect(await withSystemTx(pool, tx => loadPinnedCloudRuntime(tx, older.pin, "full"))).toMatchObject({ descriptor: older.descriptor });
  });

  it.each(["full", "smoke"] as const)("accepts full evidence in %s mode", async mode => {
    await withSystemTx(pool, tx => seedRuntimeBundle(tx));
    expect(await select(mode)).not.toBeNull();
  });
  it("admits smoke evidence only with the explicit smoke mode", async () => {
    await withSystemTx(pool, tx => seedRuntimeBundle(tx, { mode: "smoke" }));
    expect(await select()).toBeNull();
    expect(await select("smoke")).not.toBeNull();
  });
  it.each(["bundle", "release", "qualification", "base", "contract"])("rejects a revoked %s", async kind => {
    await withSystemTx(pool, async tx => {
      await seedRuntimeBundle(tx);
      const sql = {
        bundle: "UPDATE cloud_runtime_bundles SET revoked_at=now() WHERE runtime_id IS NOT NULL",
        release: "UPDATE cloud_runtime_channel_releases SET revoked_at=now() WHERE channel='alpha'",
        qualification: "UPDATE cloud_runtime_qualifications SET revoked_at=now(),enabled=false,mcp_qualified=false WHERE credential_kind='codex-chatgpt'",
        base: "UPDATE cloud_runtime_base_images SET revoked_at=now() WHERE base_image_id IS NOT NULL",
        contract: "UPDATE cloud_runtime_base_contracts SET revoked_at=now() WHERE base_compatibility_id IS NOT NULL",
      }[kind]!;
      await tx.query(sql);
    });
    expect(await select()).toBeNull();
  });
  it("requires enabled qualifications for the newest approved base, without falling back to an old base", async () => {
    await withSystemTx(pool, async tx => {
      await seedRuntimeBundle(tx);
      await seedRuntimeBase(tx, { ...runtimeBase, id: "zeros-v2-test-new-base", imageRef: "boat:zeros-v2-test-new-base",
        compatibilityId: `bc1-${"8".repeat(64)}` }, new Date(Date.now() + 1_000));
    });
    expect(await select()).toBeNull();
  });
  it("does not fall back to an older base when the newest base's contract is revoked", async () => {
    await withSystemTx(pool, async tx => {
      await seedRuntimeBundle(tx);
      const compatibilityId = `bc1-${"8".repeat(64)}`;
      await seedRuntimeBase(tx, { ...runtimeBase, id: "zeros-v2-test-new-base", imageRef: "boat:zeros-v2-test-new-base",
        compatibilityId }, new Date(Date.now() + 1_000));
      await tx.query("UPDATE cloud_runtime_base_contracts SET revoked_at=now() WHERE base_compatibility_id=$1", [compatibilityId]);
    });
    expect(await select()).toBeNull();
  });
  it("requires all qualifications to be enabled but does not invent MCP approval for channel selection", async () => {
    await withSystemTx(pool, tx => seedRuntimeBundle(tx, { enabled: false }));
    expect(await select()).toBeNull();
    await withSystemTx(pool, tx => seedRuntimeBundle(tx, { digit: "1", releaseOrder: 2, mcpQualified: false }));
    expect(await select()).not.toBeNull();
  });
  it("holds revocation locks until the selecting transaction commits", async () => {
    await withSystemTx(pool, tx => seedRuntimeBundle(tx));
    await withSystemTx(pool, async tx => {
      expect(await selectCloudRuntime(tx, "full")).not.toBeNull();
      await expect(withSystemTx(pool, async revoker => {
        await revoker.query("SET LOCAL lock_timeout='100ms'");
        await revoker.query("UPDATE cloud_runtime_qualifications SET revoked_at=now(),enabled=false,mcp_qualified=false WHERE credential_kind='codex-chatgpt'");
      })).rejects.toMatchObject({ code: "55P03" });
    });
  });

  // Query the same join used by discovery and execution against real registry
  // rows. Composite input rows let negative tests exercise impossible/stale
  // engine pins without weakening the generation/engine database triggers.
  const credentialQualified = async (options: { mode?: "full" | "smoke"; mcp?: boolean; kind?: string;
    compat?: string; engineRuntimeId?: string } = {}) => withSystemTx(pool, async tx => {
    const generation = { provider: "boat", image_ref: runtimeBase.imageRef, runtime_id: `r1-${"a".repeat(64)}`,
      runtime_manifest_sha256: "a".repeat(64), runtime_base_image_id: runtimeBase.id,
      runtime_base_compatibility_id: options.compat ?? runtimeBase.compatibilityId,
      runtime_profile: "zeros-cloud-worker-v4", runtime_engine_protocol_version: CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION };
    const engine = { ...generation, runtime_id: options.engineRuntimeId ?? generation.runtime_id };
    return (await tx.query(`SELECT count(*)::int AS count
      FROM jsonb_populate_record(NULL::cloud_workspace_generations, $1::jsonb) generation
      CROSS JOIN jsonb_populate_record(NULL::cloud_workspace_engine_instances, $2::jsonb) engine
      CROSS JOIN (SELECT $3::text AS kind) credential
      ${runtimeCredentialQualificationJoin("$4", "$5::boolean")}`,
    [JSON.stringify(generation), JSON.stringify(engine), options.kind ?? "codex-chatgpt", options.mode ?? "full", options.mcp ?? false])).rows[0].count;
  });
  it("uses exact per-kind runtime qualifications and independently gates MCP in both credential paths", async () => {
    await withSystemTx(pool, tx => seedRuntimeBundle(tx, { mcpQualified: false }));
    expect(await credentialQualified()).toBe(1);
    expect(await credentialQualified({ mcp: true })).toBe(0);
    expect(await credentialQualified({ kind: "codex-api-key" })).toBe(0);
    expect(await credentialQualified({ compat: `bc1-${"8".repeat(64)}` })).toBe(0);
    expect(await credentialQualified({ engineRuntimeId: `r1-${"7".repeat(64)}` })).toBe(0);
  });
  it("uses the same smoke/full and revocation rules for fresh credentials and renewals", async () => {
    await withSystemTx(pool, tx => seedRuntimeBundle(tx, { mode: "smoke" }));
    expect(await credentialQualified()).toBe(0);
    expect(await credentialQualified({ mode: "smoke", mcp: true })).toBe(1);
    await withSystemTx(pool, tx => tx.query("UPDATE cloud_runtime_qualifications SET enabled=false,mcp_qualified=false,revoked_at=now() WHERE credential_kind='codex-chatgpt'"));
    expect(await credentialQualified({ mode: "smoke" })).toBe(0);
  });
});
