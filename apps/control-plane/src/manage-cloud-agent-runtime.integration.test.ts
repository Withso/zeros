import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { runMigrations } from "./migrate.js";
import { withSystemTx } from "./db.js";
import {
  CloudAgentRuntimeEvidenceSchema,
  manageCloudAgentRuntime,
  type CloudAgentRuntimeChange,
} from "./manage-cloud-agent-runtime.js";
const url = process.env.TEST_DATABASE_URL,
  d = url ? describe : describe.skip;
function request(actor: string): CloudAgentRuntimeChange {
  return {
    operationId: randomUUID(),
    actorUserId: actor,
    enabled: true,
    reason: "Qualified immutable test runtime and exact authentication kind",
    evidence: {
      version: 1,
      channel: "development",
      provider: "boat",
      runtimeClass: "linux-vm",
      imageRef: `boat:zeros-test-runtime@sha256:${"a".repeat(64)}`,
      profile: "zeros-cloud-worker-v3",
      runtimeContractSha256: "b".repeat(64),
      sourceCommit: "c".repeat(40),
      evidenceSha256: "d".repeat(64),
      qualifiedAt: new Date().toISOString(),
      credentials: [
        {
          kind: "cursor-api-key",
          renewal: false,
          checks: {
            privateCredentialIsolation: true,
            workloadCredentialDenial: true,
            actorAdmission: true,
            stopAndRevocation: true,
            nativeTurn: true,
            nativeResume: true,
            authentication: true,
          },
        },
      ],
    },
  };
}
describe("runtime qualification evidence", () => {
  it("rejects aliases, missing credential proofs, duplicate kinds and unqualified subscription renewal", () => {
    const original = request(randomUUID()).evidence;
    for (const changed of [
      { imageRef: "latest" },
      { runtimeClass: "container" },
      { profile: "zeros-cloud-worker-v2" },
      { credentials: [] },
      { credentials: [...original.credentials, ...original.credentials] },
      {
        credentials: [
          { ...original.credentials[0], kind: "codex-chatgpt", renewal: false },
        ],
      },
      {
        credentials: [
          {
            ...original.credentials[0],
            checks: {
              ...original.credentials[0]!.checks,
              privateCredentialIsolation: false,
            },
          },
        ],
      },
    ])
      expect(
        CloudAgentRuntimeEvidenceSchema.safeParse({ ...original, ...changed })
          .success,
      ).toBe(false);
  });
});
d("owner-only runtime qualification changes", () => {
  let pool: pg.Pool, actor: string;
  const options = () => ({ databaseUrl: url!, channel: "development" });
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: url, max: 3 });
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await runMigrations(pool);
    actor = randomUUID();
    await pool.query(
      "INSERT INTO users(id,email,display_name,staff_role) VALUES ($1,$2,'Qualification Owner','platform_owner')",
      [actor, `${actor}@example.test`],
    );
  });
  it("plans without writes, enables only exact proven kinds and atomically records immutable evidence", async () => {
    const input = request(actor),
      plan = await manageCloudAgentRuntime(pool, input, options());
    expect(plan.state).toBe("planned");
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM cloud_agent_runtime_qualifications",
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (
        await manageCloudAgentRuntime(pool, input, {
          ...options(),
          execute: true,
          approval: plan.planSha256,
        })
      ).state,
    ).toBe("changed");
    expect(
      (
        await pool.query(
          "SELECT credential_kind,enabled,runtime_contract_sha256 FROM cloud_agent_runtime_qualifications",
        )
      ).rows,
    ).toEqual([
      {
        credential_kind: "cursor-api-key",
        enabled: true,
        runtime_contract_sha256: input.evidence.runtimeContractSha256,
      },
    ]);
    expect(
      (
        await manageCloudAgentRuntime(pool, input, {
          ...options(),
          execute: true,
          approval: plan.planSha256,
        })
      ).state,
    ).toBe("replayed");
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM cloud_agent_runtime_qualification_changes",
        )
      ).rows[0].n,
    ).toBe(1);
    for (const query of [
      "DELETE FROM cloud_agent_runtime_qualification_changes",
      "UPDATE cloud_agent_runtime_qualification_changes SET reason='Forged operator qualification evidence'",
      "TRUNCATE cloud_agent_runtime_qualification_changes",
    ])
      await expect(pool.query(query)).rejects.toMatchObject({ code: "55000" });
  });
  it("refuses stale current-state plans, conflicting operation retries and another deployment channel", async () => {
    const input = request(actor),
      plan = await manageCloudAgentRuntime(pool, input, options());
    const contender = { ...input, operationId: randomUUID() };
    await manageCloudAgentRuntime(pool, contender, {
      ...options(),
      execute: true,
      approval: (await manageCloudAgentRuntime(pool, contender, options()))
        .planSha256,
    });
    await expect(
      manageCloudAgentRuntime(pool, input, {
        ...options(),
        execute: true,
        approval: plan.planSha256,
      }),
    ).rejects.toThrow(/plan mismatch/);
    await expect(
      manageCloudAgentRuntime(
        pool,
        { ...contender, enabled: false },
        options(),
      ),
    ).rejects.toThrow(/identity was reused/);
    await expect(
      manageCloudAgentRuntime(pool, input, {
        ...options(),
        channel: "production",
      }),
    ).rejects.toThrow(/channel mismatch/);
  });
  it("requires a current platform owner and does not let the application forge qualification", async () => {
    const input = request(actor);
    await pool.query("UPDATE users SET staff_role='developer' WHERE id=$1", [
      actor,
    ]);
    await expect(
      manageCloudAgentRuntime(pool, input, options()),
    ).rejects.toThrow(/platform owner/);
    await expect(
      withSystemTx(pool, (tx) =>
        tx.query(
          "INSERT INTO cloud_agent_runtime_qualifications(provider,image_ref,runtime_contract_sha256,credential_kind,profile) VALUES('boat','test',$1,'cursor-api-key','zeros-cloud-worker-v3')",
          ["a".repeat(64)],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      withSystemTx(pool, (tx) =>
        tx.query("SELECT * FROM cloud_agent_runtime_qualification_changes"),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });
  it("disables an exact tuple while preserving qualification history", async () => {
    const input = request(actor),
      plan = await manageCloudAgentRuntime(pool, input, options());
    await manageCloudAgentRuntime(pool, input, {
      ...options(),
      execute: true,
      approval: plan.planSha256,
    });
    const disable = { ...input, operationId: randomUUID(), enabled: false };
    await manageCloudAgentRuntime(pool, disable, {
      ...options(),
      execute: true,
      approval: (await manageCloudAgentRuntime(pool, disable, options()))
        .planSha256,
    });
    expect(
      (
        await pool.query(
          "SELECT enabled FROM cloud_agent_runtime_qualifications",
        )
      ).rows,
    ).toEqual([{ enabled: false }]);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM cloud_agent_runtime_qualification_changes",
        )
      ).rows[0].n,
    ).toBe(2);
  });
  it("binds plans to PlanetScale branch routing without binding passwords", async () => {
    const input = request(actor),
      a = new URL(url!),
      b = new URL(url!);
    a.username = "role.branch-a";
    b.username = "role.branch-b";
    const first = await manageCloudAgentRuntime(pool, input, {
      ...options(),
      databaseUrl: a.toString(),
    });
    const second = await manageCloudAgentRuntime(pool, input, {
      ...options(),
      databaseUrl: b.toString(),
    });
    expect(first.targetSha256).not.toBe(second.targetSha256);
    expect(first.planSha256).not.toBe(second.planSha256);
    a.password = "rotated-secret";
    expect(
      (
        await manageCloudAgentRuntime(pool, input, {
          ...options(),
          databaseUrl: a.toString(),
        })
      ).planSha256,
    ).toBe(first.planSha256);
    await expect(
      manageCloudAgentRuntime(pool, input, {
        ...options(),
        databaseUrl: b.toString(),
        execute: true,
        approval: first.planSha256,
      }),
    ).rejects.toThrow(/plan mismatch/);
  });
  it("replays a committed receipt after evidence freshness expires", async () => {
    const input = request(actor),
      plan = await manageCloudAgentRuntime(pool, input, options());
    await manageCloudAgentRuntime(pool, input, {
      ...options(),
      execute: true,
      approval: plan.planSha256,
    });
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.now() + 8 * 86400000);
    try {
      expect(
        (
          await manageCloudAgentRuntime(pool, input, {
            ...options(),
            execute: true,
            approval: plan.planSha256,
          })
        ).state,
      ).toBe("replayed");
      await expect(
        manageCloudAgentRuntime(
          pool,
          { ...input, operationId: randomUUID() },
          options(),
        ),
      ).rejects.toThrow(/stale/);
    } finally {
      clock.mockRestore();
    }
  });
  it("never revives an old approval after an intervening enable then disable", async () => {
    const input = request(actor),
      disabled = { ...input, enabled: false };
    await manageCloudAgentRuntime(pool, disabled, {
      ...options(),
      execute: true,
      approval: (await manageCloudAgentRuntime(pool, disabled, options()))
        .planSha256,
    });
    const pending = { ...input, operationId: randomUUID() },
      oldPlan = await manageCloudAgentRuntime(pool, pending, options());
    for (const enabled of [true, false]) {
      const change = { ...input, operationId: randomUUID(), enabled };
      await manageCloudAgentRuntime(pool, change, {
        ...options(),
        execute: true,
        approval: (await manageCloudAgentRuntime(pool, change, options()))
          .planSha256,
      });
    }
    await expect(
      manageCloudAgentRuntime(pool, pending, {
        ...options(),
        execute: true,
        approval: oldPlan.planSha256,
      }),
    ).rejects.toThrow(/plan mismatch/);
    expect(
      (
        await pool.query(
          "SELECT enabled FROM cloud_agent_runtime_qualifications",
        )
      ).rows,
    ).toEqual([{ enabled: false }]);
  });
  it("rolls back an enable if evidence publication fails", async () => {
    const input = request(actor),
      plan = await manageCloudAgentRuntime(pool, input, options());
    await pool.query(
      "CREATE FUNCTION reject_qualification_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END $$; CREATE TRIGGER reject_qualification_fixture BEFORE INSERT ON cloud_agent_runtime_qualification_changes FOR EACH ROW EXECUTE FUNCTION reject_qualification_fixture()",
    );
    await expect(
      manageCloudAgentRuntime(pool, input, {
        ...options(),
        execute: true,
        approval: plan.planSha256,
      }),
    ).rejects.toThrow();
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM cloud_agent_runtime_qualifications",
        )
      ).rows[0].n,
    ).toBe(0);
  });
});
