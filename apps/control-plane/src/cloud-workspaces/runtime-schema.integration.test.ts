import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withSystemTx, withUserTx, type Tx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import {
  seedReadyCloudWorkspace,
  type ReadyCloudWorkspaceFixture,
} from "./test-fixtures.js";

const url = process.env.TEST_DATABASE_URL;
const database = url ? describe : describe.skip;
const fixtures = new URL(
  "../../../../packages/protocol/src/__tests__/fixtures/cloud-runtime/",
  import.meta.url,
);
const rawManifest = readFileSync(new URL("manifest.valid.json", fixtures));
const baseContract = JSON.parse(
  readFileSync(new URL("base-compatibility.valid.json", fixtures), "utf8"),
);
const manifest = JSON.parse(rawManifest.toString("utf8"));
const manifestSha256 = createHash("sha256").update(rawManifest).digest("hex");
const contractSha256 = createHash("sha256")
  .update(readFileSync(new URL("base-compatibility.valid.json", fixtures)))
  .digest("hex");
const runtimeId = `r1-${manifestSha256}`;
const baseCompatibilityId = `bc1-${contractSha256}`;
const baseImageId = "zeros-v2-test-base";
const baseImageRef = "zeros-v2-test-base-snapshot";
const baseSourceCommit = "c".repeat(40);
const registryTables = [
  "cloud_runtime_base_contracts",
  "cloud_runtime_base_images",
  "cloud_runtime_bundles",
  "cloud_runtime_channel_releases",
  "cloud_runtime_qualifications",
] as const;
type Row = Record<string, unknown>;
const pin = {
  runtime_id: runtimeId,
  runtime_manifest_sha256: manifestSha256,
  runtime_base_image_id: baseImageId,
  runtime_base_compatibility_id: baseCompatibilityId,
  runtime_profile: "zeros-cloud-worker-v4",
  runtime_engine_protocol_version: 20,
};
const witness = {
  runtime_installer_receipt_sha256: "e".repeat(64),
  runtime_boot_id: "11111111-1111-4111-8111-111111111111",
  runtime_supervisor_session_id: "22222222-2222-4222-8222-222222222222",
};
const identityColumns = [...Object.keys(pin), ...Object.keys(witness)];
const nullPin = Object.fromEntries(
  Object.keys(pin).map((column) => [column, null]),
);
const nullIdentity = Object.fromEntries(
  identityColumns.map((column) => [column, null]),
);
const jsonColumns = new Set([
  "contract",
  "manifest_header",
  "evidence",
  "native_capabilities",
  "effective_document",
  "provenance",
  "source_versions",
]);
const values = (row: Row) =>
  Object.entries(row).map(([column, value]) =>
    jsonColumns.has(column) ? JSON.stringify(value) : value,
  );

// Table/column names below are test-authored constants, never external input.
async function insert(tx: Tx, table: string, row: Row): Promise<void> {
  const columns = Object.keys(row);
  await tx.query(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})`,
    values(row),
  );
}
async function update(
  tx: Tx,
  table: string,
  changes: Row,
  key: Row,
): Promise<void> {
  const columns = Object.keys(changes),
    keys = Object.keys(key);
  await tx.query(
    `UPDATE ${table} SET ${columns.map((column, index) => `${column}=$${index + 1}`).join(", ")} WHERE ${keys.map((column, index) => `${column}=$${columns.length + index + 1}`).join(" AND ")}`,
    [...values(changes), ...Object.values(key)],
  );
}

database("v4 runtime registry and immutable schema", () => {
  let pool: pg.Pool;
  let fixture: ReadyCloudWorkspaceFixture;
  let providerConnectionId: string;
  let registryRows: Record<(typeof registryTables)[number], Row>;
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: url, max: 4 });
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    fixture = await seedReadyCloudWorkspace(pool);
    providerConnectionId = randomUUID();
    const { files: _files, ...header } = manifest;
    registryRows = {
      cloud_runtime_base_contracts: {
        base_compatibility_id: baseCompatibilityId,
        contract_sha256: contractSha256,
        contract: baseContract,
      },
      cloud_runtime_base_images: {
        base_image_id: baseImageId,
        provider: "boat",
        image_ref: baseImageRef,
        base_compatibility_id: baseCompatibilityId,
        source_commit: baseSourceCommit,
        image_build_sha256: "d".repeat(64),
        architecture: "linux/amd64",
        storage_mib: 20480,
        approved_at: new Date(),
      },
      cloud_runtime_bundles: {
        runtime_id: runtimeId,
        manifest_sha256: manifestSha256,
        archive_sha256: "d".repeat(64),
        archive_bytes: 100,
        expanded_bytes: 6,
        object_key: `runtime/v1/${runtimeId}.tar.gz`,
        source_commit: manifest.source.commit,
        architecture: "linux/amd64",
        node_version: "22.23.1",
        node_modules_abi: 127,
        bootstrap_protocol_version: 1,
        setup_protocol_version: 2,
        engine_protocol_version: 20,
        manifest_header: header,
      },
      cloud_runtime_channel_releases: {
        channel: "alpha",
        release_order: 1,
        runtime_id: runtimeId,
        github_release_run_id: 1,
        github_release_run_attempt: 1,
      },
      cloud_runtime_qualifications: {
        runtime_id: runtimeId,
        base_compatibility_id: baseCompatibilityId,
        credential_kind: "claude-setup-token",
        profile: "zeros-cloud-worker-v4",
        enabled: true,
        mcp_qualified: true,
        evidence: { mode: "smoke", checks: ["manifest_digest"] },
        qualified_at: new Date(),
      },
    };
    await withSystemTx(pool, async (tx) => {
      for (const table of registryTables)
        await insert(tx, table, registryRows[table]);
      await insert(tx, "provider_connections", {
        id: providerConnectionId,
        org_id: fixture.organizationId,
        owner_kind: "organization",
        provider: "boat",
        display_name: "Runtime schema fixture",
        credential_source: "hosted",
        current_version: 1,
        state: "active",
      });
      await insert(tx, "provider_connection_versions", {
        connection_id: providerConnectionId,
        org_id: fixture.organizationId,
        version: 1,
        credential_source: "hosted",
        endpoint: "hosted://boat",
        created_by: fixture.userId,
      });
    });
  });

  function generation(overrides: Row = {}): Row {
    return {
      workspace_id: fixture.workspaceId,
      generation: 2,
      org_id: fixture.organizationId,
      provider: "boat",
      image_ref: baseImageRef,
      architecture: "linux/amd64",
      cpu_millicores: 2000,
      memory_mib: 4096,
      storage_mib: 20480,
      source_commit: baseSourceCommit,
      created_by: fixture.userId,
      provider_connection_id: providerConnectionId,
      ...pin,
      ...overrides,
    };
  }
  async function setup(consumed = true) {
    const setupRunId = randomUUID(),
      registrationGrantId = randomUUID(),
      settingsVersionId = randomUUID();
    await withSystemTx(pool, async (tx) => {
      await insert(tx, "cloud_workspace_generations", generation());
      await insert(tx, "workspace_settings_versions", {
        id: settingsVersionId,
        workspace_id: fixture.workspaceId,
        generation: 2,
        org_id: fixture.organizationId,
        effective_document: { schemaVersion: 1, values: {} },
        provenance: {},
        source_versions: { fixture: 1 },
        created_by: fixture.userId,
      });
      await tx.query(
        `INSERT INTO cloud_workspace_setup_specs (workspace_id, generation, org_id, repository_forge, repository_owner,
        repository_name, repository_revision, settings_snapshot, settings_snapshot_sha256, workspace_settings_version_id)
        SELECT workspace_id, 2, org_id, repository_forge, repository_owner, repository_name, repository_revision,
          settings_snapshot, settings_snapshot_sha256, $2 FROM cloud_workspace_setup_specs WHERE workspace_id=$1 AND generation=1`,
        [fixture.workspaceId, settingsVersionId],
      );
      await insert(tx, "cloud_workspace_setup_runs", {
        id: setupRunId,
        workspace_id: fixture.workspaceId,
        generation: 2,
        org_id: fixture.organizationId,
        attempt: 1,
        state: "running",
        claim_count: 1,
        execution_fence: 1,
        lease_owner: "runtime-schema-fixture",
        lease_expires_at: new Date(Date.now() + 600_000),
        last_heartbeat_at: new Date(),
        started_at: new Date(),
      });
      await insert(tx, "cloud_workspace_endpoint_grants", {
        id: registrationGrantId,
        workspace_id: fixture.workspaceId,
        generation: 2,
        org_id: fixture.organizationId,
        account_user_id: fixture.userId,
        purpose: "engine-connect",
        audience: "runtime-schema-fixture",
        token_hash: randomBytes(32),
        account_revision: 1,
        authorization_revision: 1,
        expires_at: new Date(Date.now() + 600_000),
        consumed_at: consumed ? new Date() : null,
      });
    });
    return { setupRunId, registrationGrantId };
  }
  function engine(
    context: Awaited<ReturnType<typeof setup>>,
    overrides: Row = {},
  ): Row {
    return {
      id: randomUUID(),
      workspace_id: fixture.workspaceId,
      generation: 2,
      org_id: fixture.organizationId,
      account_user_id: fixture.userId,
      setup_run_id: context.setupRunId,
      setup_execution_fence: 1,
      registration_grant_id: context.registrationGrantId,
      protocol_version: 20,
      state: "ready",
      bridge_token_hash: randomBytes(32),
      heartbeat_token_hash: randomBytes(32),
      registered_at: new Date(),
      last_heartbeat_at: new Date(),
      lease_expires_at: new Date(Date.now() + 600_000),
      ...pin,
      ...witness,
      ...overrides,
    };
  }
  async function attestation(
    engineInstanceId: unknown,
    overrides: Row = {},
  ): Promise<Row> {
    return withSystemTx(pool, async (tx) => {
      const result = await tx.query(
        `SELECT engine.id AS engine_instance_id, engine.setup_run_id, engine.workspace_id, engine.generation, engine.org_id,
        engine.setup_execution_fence AS execution_fence, engine.protocol_version AS engine_protocol_version,
        generation.image_ref, generation.source_commit AS image_source_commit, spec.repository_revision, spec.spec_version AS settings_version,
        spec.settings_snapshot_sha256, ${identityColumns.map((column) => `engine.${column}`).join(", ")}
        FROM cloud_workspace_engine_instances engine JOIN cloud_workspace_generations generation
          ON generation.workspace_id=engine.workspace_id AND generation.org_id=engine.org_id AND generation.generation=engine.generation
        JOIN cloud_workspace_setup_specs spec ON spec.workspace_id=engine.workspace_id AND spec.org_id=engine.org_id AND spec.generation=engine.generation
        WHERE engine.id=$1`,
        [engineInstanceId],
      );
      return {
        ...result.rows[0],
        repository_commit: "f".repeat(40),
        engine_health: "ready",
        durable_record_connected: true,
        ...overrides,
      };
    });
  }

  it("retains legacy NULL generations, v3 engines and NULL attestations", async () => {
    await withSystemTx(pool, async (tx) => {
      const saved = await tx.query(
        "SELECT runtime_id, runtime_profile FROM cloud_workspace_generations WHERE workspace_id=$1 AND generation=1",
        [fixture.workspaceId],
      );
      expect(saved.rows[0]).toEqual({
        runtime_id: null,
        runtime_profile: null,
      });
      await update(
        tx,
        "cloud_workspace_generations",
        { retired_at: new Date() },
        { workspace_id: fixture.workspaceId, generation: 1 },
      );
      await update(
        tx,
        "cloud_workspace_engine_instances",
        {
          agent_runtime_profile: "zeros-cloud-worker-v3",
          agent_runtime_contract_sha256: "a".repeat(64),
        },
        { id: fixture.engineInstanceId },
      );
    });
    const receipt = await attestation(fixture.engineInstanceId);
    await withSystemTx(pool, (tx) =>
      insert(tx, "cloud_workspace_setup_attestations", receipt),
    );
    const saved = await withSystemTx(pool, (tx) =>
      tx.query(
        "SELECT runtime_id, runtime_profile FROM cloud_workspace_setup_attestations WHERE setup_run_id=$1",
        [receipt.setup_run_id],
      ),
    );
    expect(saved.rows[0]).toEqual({ runtime_id: null, runtime_profile: null });
  });

  it("rejects partial generation pins and unpinned registered v4 bases", async () => {
    for (const column of Object.keys(pin))
      await expect(
        withSystemTx(pool, (tx) =>
          insert(
            tx,
            "cloud_workspace_generations",
            generation({ [column]: null }),
          ),
        ),
      ).rejects.toMatchObject({ code: "23514" });
    await expect(
      withSystemTx(pool, (tx) =>
        insert(tx, "cloud_workspace_generations", generation(nullPin)),
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("accepts an org template ref with a matching runtime base pin", async () => {
    await withSystemTx(pool, (tx) =>
      insert(
        tx,
        "cloud_workspace_generations",
        generation({ image_ref: "boat-template:zeros-v2-test-template_1" }),
      ),
    );
  });

  it("rejects arbitrary or malformed template refs with a runtime pin", async () => {
    for (const image_ref of [
      "zeros-v2-test-arbitrary-snapshot",
      "boat-template:",
      "boat-template:zeros-v2-test-template/child",
      "boat-template:zeros-v2-test-template:child",
      `boat-template:${"x".repeat(129)}`,
    ])
      await expect(
        withSystemTx(pool, (tx) =>
          insert(
            tx,
            "cloud_workspace_generations",
            generation({ image_ref }),
          ),
        ),
      ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects template refs whose source or storage mismatches the pinned base", async () => {
    for (const changes of [
      { source_commit: manifest.source.commit },
      { storage_mib: 20481 },
    ])
      await expect(
        withSystemTx(pool, (tx) =>
          insert(
            tx,
            "cloud_workspace_generations",
            generation({
              image_ref: "boat-template:zeros-v2-test-template_1",
              ...changes,
            }),
          ),
        ),
      ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects mismatched base pairs, saved base provenance, manifest digests and protocols", async () => {
    const otherContract = { ...baseContract, systemdMin: 255 };
    const otherDigest = createHash("sha256")
      .update(JSON.stringify(otherContract))
      .digest("hex");
    const otherCompatibilityId = `bc1-${otherDigest}`;
    await withSystemTx(pool, async (tx) => {
      await insert(tx, "cloud_runtime_base_contracts", {
        base_compatibility_id: otherCompatibilityId,
        contract_sha256: otherDigest,
        contract: otherContract,
      });
      await insert(tx, "cloud_runtime_base_images", {
        ...registryRows.cloud_runtime_base_images,
        base_image_id: "zeros-v2-test-other-base",
        image_ref: "zeros-v2-test-other-snapshot",
        base_compatibility_id: otherCompatibilityId,
      });
    });
    for (const changes of [
      { runtime_base_compatibility_id: otherCompatibilityId },
      { runtime_base_image_id: "zeros-v2-test-other-base" },
      { image_ref: "zeros-v2-test-other-snapshot" },
      { source_commit: manifest.source.commit },
      { storage_mib: 20481 },
      { runtime_manifest_sha256: "0".repeat(64) },
      { runtime_engine_protocol_version: 19 },
    ])
      await expect(
        withSystemTx(pool, (tx) =>
          insert(tx, "cloud_workspace_generations", generation(changes)),
        ),
      ).rejects.toMatchObject({ code: "23514" });
  });

  it("makes generation pins immutable, including legacy NULL-to-v4 updates", async () => {
    await withSystemTx(pool, (tx) =>
      insert(tx, "cloud_workspace_generations", generation()),
    );
    for (const column of Object.keys(pin))
      await expect(
        withSystemTx(pool, (tx) =>
          update(
            tx,
            "cloud_workspace_generations",
            { [column]: null },
            { workspace_id: fixture.workspaceId, generation: 2 },
          ),
        ),
      ).rejects.toMatchObject({ code: "55000" });
    await expect(
      withSystemTx(pool, (tx) =>
        update(tx, "cloud_workspace_generations", pin, {
          workspace_id: fixture.workspaceId,
          generation: 1,
        }),
      ),
    ).rejects.toMatchObject({ code: "55000" });
    await withSystemTx(pool, (tx) =>
      update(
        tx,
        "cloud_workspace_generations",
        { retired_at: new Date() },
        { workspace_id: fixture.workspaceId, generation: 2 },
      ),
    );
  });

  it("registers a v4 ready engine and attestation with the exact witness", async () => {
    const context = await setup(),
      row = engine(context);
    await withSystemTx(pool, (tx) =>
      insert(tx, "cloud_workspace_engine_instances", row),
    );
    const receipt = await attestation(row.id);
    await withSystemTx(pool, (tx) =>
      insert(tx, "cloud_workspace_setup_attestations", receipt),
    );
    await expect(
      withSystemTx(pool, (tx) =>
        update(
          tx,
          "cloud_workspace_setup_attestations",
          { runtime_boot_id: randomUUID() },
          { setup_run_id: context.setupRunId },
        ),
      ),
    ).rejects.toMatchObject({ code: "55000" });
  });

  it("allows starting before grant consumption, then requires consumption before ready", async () => {
    const context = await setup(false),
      row = engine(context, {
        state: "starting",
        heartbeat_token_hash: null,
        registered_at: null,
        last_heartbeat_at: null,
        lease_expires_at: null,
      });
    await withSystemTx(pool, (tx) =>
      insert(tx, "cloud_workspace_engine_instances", row),
    );
    const ready = {
      state: "ready",
      heartbeat_token_hash: randomBytes(32),
      registered_at: new Date(),
      last_heartbeat_at: new Date(),
      lease_expires_at: new Date(Date.now() + 600_000),
    };
    await expect(
      withSystemTx(pool, (tx) =>
        update(tx, "cloud_workspace_engine_instances", ready, { id: row.id }),
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await withSystemTx(pool, (tx) =>
      update(
        tx,
        "cloud_workspace_endpoint_grants",
        { consumed_at: new Date() },
        { id: context.registrationGrantId },
      ),
    );
    await withSystemTx(pool, (tx) =>
      update(tx, "cloud_workspace_engine_instances", ready, { id: row.id }),
    );
    // Registration capability expiry must not prevent later heartbeat/retirement.
    await withSystemTx(pool, (tx) =>
      update(
        tx,
        "cloud_workspace_endpoint_grants",
        {
          created_at: new Date(Date.now() - 3_600_000),
          expires_at: new Date(Date.now() - 60_000),
        },
        { id: context.registrationGrantId },
      ),
    );
    await withSystemTx(pool, (tx) =>
      update(
        tx,
        "cloud_workspace_engine_instances",
        {
          last_heartbeat_at: new Date(),
          lease_expires_at: new Date(Date.now() + 600_000),
        },
        { id: row.id },
      ),
    );
  });

  it("rejects v4 engines with legacy fields, partial identities or different generation pins", async () => {
    const context = await setup();
    for (const changes of [
      {
        agent_runtime_profile: "zeros-cloud-worker-v3",
        agent_runtime_contract_sha256: "a".repeat(64),
      },
      { runtime_boot_id: null },
      { runtime_id: `r1-${"0".repeat(64)}` },
      { protocol_version: 19 },
      nullIdentity,
    ])
      await expect(
        withSystemTx(pool, (tx) =>
          insert(
            tx,
            "cloud_workspace_engine_instances",
            engine(context, changes),
          ),
        ),
      ).rejects.toMatchObject({ code: "23514" });
    const row = engine(context);
    await withSystemTx(pool, (tx) =>
      insert(tx, "cloud_workspace_engine_instances", row),
    );
    for (const column of identityColumns)
      await expect(
        withSystemTx(pool, (tx) =>
          update(
            tx,
            "cloud_workspace_engine_instances",
            { [column]: null },
            { id: row.id },
          ),
        ),
      ).rejects.toMatchObject({ code: "55000" });
    await expect(
      withSystemTx(pool, (tx) =>
        update(
          tx,
          "cloud_workspace_engine_instances",
          {
            agent_runtime_profile: "zeros-cloud-worker-v3",
            agent_runtime_contract_sha256: "a".repeat(64),
          },
          { id: row.id },
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects a consumed grant from another generation and a revoked registration grant", async () => {
    const context = await setup();
    const oldGrant = await withSystemTx(pool, (tx) =>
      tx.query(
        "SELECT registration_grant_id FROM cloud_workspace_engine_instances WHERE id=$1",
        [fixture.engineInstanceId],
      ),
    );
    await expect(
      withSystemTx(pool, (tx) =>
        insert(
          tx,
          "cloud_workspace_engine_instances",
          engine(context, {
            registration_grant_id: oldGrant.rows[0].registration_grant_id,
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await withSystemTx(pool, (tx) =>
      update(
        tx,
        "cloud_workspace_endpoint_grants",
        { revoked_at: new Date() },
        { id: context.registrationGrantId },
      ),
    );
    await expect(
      withSystemTx(pool, (tx) =>
        insert(tx, "cloud_workspace_engine_instances", engine(context)),
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects attestation downgrades, partial identities and mismatched receipts/boot/session", async () => {
    const context = await setup(),
      row = engine(context);
    await withSystemTx(pool, (tx) =>
      insert(tx, "cloud_workspace_engine_instances", row),
    );
    for (const changes of [
      nullIdentity,
      { runtime_installer_receipt_sha256: null },
      { runtime_installer_receipt_sha256: "0".repeat(64) },
      { runtime_boot_id: randomUUID() },
      { runtime_supervisor_session_id: randomUUID() },
    ]) {
      const receipt = await attestation(row.id, changes);
      await expect(
        withSystemTx(pool, (tx) =>
          insert(tx, "cloud_workspace_setup_attestations", receipt),
        ),
      ).rejects.toMatchObject({ code: "23514" });
    }
  });

  it("rejects registry identity rewrites and every registry DELETE in system context", async () => {
    const mutations: Record<(typeof registryTables)[number], Row> = {
      cloud_runtime_base_contracts: { contract_sha256: "0".repeat(64) },
      cloud_runtime_base_images: { source_commit: "0".repeat(40) },
      cloud_runtime_bundles: { archive_bytes: 101 },
      cloud_runtime_channel_releases: { github_release_run_attempt: 2 },
      cloud_runtime_qualifications: { evidence: { mode: "smoke", checks: [] } },
    };
    for (const table of registryTables) {
      const key =
        table === "cloud_runtime_base_contracts"
          ? { base_compatibility_id: baseCompatibilityId }
          : table === "cloud_runtime_base_images"
            ? { base_image_id: baseImageId }
            : { runtime_id: runtimeId };
      await expect(
        withSystemTx(pool, (tx) => update(tx, table, mutations[table], key)),
      ).rejects.toMatchObject({ code: "55000" });
      const column = Object.keys(key)[0],
        value = Object.values(key)[0];
      await expect(
        withSystemTx(pool, (tx) =>
          tx.query(`DELETE FROM ${table} WHERE ${column}=$1`, [value]),
        ),
      ).rejects.toMatchObject({ code: "55000" });
    }
  });

  it("allows only one-way release confirmation and registry revocation", async () => {
    await withSystemTx(pool, (tx) =>
      update(
        tx,
        "cloud_runtime_channel_releases",
        { confirmed_at: new Date() },
        { channel: "alpha", release_order: 1 },
      ),
    );
    await expect(
      withSystemTx(pool, (tx) =>
        update(
          tx,
          "cloud_runtime_channel_releases",
          { confirmed_at: null },
          { channel: "alpha", release_order: 1 },
        ),
      ),
    ).rejects.toMatchObject({ code: "55000" });
    for (const table of registryTables.filter(
      (table) => table !== "cloud_runtime_qualifications",
    )) {
      const key =
        table === "cloud_runtime_base_contracts"
          ? { base_compatibility_id: baseCompatibilityId }
          : table === "cloud_runtime_base_images"
            ? { base_image_id: baseImageId }
            : { runtime_id: runtimeId };
      await withSystemTx(pool, (tx) =>
        update(tx, table, { revoked_at: new Date() }, key),
      );
      await expect(
        withSystemTx(pool, (tx) =>
          update(tx, table, { revoked_at: null }, key),
        ),
      ).rejects.toMatchObject({ code: "55000" });
    }
    // Revocation preserves saved pins and their audit/retirement references.
    await withSystemTx(pool, (tx) =>
      insert(tx, "cloud_workspace_generations", generation()),
    );
    await withSystemTx(pool, (tx) =>
      update(
        tx,
        "cloud_workspace_generations",
        { retired_at: new Date() },
        { workspace_id: fixture.workspaceId, generation: 2 },
      ),
    );
  });

  it("revokes qualification bits together without rewriting evidence or re-enabling them", async () => {
    const key = {
      runtime_id: runtimeId,
      credential_kind: "claude-setup-token",
    };
    await expect(
      withSystemTx(pool, (tx) =>
        update(tx, "cloud_runtime_qualifications", { enabled: false }, key),
      ),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      withSystemTx(pool, (tx) =>
        update(
          tx,
          "cloud_runtime_qualifications",
          { revoked_at: new Date() },
          key,
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await withSystemTx(pool, (tx) =>
      update(
        tx,
        "cloud_runtime_qualifications",
        { revoked_at: new Date(), enabled: false, mcp_qualified: false },
        key,
      ),
    );
    for (const changes of [
      { enabled: true },
      { mcp_qualified: true },
      { revoked_at: null },
      { native_capabilities: { version: 1 } },
    ])
      await expect(
        withSystemTx(pool, (tx) =>
          update(tx, "cloud_runtime_qualifications", changes, key),
        ),
      ).rejects.toMatchObject({ code: "55000" });
  });

  it("bounds JSON evidence/metadata and keeps credential kinds and v4 profiles exact", async () => {
    const qualification = {
      ...registryRows.cloud_runtime_qualifications,
      credential_kind: "codex-chatgpt",
    };
    for (const changes of [
      { evidence: [] },
      { evidence: { padding: "x".repeat(65536) } },
      { native_capabilities: [] },
      { native_capabilities: { padding: "x".repeat(16384) } },
      { credential_kind: "unknown" },
      { profile: "zeros-cloud-worker-v3" },
    ])
      await expect(
        withSystemTx(pool, (tx) =>
          insert(tx, "cloud_runtime_qualifications", {
            ...qualification,
            ...changes,
          }),
        ),
      ).rejects.toMatchObject({ code: "23514" });
    await expect(
      withSystemTx(pool, (tx) =>
        insert(tx, "cloud_runtime_base_contracts", {
          ...registryRows.cloud_runtime_base_contracts,
          base_compatibility_id: `bc1-${"0".repeat(64)}`,
          contract_sha256: "0".repeat(64),
          contract: {
            schema: "zeros.base-compatibility/v1",
            padding: "x".repeat(65536),
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("inherits application grants while forcing system-only RLS on every new table", async () => {
    const role = await withSystemTx(pool, (tx) =>
      tx.query(
        "SELECT current_user AS name, rolbypassrls FROM pg_roles WHERE rolname=current_user",
      ),
    );
    expect(role.rows[0]).toEqual({ name: "zeros_app", rolbypassrls: false });
    for (const table of registryTables) {
      const catalog = await pool.query(
        "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid=$1::regclass",
        [table],
      );
      expect(catalog.rows[0]).toEqual({
        relrowsecurity: true,
        relforcerowsecurity: true,
      });
      for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"])
        expect(
          (
            await pool.query(
              "SELECT has_table_privilege('zeros_app',$1,$2) AS allowed",
              [table, privilege],
            )
          ).rows[0].allowed,
        ).toBe(true);
      expect(
        (
          await pool.query(
            "SELECT has_table_privilege('zeros_app',$1,'TRUNCATE') AS allowed",
            [table],
          )
        ).rows[0].allowed,
      ).toBe(false);
      const visible = await withUserTx(pool, fixture.userId, (tx) =>
        tx.query(`SELECT count(*)::integer AS count FROM ${table}`),
      );
      expect(visible.rows[0].count).toBe(0);
      await expect(
        withUserTx(pool, fixture.userId, (tx) =>
          insert(tx, table, registryRows[table]),
        ),
      ).rejects.toMatchObject({ code: "42501" });
      const hiddenUpdate = await withUserTx(pool, fixture.userId, (tx) =>
        tx.query(
          `UPDATE ${table} SET revoked_at=now() WHERE revoked_at IS NULL`,
        ),
      );
      const hiddenDelete = await withUserTx(pool, fixture.userId, (tx) =>
        tx.query(`DELETE FROM ${table} WHERE revoked_at IS NULL`),
      );
      expect(hiddenUpdate.rowCount).toBe(0);
      expect(hiddenDelete.rowCount).toBe(0);
    }
    // The operator-only v3 qualification write boundary remains untouched.
    await expect(
      withSystemTx(pool, (tx) =>
        insert(tx, "cloud_agent_runtime_qualifications", {
          provider: "boat",
          image_ref: "zeros-v2-test-legacy",
          runtime_contract_sha256: "a".repeat(64),
          credential_kind: "cursor-api-key",
          profile: "zeros-cloud-worker-v3",
        }),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
