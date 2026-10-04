import { randomBytes, randomUUID } from "node:crypto";
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
import type { CloudWorkspaceBackendConfig } from "../config.js";
import { withSystemTx, type Tx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { BoatApiClient } from "./boat-client.js";
import { prepareBuilderVmOperation } from "./cloud-builder-vm.js";
import { DatabaseBuilderVmOperationStore } from "./cloud-builder-vm-store.js";
import { lockCloudComputerOrganization } from "./computer.js";
import {
  COMPUTER_TEMPLATE_RETENTION_CHANNEL,
  CloudComputerTemplateRetentionWorker,
  computerTemplateKeepSet,
  computerTemplateCleanupPending,
  type ComputerTemplateDeletionJournal,
} from "./computer-template-retention.js";
import { DatabaseCloudComputerV2Service } from "./computer-v2.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const accountScope = "fixture-account";
const billingOrg = "team_00000000-0000-0000-0000-000000000001";
type Operation = NonNullable<
  Awaited<ReturnType<ComputerTemplateDeletionJournal["find"]>>
>;
type Template = {
  id: string;
  resource: string;
  version: number;
  configId: string;
};
const key = (template: Template) => `computer-build:${template.id}`;

describe("computer template keep-set", () => {
  it("unions active, previous, references and exactly ten ready versions", () => {
    expect([
      ...computerTemplateKeepSet({
        active: "old-active",
        previous: "old-previous",
        referenced: ["old-source", "old-active"],
        newestReady: Array.from(
          { length: 11 },
          (_, index) => `ready-${index + 1}`,
        ),
      }),
    ]).toEqual([
      "old-active",
      "old-previous",
      "old-source",
      ...Array.from({ length: 10 }, (_, index) => `ready-${index + 1}`),
    ]);
  });
});

d("Cloud Computer template retention", () => {
  let pool: pg.Pool;
  let fixture: Awaited<ReturnType<typeof seedReadyCloudWorkspace>>;
  let service: DatabaseCloudComputerV2Service;
  let worker: CloudComputerTemplateRetentionWorker;
  let operations: Map<string, Operation>;
  let journal: ComputerTemplateDeletionJournal;
  let findHook: ((operationKey: string, tx?: Tx) => Promise<void>) | undefined;
  let live: Set<string>;
  let requests: Array<{
    id: string;
    method: string;
    wallet: string | null;
    confirm: string | null;
  }>;
  let deleteHook: ((id: string) => Promise<Response>) | undefined;
  let warnings: ReturnType<typeof vi.fn>;
  let client: BoatApiClient;

  beforeAll(() => {
    pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 8,
    });
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    fixture = await seedReadyCloudWorkspace(pool);
    service = new DatabaseCloudComputerV2Service(
      pool,
      {} as CloudWorkspaceBackendConfig,
    );
    operations = new Map();
    live = new Set();
    requests = [];
    findHook = undefined;
    deleteHook = undefined;
    warnings = vi.fn();
    journal = {
      find: vi.fn(async (operationKey, tx) => {
        await findHook?.(operationKey, tx);
        const row = operations.get(operationKey);
        return row ? { ...row } : null;
      }),
      state: vi.fn(async (operationKey, state) => {
        operations.get(operationKey)!.state = state;
      }),
      deletion: vi.fn(async (operationKey, operationId) => {
        operations.get(operationKey)!.deletion_operation_id = operationId;
      }),
    };
    client = new BoatApiClient({
      apiKey: "fixture-boat-api-key",
      timeoutMs: 1000,
      billingOrg,
      fetch: async (url, input) => {
        const id = new URL(String(url)).pathname.split("/").at(-1)!;
        const headers = new Headers(input?.headers);
        const method = input?.method ?? "GET";
        requests.push({
          id,
          method,
          wallet: headers.get("x-boat-org"),
          confirm: headers.get("x-ascii-confirm-delete"),
        });
        if (method === "DELETE") {
          const operation = [...operations.values()].find(
            (row) => row.sandbox_id === id,
          )!;
          expect((await journal.find(operation.operation_key))?.state).toBe(
            "deleting",
          );
          if (deleteHook) return deleteHook(id);
          if (!live.has(id)) return new Response("{}", { status: 404 });
          live.delete(id);
          return Response.json({
            ok: true,
            operation: {
              id: `bdop_${"a".repeat(32)}`,
              kind: "sandbox",
              targetId: id,
              status: "pending",
            },
          });
        }
        return live.has(id)
          ? Response.json({ ok: true, sandbox: { id, state: "archived" } })
          : new Response("{}", { status: 404 });
      },
    });
    worker = makeWorker();
  });
  const makeWorker = () =>
    new CloudComputerTemplateRetentionWorker(pool, {
      accountScope,
      billingOrg,
      client,
      journal,
      logger: { warn: warnings },
    });
  const tick = () => worker.tick(fixture.organizationId);
  const state = async (template: Template) =>
    (
      await pool.query(
        "SELECT state,retired_at FROM cloud_computer_templates WHERE build_id=$1",
        [template.id],
      )
    ).rows[0];
  const source = async (template: Template) =>
    withSystemTx(pool, async (tx) => {
      await lockCloudComputerOrganization(tx, fixture.organizationId);
      await tx.query(
        "SELECT org_id FROM cloud_computer_v2_heads WHERE org_id=$1 FOR UPDATE",
        [fixture.organizationId],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_computer_sources(workspace_id,generation,org_id,build_id,template_id,config_id)
       VALUES($1,1,$2,$3,$3,$4)`,
        [
          fixture.workspaceId,
          fixture.organizationId,
          template.id,
          template.configId,
        ],
      );
    });
  async function templates(count: number): Promise<Template[]> {
    const draft = await service.saveDraft(
      fixture.organizationId,
      fixture.userId,
      {
        expectedRevision: 0,
        repositories: [],
        installScript: "",
        timeoutSeconds: 900,
      },
    );
    const configId = draft.configId;
    const alphabet = "23456789abcdefghjkmnpqrstuvwxyz";
    const result = Array.from({ length: count }, (_, index) => ({
      id: randomUUID(),
      configId,
      version: index + 1,
      resource: `bx_${Array.from(randomBytes(8), (byte) => alphabet[byte % alphabet.length]).join("")}`,
    }));
    await withSystemTx(pool, async (tx) => {
      for (const template of result) {
        await tx.query(
          `INSERT INTO cloud_computer_v2_builds(id,org_id,version,config_id,accepted_revision,state,stage,requested_by,
             operation_id,base_image_id,runtime_id,repository_manifest,completed_at)
           VALUES($1,$2,$3,$4,1,'succeeded','done',$5,$6,'fixture-base','fixture-runtime','[]',now())`,
          [
            template.id,
            fixture.organizationId,
            template.version,
            configId,
            fixture.userId,
            randomUUID(),
          ],
        );
        await tx.query(
          `INSERT INTO cloud_computer_templates(build_id,org_id,state,provider_resource_id,account_scope,billing_org,
             protected_contract_digest,stopped_at) VALUES($1,$2,'ready',$3,$4,$5,$6,now())`,
          [
            template.id,
            fixture.organizationId,
            template.resource,
            accountScope,
            billingOrg,
            Buffer.alloc(32, 1),
          ],
        );
        operations.set(key(template), {
          operation_key: key(template),
          purpose: "computer-build",
          state: "archived",
          sandbox_id: template.resource,
          deletion_operation_id: null,
          create_closed_at: null,
        });
        live.add(template.resource);
      }
      await tx.query(
        "UPDATE cloud_computer_v2_heads SET next_version=$2 WHERE org_id=$1",
        [fixture.organizationId, count + 1],
      );
    });
    return result;
  }
  async function deletedWorkspace() {
    await pool.query(
      `UPDATE cloud_workspaces SET status='deleted',desired_state='deleted',deleted_at=now(),data_deleted_at=now()
       WHERE id=$1`,
      [fixture.workspaceId],
    );
  }

  async function realJournal(template: Template, bound = true) {
    const store = new DatabaseBuilderVmOperationStore(pool, accountScope);
    await withSystemTx(pool, async (tx) => {
      await lockCloudComputerOrganization(tx, fixture.organizationId);
      await prepareBuilderVmOperation(
        store,
        {
          purpose: "computer-build",
          source: { kind: "base", baseImageId: "fixture-base" },
          name: `zeros-v2-test-c6-${template.id}`,
          operationKey: key(template),
          ttlSeconds: 1800,
        },
        async () => "zeros-v2-test-base",
        tx,
      );
    });
    if (bound) {
      await store.beginCreateAttempt(key(template), randomUUID());
      await store.bind(key(template), template.resource);
      await store.state(key(template), "archived");
    }
    return store;
  }

  it("retires idempotently through B7's prepared and bound operation journal", async () => {
    const [oldest] = await templates(11);
    const store = await realJournal(oldest!);
    journal = store;
    worker = makeWorker();
    expect(await tick()).toBe(1);
    expect(await store.find(key(oldest!))).toMatchObject({
      state: "deleted",
      sandbox_id: oldest!.resource,
      deletion_operation_id: `bdop_${"a".repeat(32)}`,
    });
    expect((await state(oldest!)).state).toBe("retired");
    expect(await makeWorker().tick(fixture.organizationId)).toBe(0);
    expect(requests.filter((row) => row.method === "DELETE")).toHaveLength(1);
  });

  it("retries an uncertain deletion from B7's durable journal after a restart", async () => {
    const [oldest] = await templates(11);
    const store = await realJournal(oldest!);
    journal = store;
    worker = makeWorker();
    deleteHook = async (id) => {
      live.delete(id);
      throw new Error("lost delete response");
    };
    expect(await tick()).toBe(0);
    expect(await store.find(key(oldest!))).toMatchObject({
      state: "deleting",
      deletion_operation_id: null,
    });
    expect((await state(oldest!)).state).toBe("retiring");
    deleteHook = undefined;
    expect(await makeWorker().tick(fixture.organizationId)).toBe(1);
    expect((await store.find(key(oldest!)))?.state).toBe("deleted");
  });

  it("holds org erasure until B7 positively closes every unallocated create attempt", async () => {
    const [oldest] = await templates(1);
    const store = await realJournal(oldest!, false);
    await pool.query(
      "UPDATE cloud_computer_templates SET provider_resource_id=NULL WHERE build_id=$1",
      [oldest!.id],
    );
    const pending = () =>
      withSystemTx(pool, async (tx) => {
        await tx.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [
          fixture.organizationId,
        ]);
        return computerTemplateCleanupPending(tx, fixture.organizationId);
      });
    const attempt = randomUUID();
    await store.beginCreateAttempt(key(oldest!), attempt);
    expect(await pending()).toBe(true);
    expect(await store.closeUnallocatedCreate(key(oldest!))).toBe(false);
    expect(await pending()).toBe(true);
    await store.recordCreateRejection(key(oldest!), attempt, "limit_reached");
    expect(await store.closeUnallocatedCreate(key(oldest!))).toBe(true);
    expect(await pending()).toBe(false);
    await expect(
      store.bind(key(oldest!), oldest!.resource),
    ).rejects.toMatchObject({ code: "provider_operation_conflict" });
  });

  it("retires the eleventh ready template and is idempotent", async () => {
    const versions = await templates(11);
    expect(await tick()).toBe(1);
    expect(await state(versions[0]!)).toMatchObject({
      state: "retired",
      retired_at: expect.any(Date),
    });
    for (const template of versions.slice(1))
      expect(await state(template)).toMatchObject({
        state: "ready",
        retired_at: null,
      });
    expect(requests).toEqual([
      {
        id: versions[0]!.resource,
        method: "DELETE",
        wallet: billingOrg,
        confirm: versions[0]!.resource,
      },
      {
        id: versions[0]!.resource,
        method: "GET",
        wallet: billingOrg,
        confirm: null,
      },
    ]);
    expect(operations.get(key(versions[0]!))).toMatchObject({
      state: "deleted",
      deletion_operation_id: `bdop_${"a".repeat(32)}`,
    });
    expect(await tick()).toBe(0);
    expect(requests).toHaveLength(2);
  });

  it("keeps older active/previous/referenced versions in addition to the newest ten", async () => {
    const versions = await templates(14);
    await pool.query(
      "UPDATE cloud_computer_v2_heads SET active_build_id=$2,previous_build_id=$3 WHERE org_id=$1",
      [fixture.organizationId, versions[0]!.id, versions[1]!.id],
    );
    await source(versions[2]!);
    await pool.query(
      "UPDATE cloud_workspaces SET status='archived',desired_state='stopped' WHERE id=$1",
      [fixture.workspaceId],
    );
    await pool.query(
      "UPDATE cloud_workspace_generations SET retired_at=now() WHERE workspace_id=$1",
      [fixture.workspaceId],
    );
    expect(await tick()).toBe(1);
    expect(
      requests.filter((row) => row.method === "DELETE").map((row) => row.id),
    ).toEqual([versions[3]!.resource]);
    for (const template of versions.filter((_, index) => index !== 3))
      expect((await state(template)).state).toBe("ready");
  });

  it("retains a deleting workspace's source until both workspace and data cleanup finish", async () => {
    const [oldest] = await templates(11);
    await source(oldest!);
    await pool.query(
      "UPDATE cloud_workspaces SET status='deleted',desired_state='deleted',deleted_at=now() WHERE id=$1",
      [fixture.workspaceId],
    );
    expect(await tick()).toBe(0);
    await deletedWorkspace();
    expect(await tick()).toBe(1);
  });

  it("loses to an Activate that commits after candidate discovery", async () => {
    const [oldest] = await templates(11);
    let activated = false;
    findHook = async (_key, tx) => {
      if (tx || activated) return;
      activated = true;
      await service.activate(
        fixture.organizationId,
        fixture.userId,
        oldest!.version,
        { expectedRevision: 1, operationId: randomUUID() },
      );
    };
    expect(await tick()).toBe(0);
    expect((await state(oldest!)).state).toBe("ready");
    expect(requests).toEqual([]);
  });

  it("withdraws Activate admission as soon as a retirement claim wins", async () => {
    const [oldest] = await templates(11);
    let checked = false;
    findHook = async (_key, tx) => {
      if (tx || checked || (await state(oldest!)).state !== "retiring") return;
      checked = true;
      await expect(
        service.activate(
          fixture.organizationId,
          fixture.userId,
          oldest!.version,
          { expectedRevision: 1, operationId: randomUUID() },
        ),
      ).rejects.toMatchObject({ code: "cloud_computer_not_built" });
    };
    expect(await tick()).toBe(1);
    expect(checked).toBe(true);
  });

  it("loses to a fork source that commits after candidate discovery", async () => {
    const [oldest] = await templates(11);
    let pinned = false;
    findHook = async (_key, tx) => {
      if (tx || pinned) return;
      pinned = true;
      await source(oldest!);
    };
    expect(await tick()).toBe(0);
    expect((await state(oldest!)).state).toBe("ready");
    expect(requests).toEqual([]);
  });

  it("rechecks a fork reference added after the retirement claim before dispatch", async () => {
    const [oldest] = await templates(11);
    let pinned = false;
    findHook = async (_key, tx) => {
      if (tx || pinned || (await state(oldest!)).state !== "retiring") return;
      pinned = true;
      // Force late metadata to test the recheck independently of C5 admission.
      await source(oldest!);
    };
    expect(await tick()).toBe(0);
    expect((await state(oldest!)).state).toBe("ready");
    expect(operations.get(key(oldest!))!.state).toBe("archived");
    expect(requests).toEqual([]);
  });

  it("rechecks references in the final transaction before publishing retired", async () => {
    const [oldest] = await templates(11);
    const persist = journal.state;
    journal.state = async (operationKey, value) => {
      await persist(operationKey, value);
      if (value === "deleted") await source(oldest!);
    };
    // C5 rejects this late acceptance; injecting its metadata directly also
    // proves the final transaction never publishes a referenced retirement.
    expect(await tick()).toBe(0);
    expect(await state(oldest!)).toMatchObject({
      state: "retiring",
      retired_at: null,
    });
    expect(operations.get(key(oldest!))!.state).toBe("deleted");
  });

  it("accepts Boat DELETE 404 as already gone", async () => {
    const [oldest] = await templates(11);
    live.delete(oldest!.resource);
    expect(await tick()).toBe(1);
    expect(operations.get(key(oldest!))).toMatchObject({
      state: "deleted",
      deletion_operation_id: null,
    });
    expect(requests.map((row) => row.method)).toEqual(["DELETE"]);
  });

  it("retains an uncertain delete and retries the same identity after a lost reply", async () => {
    const [oldest] = await templates(11);
    deleteHook = async (id) => {
      live.delete(id);
      throw new Error("private provider failure");
    };
    expect(await tick()).toBe(0);
    expect(await state(oldest!)).toMatchObject({
      state: "retiring",
      retired_at: null,
    });
    expect(operations.get(key(oldest!))).toMatchObject({
      state: "deleting",
      deletion_operation_id: null,
    });
    expect(warnings).toHaveBeenCalledWith(
      "[computer-template-retention] cleanup unconfirmed; will retry",
    );
    deleteHook = undefined;
    expect(await tick()).toBe(1);
    expect(
      requests.filter((row) => row.method === "DELETE").map((row) => row.id),
    ).toEqual([oldest!.resource, oldest!.resource]);
  });

  it("persists the deletion operation before rechecking a still-visible sandbox", async () => {
    const [oldest] = await templates(11);
    deleteHook = async (id) =>
      Response.json({
        ok: true,
        operation: {
          id: `bdop_${"b".repeat(32)}`,
          kind: "sandbox",
          targetId: id,
          status: "processing",
        },
      });
    expect(await tick()).toBe(0);
    expect(await state(oldest!)).toMatchObject({
      state: "retiring",
      retired_at: null,
    });
    expect(operations.get(key(oldest!))!.deletion_operation_id).toBe(
      `bdop_${"b".repeat(32)}`,
    );
    live.delete(oldest!.resource);
    expect(await tick()).toBe(1);
    expect(requests.filter((row) => row.method === "DELETE")).toHaveLength(1);
  });

  it("does not accept a deletion receipt for another sandbox", async () => {
    const [oldest] = await templates(11);
    deleteHook = async () =>
      Response.json({
        ok: true,
        operation: {
          id: `bdop_${"b".repeat(32)}`,
          kind: "sandbox",
          targetId: "bx_22222222",
        },
      });
    expect(await tick()).toBe(0);
    expect(await state(oldest!)).toMatchObject({
      state: "retiring",
      retired_at: null,
    });
    expect(operations.get(key(oldest!))!.deletion_operation_id).toBeNull();
  });

  it.each(["account", "wallet", "resource", "purpose", "journal"])(
    "refuses mismatched %s identity",
    async (mismatch) => {
      const [oldest] = await templates(11);
      if (mismatch === "account" || mismatch === "wallet")
        await pool.query(
          `UPDATE cloud_computer_templates SET ${mismatch === "account" ? "account_scope" : "billing_org"}=$2 WHERE build_id=$1`,
          [
            oldest!.id,
            mismatch === "account"
              ? "other-account"
              : "team_00000000-0000-0000-0000-000000000002",
          ],
        );
      else if (mismatch === "resource")
        operations.get(key(oldest!))!.sandbox_id = "bx_22222222";
      else if (mismatch === "purpose")
        operations.get(key(oldest!))!.purpose = "runtime-qualification";
      else operations.delete(key(oldest!));
      expect(await tick()).toBe(0);
      expect((await state(oldest!)).state).toBe("ready");
      expect(requests).toEqual([]);
    },
  );

  it("fences an old claim when another process completes the same retirement", async () => {
    const [oldest] = await templates(11);
    const other = makeWorker();
    let raced = false;
    findHook = async (_key, tx) => {
      if (tx || raced || (await state(oldest!)).state !== "retiring") return;
      raced = true;
      expect(await other.tick(fixture.organizationId)).toBe(1);
    };
    expect(await tick()).toBe(0);
    expect(raced).toBe(true);
    expect((await state(oldest!)).state).toBe("retired");
    expect(requests.filter((row) => row.method === "DELETE")).toHaveLength(1);
  });

  it("finishes after a crash between journal confirmation and the retired CAS", async () => {
    const [oldest] = await templates(11);
    const persist = journal.state;
    journal.state = async (operationKey, value) => {
      await persist(operationKey, value);
      if (value === "deleted") throw new Error("lost database reply");
    };
    expect(await tick()).toBe(0);
    expect((await state(oldest!)).state).toBe("retiring");
    journal.state = persist;
    expect(await tick()).toBe(1);
    expect(requests.filter((row) => row.method === "DELETE")).toHaveLength(1);
  });

  it("erasure releases active/previous/newest holds while preserving unfinished workspace cleanup", async () => {
    const versions = await templates(2);
    await source(versions[0]!);
    await pool.query(
      "UPDATE cloud_computer_v2_heads SET active_build_id=$2,previous_build_id=$3 WHERE org_id=$1",
      [fixture.organizationId, versions[1]!.id, versions[0]!.id],
    );
    await pool.query(
      "UPDATE organizations SET lifecycle_status='purging' WHERE id=$1",
      [fixture.organizationId],
    );
    expect(await tick()).toBe(1);
    expect((await state(versions[0]!)).state).toBe("ready");
    expect((await state(versions[1]!)).state).toBe("retired");
    await deletedWorkspace();
    expect(await tick()).toBe(1);
    expect(operations.get(key(versions[0]!))!.state).toBe("deleted");
  });

  it("preserves retired history for Rebuild and rejects Activate", async () => {
    const [oldest] = await templates(11);
    expect(await tick()).toBe(1);
    expect(
      (
        await service.read(fixture.organizationId, fixture.userId)
      ).history.builds.find((row) => row.id === oldest!.id),
    ).toMatchObject({ state: "succeeded", templateState: "retired" });
    await expect(
      service.activate(
        fixture.organizationId,
        fixture.userId,
        oldest!.version,
        { expectedRevision: 1, operationId: randomUUID() },
      ),
    ).rejects.toMatchObject({ code: "cloud_computer_not_built" });
    expect(
      await service.rebuild(
        fixture.organizationId,
        fixture.userId,
        oldest!.version,
        { expectedRevision: 1, operationId: randomUUID() },
      ),
    ).toMatchObject({
      build: { version: 12, state: "queued", rebuiltFromBuildId: oldest!.id },
    });
  });

  it("notifies retention after explicit and automatic activation commit", async () => {
    const [oldest] = await templates(11);
    const listener = await pool.connect();
    await listener.query(`LISTEN ${COMPUTER_TEMPLATE_RETENTION_CHANNEL}`);
    const notified = async (activate: () => Promise<unknown>) => {
      let handler: (notice: pg.Notification) => void;
      let timer: ReturnType<typeof setTimeout>;
      const notice = new Promise<pg.Notification>((resolve, reject) => {
        handler = resolve;
        listener.once("notification", handler);
        timer = setTimeout(
          () => reject(new Error("Activation did not notify retention")),
          2000,
        );
      });
      try {
        await activate();
        expect(await notice).toMatchObject({
          channel: COMPUTER_TEMPLATE_RETENTION_CHANNEL,
          payload: fixture.organizationId,
        });
      } finally {
        clearTimeout(timer!);
        listener.removeListener("notification", handler!);
      }
    };
    try {
      await notified(() =>
        service.activate(
          fixture.organizationId,
          fixture.userId,
          oldest!.version,
          { expectedRevision: 1, operationId: randomUUID() },
        ),
      );
      const queued = await service.build(
        fixture.organizationId,
        fixture.userId,
        { expectedRevision: 2, operationId: randomUUID() },
      );
      await service.claimNextBuild(1);
      const pins = {
        baseImageId: "fixture-base",
        runtimeId: "fixture-runtime",
        repositoryManifest: [],
      };
      await service.markBuildStage(
        queued.build.id,
        1,
        "capture_confirmed",
        pins,
      );
      await notified(() =>
        service.completeBuild(queued.build.id, 1, {
          ...pins,
          template: {
            providerResourceId: null,
            accountScope: null,
            billingOrg: null,
            protectedContractDigest: "f".repeat(64),
            stoppedAt: new Date().toISOString(),
          },
        }),
      );
    } finally {
      await listener.query(`UNLISTEN ${COMPUTER_TEMPLATE_RETENTION_CHANNEL}`);
      listener.release();
    }
  });
});
