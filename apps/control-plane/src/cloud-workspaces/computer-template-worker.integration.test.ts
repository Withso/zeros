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
import { resetMigratedTestDatabase } from "../test-database.js";
import { withSystemTx } from "../db.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";
import { DatabaseCloudComputerV2Service } from "./computer-v2.js";
import type { CloudComputerV2Repository } from "./computer-v2-contract.js";
import { ComputerTemplateWorker, type ComputerTemplateWorkerDependencies } from "./computer-template-worker.js";
import { sanitizeComputerTemplateLog } from "./computer-template-logs.js";
import type {
  CloudBuilderVms,
  BuilderVm,
  ComputerTemplateRuntime,
} from "./computer-template-boat.js";
import { seedComputerTemplateRuntime, seedComputerTemplateRuntimeImage } from "./computer-template-test-fixtures.js";
import { builderFixture, memoryBuilderOperations } from "./cloud-builder-vm-test-fixtures.js";
import { BuilderVmError } from "./cloud-builder-vm.js";
import { ComputerTemplateSnapshots } from "./computer-template-snapshots.js";
import type { ComputerNamedSnapshot } from "./computer-template-snapshot-boat.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const runtime: ComputerTemplateRuntime = {
  baseImageId: "zeros-v2-test-base",
  baseCompatibilityId: `bc1-${"b".repeat(64)}`,
  objectKey: "fixture-runtime-object",
  descriptor: {
    runtimeId: `r1-${"a".repeat(64)}`,
    manifestSha256: "a".repeat(64),
    archiveSha256: "c".repeat(64),
    archiveBytes: 123,
    expandedBytes: 456,
    sourceCommit: "d".repeat(40),
    nodeModulesAbi: 127,
    bootstrapProtocolVersion: 1,
    engineProtocolVersion: 20,
  },
};
const tcb = "e".repeat(64);
const diagnostic = (stage: string, component = "build", ok = true) => ({
  schema: "zeros.diagnostic/v1",
  component,
  stage,
  ok,
  exitCode: ok ? 0 : 1,
  timedOut: false,
  failedChecks: ok ? [] : ["tcb_modified"],
});

database("Cloud Computer template worker", () => {
  let pool: pg.Pool, service: DatabaseCloudComputerV2Service;
  let fixture: Awaited<ReturnType<typeof seedReadyCloudWorkspace>>;
  let vm: CloudBuilderVms,
    github: {
      mintContentsRead: ReturnType<typeof vi.fn>;
      revoke: ReturnType<typeof vi.fn>;
    };
  let worker: ComputerTemplateWorker;
  let workerOptions: ComputerTemplateWorkerDependencies;
  let presignGet: ReturnType<typeof vi.fn>;
  let create: ReturnType<typeof vi.fn>,
    runFixed: ReturnType<typeof vi.fn>,
    remove: ReturnType<typeof vi.fn>;
  let selectRuntime: ReturnType<typeof vi.fn>,
    loadRuntime: ReturnType<typeof vi.fn>,
    validateRuntime: ReturnType<typeof vi.fn>;
  let installCode: number,
    modified: boolean,
    pollHook: (() => Promise<void>) | null;
  let inputs: Array<{ command: string; value: Record<string, any> }>;
  let operations: ReturnType<typeof memoryBuilderOperations>;
  const recordOperation = async (
    input: Parameters<CloudBuilderVms["create"]>[0],
    sandboxId: string | null,
    dispatched = true,
  ) => {
    if (dispatched) await operations.beginCreateAttempt(input.operationKey, randomUUID());
    if (sandboxId) await operations.bind(input.operationKey, sandboxId);
    return operations.find(input.operationKey);
  };

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
    await seedComputerTemplateRuntime(pool);
    fixture = await seedReadyCloudWorkspace(pool, { runtimeV4: false });
    service = new DatabaseCloudComputerV2Service(
      pool,
      {
        settingsSecretKeyV1: randomBytes(32).toString("base64url"),
      } as CloudWorkspaceBackendConfig,
      { sanitizeLog: sanitizeComputerTemplateLog },
    );
    installCode = 0;
    modified = false;
    pollHook = null;
    inputs = [];
    operations = memoryBuilderOperations();
    vi.spyOn(operations, "closeUnallocatedCreate");
    selectRuntime = vi.fn(async () => runtime);
    loadRuntime = vi.fn(async () => runtime);
    validateRuntime = vi.fn(async () => true);
    create = vi.fn(async (input) => {
      const pin = (
        await pool.query(
          "SELECT base_image_id,runtime_id FROM cloud_computer_v2_builds WHERE state='running'",
        )
      ).rows[0];
      expect(pin).toMatchObject({
        base_image_id: runtime.baseImageId,
        runtime_id: runtime.descriptor.runtimeId,
      });
      await recordOperation(input, "bx_23456789");
      return {
        sandboxId: "bx_23456789",
        purpose: input.purpose,
        operationKey: input.operationKey,
      } as BuilderVm;
    });
    remove = vi.fn(async () => {});
    runFixed = vi.fn(async (_vm, command, input) => {
      const value = input
        ? JSON.parse(
            command === "install-runtime"
              ? Buffer.from(input.toString(), "base64url").toString()
              : input.toString(),
          )
        : {};
      inputs.push({ command, value });
      let result: unknown = null,
        stage = "done",
        component = "build";
      if (command === "install-runtime") {
        component = "installer";
      } else if (command === "runtime-self-test") {
        component = "qualification";
        stage = "self_test";
      } else if (command === "computer:clone-repos") {
        stage = "repositories";
        result = {
          schema: "zeros.computer-repositories/v1",
          buildId: value.buildId,
          repositories: value.repositories.map((repo) => ({
            id: repo.id,
            owner: repo.owner,
            name: repo.name,
            sha: "f".repeat(40),
          })),
        };
      } else if (command === "computer:run-install") {
        stage = "install";
        if (value.action === "poll" && pollHook) {
          const hook = pollHook;
          pollHook = null;
          await hook();
        }
        result = {
          schema: "zeros.computer-install/v1",
          buildId: value.buildId,
          workerFence: value.workerFence,
          state:
            value.action === "start"
              ? "running"
              : installCode === 0
                ? "succeeded"
                : "failed",
          exitCode: value.action === "start" ? null : installCode,
          timedOut: false,
          chunks:
            value.action === "start"
              ? []
              : [{ seq: 1, stream: "stdout", text: "package installed\n" }],
          nextAfter: value.action === "start" ? 0 : 1,
          truncated: false,
        };
      } else if (command === "computer:verify-tcb") {
        stage = "integrity";
        if (modified && value.action === "verify")
          return {
            exitCode: 1,
            stdout: "untrusted failure text",
            diagnostic: diagnostic(stage, "build", false),
          };
        result = {
          schema: "zeros.computer-tcb/v1",
          buildId: value.buildId,
          baseCompatibilityId: runtime.baseCompatibilityId,
          runtimeId: runtime.descriptor.runtimeId,
          protectedContractDigest: tcb,
        };
      } else if (command === "computer:sanitize") {
        stage = "sanitation";
        result = {
          schema: "zeros.computer-sanitation/v1",
          buildId: value.manifest.buildId,
          clean: true,
          manifestSha256: value.manifestSha256,
        };
      }
      return {
        exitCode: 0,
        stdout: result ? JSON.stringify(result) : "",
        diagnostic: diagnostic(stage, component),
      };
    });
    vm = {
      create,
      runFixed,
      delete: remove,
      stop: vi.fn(async () => ({ archived: true as const })),
      baseStatus: vi.fn(async () => ({
        schema: "zeros.base-status/v1",
        baseCompatibilityId: runtime.baseCompatibilityId,
        currentRuntimeId: null,
        bootId: randomUUID(),
        hostState: "idle" as const,
      })),
      waitForBase: vi.fn(async value => vm.baseStatus(value)),
    };
    github = {
      mintContentsRead: vi.fn(async () => ({
        token: "synthetic-clone-credential",
        expiresAtMs: Date.now() + 3_600_000,
      })),
      revoke: vi.fn(async () => {}),
    };
    presignGet = vi.fn(async () => ({
      url: "https://artifacts.example.test/runtime?signature=fixture",
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    }));
    workerOptions = {
      pool,
      service,
      vms: vm,
      operations,
      github,
      accountScope: "fixture-account",
      billingOrg: "fixture-wallet",
      runtime: { select: selectRuntime, load: loadRuntime, validate: validateRuntime },
      artifacts: { presignGet },
      snapshots: new ComputerTemplateSnapshots(pool, { channel: "alpha", accountScope: "fixture-account", billingOrg: "fixture-wallet", pollMs: 0,
        provider: (() => {
          const names = new Map<string, ComputerNamedSnapshot>();
          return {
            assertStopped: vi.fn(async () => {}),
            get: vi.fn(async (name: string) => names.get(name) ?? null),
            save: vi.fn(async (sourceSandboxId: string, name: string) => { names.set(name, { name, sourceSandboxId,
              status: "ready", snapshotId: `capture_${name}`, sizeBytes: 4096 }); }),
            prove: vi.fn(async (value) => ({ schema: "zeros.computer-saved-tree/v1" as const, snapshotId: value.snapshotId,
              sourceSandboxId: value.sourceSandboxId, treeSha256: "a".repeat(64), entryCount: 1 })),
            remove: vi.fn(async (value) => { names.delete(value.name); return true; }),
          };
        })(),
      }),
      pollMs: 0,
      namePrefix: "zeros-v2-test-computer",
    };
    worker = new ComputerTemplateWorker(workerOptions);
  });
  const request = (
    draft: { repositories: CloudComputerV2Repository[]; installScript: string; timeoutSeconds: number } =
      { repositories: [], installScript: "true", timeoutSeconds: 900 },
  ) =>
    service.build(fixture.organizationId, fixture.userId, {
      expectedRevision: 0,
      operationId: randomUUID(),
      draft,
    });
  const read = () => service.read(fixture.organizationId, fixture.userId);
  const buildRow = async () => (await pool.query(`SELECT id,state,stage,error_code,config_id,base_image_id,runtime_id,
    started_at,deadline_at,worker_fence,helper_fence,handoff_at,install_started,install_log_after,install_log_discard_streams
    FROM cloud_computer_v2_builds`)).rows[0];
  const barrier = () => {
    let reached!: () => void, release!: () => void;
    const waiting = new Promise<void>(resolve => { reached = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    return { waiting, release, hold: async () => { reached(); await released; } };
  };

  it("hands an in-flight install to the next worker on shutdown without failing or rerunning the recipe", async () => {
    const build = await request({ repositories: [], installScript: "", timeoutSeconds: 900 });
    let reached!: () => void, resume!: () => void;
    const atPoll = new Promise<void>(resolve => { reached = resolve; });
    const releasePoll = new Promise<void>(resolve => { resume = resolve; });
    pollHook = async () => { reached(); await releasePoll; };
    const stop = worker.start();
    try {
      await atPoll;
      // A second worker cannot adopt an active predecessor or allocate again.
      await new ComputerTemplateWorker(workerOptions).tick();
      expect(create).toHaveBeenCalledOnce();
      const stopping = stop();
      resume();
      await stopping;
      const paused = (await read()).latestBuild!;
      expect(["queued", "running"]).toContain(paused.state);
      expect(paused.errorCode).toBeNull();
      expect(remove).not.toHaveBeenCalled();

      // The production scheduler must see the persistent handoff immediately,
      // even though its capacity slot is still occupied.
      const completion = barrier();
      const complete = service.completeBuild.bind(service);
      vi.spyOn(service, "completeBuild").mockImplementation(async (...args) => {
        const value = await complete(...args);
        await completion.hold();
        return value;
      });
      const successorStop = new ComputerTemplateWorker(workerOptions).start();
      try { await completion.waiting; }
      finally { completion.release(); await successorStop(); }
      expect((await read()).active?.id).toBe(build.build.id);
      expect(create).toHaveBeenCalledOnce();
      expect(remove).not.toHaveBeenCalled();
      expect(inputs.filter(({ command }) => command === "computer:clone-repos")).toHaveLength(1);
      expect(inputs.filter(({ command, value }) => command === "computer:verify-tcb" && value.action === "baseline")).toHaveLength(1);
      // Frozen base helpers key their durable install marker by these two
      // values. A handoff cannot change that key and run the script again.
      const starts = inputs.filter(({ command, value }) => command === "computer:run-install" && value.action === "start");
      expect(starts.length).toBeGreaterThan(0);
      expect(new Set(starts.map(({ value }) => JSON.stringify([value.buildId, value.workerFence]))).size).toBe(1);
    } finally {
      resume();
      await stop();
    }
  });

  it.each([
    ["allocation", "runtime"], ["runtime install", "repositories"], ["clone", "install"],
    ["integrity", "sanitation"], ["sanitation", "stopping"], ["stop", "stopping"], ["capture", "capture_confirmed"],
  ])("hands off after verified %s without repeating completed steps", async (boundary, stage) => {
    const repo = await repository();
    const build = await request({ repositories: [repo], installScript: "true", timeoutSeconds: 900 });
    const gate = barrier();
    const originalCreate = create.getMockImplementation()!;
    const originalFixed = runFixed.getMockImplementation()!;
    const originalStop = vm.stop;
    const originalCapture = workerOptions.snapshots.capture.bind(workerOptions.snapshots);
    create.mockImplementation(async input => {
      const value = await originalCreate(input);
      if (boundary === "allocation") await gate.hold();
      return value;
    });
    runFixed.mockImplementation(async (target, command, input) => {
      const value = await originalFixed(target, command, input);
      if ((boundary === "runtime install" && command === "install-runtime") ||
        (boundary === "clone" && command === "computer:clone-repos") ||
        (boundary === "sanitation" && command === "computer:sanitize") ||
        (boundary === "integrity" && command === "computer:verify-tcb" && JSON.parse(input.toString()).action === "verify"))
        await gate.hold();
      return value;
    });
    vm.stop = vi.fn(async (...args) => {
      const value = await originalStop(...args);
      if (boundary === "stop") await gate.hold();
      return value;
    });
    const capture = vi.spyOn(workerOptions.snapshots, "capture").mockImplementation(async input => {
      const value = await originalCapture(input);
      if (boundary === "capture") await gate.hold();
      return value;
    });
    const stop = worker.start();
    try {
      await gate.waiting;
      const original = await buildRow();
      const stopping = stop();
      gate.release();
      await stopping;
      expect(await buildRow()).toMatchObject({ state: "running", stage, handoff_at: expect.any(Date),
        helper_fence: original.helper_fence, started_at: original.started_at, deadline_at: original.deadline_at });
      if (["clone", "integrity", "sanitation", "stop", "capture"].includes(boundary)) expect(github.revoke).toHaveBeenCalledOnce();
      // N-1 knows only the queued claim. Even a stopped handed-off builder is
      // invisible to it, and stale CP writes cannot revoke a successor.
      expect(await service.claimNextBuild(Number(original.worker_fence) + 10)).toBeNull();
      expect(await service.markBuildStage(build.build.id, Number(original.worker_fence), "capture_confirmed")).toMatchObject({ applied: false });
      expect(await service.failBuild(build.build.id, Number(original.worker_fence), "build_failed")).toMatchObject({ applied: false });
      expect(await service.appendBuildLog(build.build.id, Number(original.worker_fence), { stage: "install", stream: "stdout", text: "stale" })).toMatchObject({ applied: false });
      await Promise.all([new ComputerTemplateWorker(workerOptions).tick(), new ComputerTemplateWorker(workerOptions).tick()]);
      expect((await read()).active?.id).toBe(build.build.id);
      expect(create).toHaveBeenCalledOnce();
      for (const command of ["install-runtime", "computer:clone-repos", "runtime-self-test", "computer:sanitize"])
        expect(inputs.filter(input => input.command === command)).toHaveLength(1);
      expect(inputs.filter(input => input.command === "computer:verify-tcb")).toHaveLength(2);
      expect(vm.stop).toHaveBeenCalledOnce();
      expect(capture).toHaveBeenCalledOnce();
      expect(github.mintContentsRead).toHaveBeenCalledOnce();
      expect(github.revoke).toHaveBeenCalledOnce();
      expect(remove).not.toHaveBeenCalled();
      expect(selectRuntime).toHaveBeenCalledOnce();
      expect(loadRuntime).toHaveBeenCalledWith(expect.anything(), { baseImageId: runtime.baseImageId, runtimeId: runtime.descriptor.runtimeId });
      const completed = await buildRow();
      expect(completed).toMatchObject({ helper_fence: original.helper_fence, started_at: original.started_at, deadline_at: original.deadline_at });
      expect(Number(completed.worker_fence)).toBeGreaterThan(Number(original.worker_fence));
      expect(new Set(inputs.filter(input => input.value.workerFence).map(input => input.value.workerFence))).toEqual(new Set([Number(original.helper_fence)]));
    } finally {
      gate.release();
      await stop();
    }
  });

  it("preserves the install cursor across repeated handoffs without persisting or exposing split secret tails", async () => {
    const repo = await repository();
    const build = await request({ repositories: [repo], installScript: "true", timeoutSeconds: 900 });
    const gates = [barrier(), barrier()];
    const original = runFixed.getMockImplementation()!;
    let page = 0;
    runFixed.mockImplementation(async (target, command, input) => {
      const output = await original(target, command, input);
      if (command !== "computer:run-install") return output;
      const value = JSON.parse(output.stdout);
      const pages = [
        [{ seq: 1, stream: "stdout", text: "first\nsynthetic-clone-cre" }],
        [{ seq: 2, stream: "stdout", text: "dential\nsecond\n" }, { seq: 3, stream: "stderr", text: "Authorization: Bearer synthetic" }],
        [{ seq: 4, stream: "stderr", text: "-tail\nthird\n" }],
      ];
      const current = page++;
      Object.assign(value, { state: current < 2 ? "running" : "succeeded", exitCode: current < 2 ? null : 0,
        chunks: pages[current], nextAfter: [1, 3, 4][current] });
      if (gates[current]) await gates[current]!.hold();
      return { ...output, stdout: JSON.stringify(value) };
    });
    for (const [index, gate] of gates.entries()) {
      const stop = new ComputerTemplateWorker(workerOptions).start();
      try {
        await gate.waiting;
        const stopping = stop();
        gate.release();
        await stopping;
        expect(await buildRow()).toMatchObject({ state: "running", stage: "install", install_started: true,
          install_log_after: String([1, 3][index]), install_log_discard_streams: [["stdout"], ["stderr"]][index] });
      } finally {
        gate.release();
        await stop();
      }
    }
    await new ComputerTemplateWorker(workerOptions).tick();
    expect((await read()).active?.id).toBe(build.build.id);
    const calls = inputs.filter(input => input.command === "computer:run-install").map(input => input.value);
    expect(calls.map(call => [call.action, call.after])).toEqual([["start", 0], ["poll", 1], ["poll", 3]]);
    expect(new Set(calls.map(call => call.workerFence)).size).toBe(1);
    const logs = await service.logs(fixture.organizationId, fixture.userId, build.build.id);
    expect(logs.entries.map(entry => entry.text).join("")).toBe("first\n\nsecond\n\nthird\n");
    expect(create).toHaveBeenCalledOnce();
    expect(github.revoke).toHaveBeenCalledOnce();
  });

  it.each(["failure", "cancellation", "deadline"])("does not turn %s during shutdown into an adoptable build", async reason => {
    const build = await request();
    const gate = barrier();
    pollHook = gate.hold;
    if (reason === "failure") installCode = 1;
    const stop = worker.start();
    try {
      await gate.waiting;
      const stopping = stop();
      if (reason === "cancellation") await service.cancel(fixture.organizationId, fixture.userId, build.build.id, { expectedRevision: build.revision });
      if (reason === "deadline") await pool.query("UPDATE cloud_computer_v2_builds SET deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1", [build.build.id]);
      gate.release();
      await stopping;
      expect(await buildRow()).toMatchObject({ state: reason === "cancellation" ? "cancelled" : "failed", handoff_at: null,
        error_code: reason === "cancellation" ? null : reason === "deadline" ? "build_timeout" : "install_failed" });
      expect(remove).toHaveBeenCalledOnce();
      await new ComputerTemplateWorker(workerOptions).tick();
      expect(loadRuntime).not.toHaveBeenCalled();
      expect(create).toHaveBeenCalledOnce();
    } finally {
      gate.release();
      await stop();
    }
  });

  it("leaves an unacknowledged handoff on its original deadline when the database is unavailable", async () => {
    await request();
    const gate = barrier();
    pollHook = gate.hold;
    vi.spyOn(service, "handoffBuild").mockRejectedValueOnce(new Error("synthetic database outage"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const stop = worker.start();
    try {
      await gate.waiting;
      const original = await buildRow();
      const stopping = stop();
      gate.release();
      await stopping;
      expect(await buildRow()).toMatchObject({ state: "running", handoff_at: null, deadline_at: original.deadline_at });
      await new ComputerTemplateWorker(workerOptions).tick();
      expect(loadRuntime).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
      await pool.query("UPDATE cloud_computer_v2_builds SET deadline_at=clock_timestamp()-interval '1 second'");
      await new ComputerTemplateWorker(workerOptions).tick();
      expect(await buildRow()).toMatchObject({ state: "failed", error_code: "build_timeout" });
      expect(remove).toHaveBeenCalledOnce();
    } finally {
      gate.release();
      await stop();
      log.mockRestore();
    }
  });

  it("adopts a committed handoff after the predecessor loses its commit reply", async () => {
    const build = await request();
    const gate = barrier();
    pollHook = gate.hold;
    const handoff = service.handoffBuild.bind(service);
    vi.spyOn(service, "handoffBuild").mockImplementationOnce(async (...args) => {
      expect(await handoff(...args)).toBe(true);
      throw new Error("synthetic lost commit reply");
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const stop = worker.start();
    try {
      await gate.waiting;
      const stopping = stop();
      gate.release();
      await stopping;
      expect(await buildRow()).toMatchObject({ state: "running", handoff_at: expect.any(Date) });
      await new ComputerTemplateWorker(workerOptions).tick();
      expect((await read()).active?.id).toBe(build.build.id);
      expect(create).toHaveBeenCalledOnce();
      expect(remove).not.toHaveBeenCalled();
    } finally {
      gate.release();
      await stop();
      log.mockRestore();
    }
  });

  it("never adopts an uncheckpointed clone and cleans it only after its original deadline", async () => {
    await request();
    const gate = barrier();
    const original = runFixed.getMockImplementation()!;
    runFixed.mockImplementation(async (...args) => {
      const output = await original(...args);
      if (args[1] === "computer:clone-repos") await gate.hold();
      return output;
    });
    const running = worker.tick();
    try {
      await gate.waiting;
      expect(await buildRow()).toMatchObject({ stage: "repositories", handoff_at: null });
      await new ComputerTemplateWorker(workerOptions).tick();
      expect(create).toHaveBeenCalledOnce();
      expect(loadRuntime).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
      await pool.query("UPDATE cloud_computer_v2_builds SET deadline_at=clock_timestamp()-interval '1 second'");
      await new ComputerTemplateWorker(workerOptions).tick();
      expect(await buildRow()).toMatchObject({ state: "failed", error_code: "build_timeout" });
      expect(remove).toHaveBeenCalledOnce();
    } finally {
      gate.release();
      await running;
    }
    expect(inputs.filter(input => input.command === "computer:clone-repos")).toHaveLength(1);
    expect(inputs.some(input => input.command === "computer:run-install")).toBe(false);
  });

  it("refuses a changed protected contract after handoff without taking a new baseline", async () => {
    await request();
    const gate = barrier();
    pollHook = gate.hold;
    const stop = worker.start();
    try {
      await gate.waiting;
      const stopping = stop();
      gate.release();
      await stopping;
      modified = true;
      await new ComputerTemplateWorker(workerOptions).tick();
      expect(await buildRow()).toMatchObject({ state: "failed", error_code: "tcb_modified" });
      expect((await read()).active).toBeNull();
      expect(remove).toHaveBeenCalledOnce();
      expect(inputs.filter(input => input.command === "computer:verify-tcb" && input.value.action === "baseline")).toHaveLength(1);
      expect(inputs.some(input => input.command === "computer:sanitize")).toBe(false);
    } finally {
      gate.release();
      await stop();
    }
  });

  const imageRow = async (imageId: string) => withSystemTx(pool, async tx => (await tx.query(
    "SELECT state,diagnostic FROM cloud_runtime_images WHERE image_id=$1", [imageId],
  )).rows[0]);
  async function enableImage() {
    workerOptions.runtimeImageChannel = "alpha";
    vi.mocked(vm.baseStatus).mockImplementation(async () => ({
      schema: "zeros.base-status/v1", baseCompatibilityId: runtime.baseCompatibilityId,
      currentRuntimeId: runtime.descriptor.runtimeId, bootId: randomUUID(), hostState: "idle",
    }));
    return seedComputerTemplateRuntimeImage(pool);
  }
  async function repository() {
    const installationId = randomUUID();
    await withSystemTx(pool, async (tx) => {
      await tx.query(
        "INSERT INTO github_authorizations(owner_user_id,app_variant,github_login) VALUES($1,'github.com','fixture-user')",
        [fixture.userId],
      );
      await tx.query(
        `INSERT INTO github_installations(id,github_installation_id,app_variant,owner_user_id,account_login,account_type,target_type)
        VALUES($1,123,'github.com',$2,'fixture','Organization','Organization')`,
        [installationId, fixture.userId],
      );
      await tx.query(
        "INSERT INTO cloud_github_connections(org_id,owner_user_id,installation_id) VALUES($1,$2,$3)",
        [fixture.organizationId, fixture.userId, installationId],
      );
      await tx.query(
        `INSERT INTO cloud_github_source_access(org_id,owner_user_id,installation_id,repository_owner,repository_name,forge_repository_id,actor_fingerprint,expires_at)
        VALUES($1,$2,$3,'fixture','repo','456',cloud_github_actor_fingerprint($1,$2),now()+interval '10 minutes')`,
        [fixture.organizationId, fixture.userId, installationId],
      );
    });
    return {
      id: "456",
      owner: "fixture",
      name: "repo",
      installationId,
      requestedRef: null,
    };
  }

  it("does not publish or activate when the named saved-artifact proof fails", async () => {
    const capture = vi.fn(async () => { throw new Error("synthetic named proof failure"); });
    Object.assign(workerOptions, { snapshots: { capture, reconcile: vi.fn(async () => 0) } });
    const complete = vi.spyOn(service, "completeBuild");
    await request();
    await worker.tick();
    expect(capture).toHaveBeenCalledOnce();
    expect(complete).not.toHaveBeenCalled();
    expect((await read()).active).toBeNull();
    expect((await read()).latestBuild).toMatchObject({ state: "failed", errorCode: "template_capture_failed" });
    expect(vm.stop).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ requireSnapshot: true }));
  });

  it("pins before allocation, installs with build purpose, publishes an archived template and auto-activates", async () => {
    const build = await request();
    await worker.tick();
    expect((await read()).active?.id).toBe(build.build.id);
    expect(inputs[0]).toMatchObject({
      command: "install-runtime",
      value: { purpose: "build", runtime: runtime.descriptor },
    });
    expect(
      inputs.some(({ value }) => "environment" in value || "setup" in value),
    ).toBe(false);
    expect(
      (
        await pool.query(
          "SELECT state,image_ref,protected_contract_digest FROM cloud_computer_templates",
        )
      ).rows[0],
    ).toMatchObject({
      state: "ready",
      image_ref: "boat-template:bx_23456789",
      protected_contract_digest: Buffer.from(tcb, "hex"),
    });
    expect(vm.stop).toHaveBeenCalledTimes(1);
    // Boat can take well over ten minutes to save a builder's disk. Capture
    // waits for the build's own deadline, minus a minute to complete it.
    const [, stopOptions] = vi.mocked(vm.stop).mock.calls[0]!;
    expect(stopOptions).toMatchObject({ requireSnapshot: true });
    const deadline = Date.parse((await pool.query("SELECT deadline_at FROM cloud_computer_v2_builds")).rows[0].deadline_at);
    expect(stopOptions!.timeoutMs).toBeGreaterThan(20 * 60_000);
    expect(stopOptions!.timeoutMs).toBeLessThanOrEqual(deadline - Date.now() - 55_000);
    expect(remove).not.toHaveBeenCalled();
    expect(validateRuntime).toHaveBeenCalled();
    expect(
      (
        await service.logs(
          fixture.organizationId,
          fixture.userId,
          build.build.id,
          { after: 0 },
        )
      ).entries
        .map((entry) => entry.text)
        .join(""),
    ).toContain("package installed");
  });

  it("builds from a pinned runtime image without an artifact or install while retaining the full verification pipeline", async () => {
    const image = await enableImage();
    const requested = await request();
    await worker.tick();
    expect((await read()).active?.id).toBe(requested.build.id);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ source: { kind: "image", imageId: image.imageId } }));
    expect(presignGet).not.toHaveBeenCalled();
    expect(inputs.map(input => input.command)).toEqual([
      "computer:verify-tcb", "computer:clone-repos", "computer:run-install", "computer:run-install",
      "computer:verify-tcb", "runtime-self-test", "computer:sanitize",
    ]);
    expect(inputs[0]!.value.action).toBe("baseline");
    expect(vm.stop).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ requireSnapshot: true }));
    expect(validateRuntime).toHaveBeenCalled();
    expect(await imageRow(image.imageId)).toMatchObject({ state: "ready", diagnostic: null });
  });

  it.each(["runtime", "missing runtime", "base"])("withdraws a runtime image after an initial %s identity mismatch", async mismatch => {
    const image = await enableImage();
    vi.mocked(vm.baseStatus).mockResolvedValue({
      schema: "zeros.base-status/v1", bootId: randomUUID(), hostState: "idle",
      baseCompatibilityId: mismatch === "base" ? `bc1-${"c".repeat(64)}` : runtime.baseCompatibilityId,
      currentRuntimeId: mismatch === "runtime" ? `r1-${"f".repeat(64)}` : mismatch === "missing runtime" ? null : runtime.descriptor.runtimeId,
    });
    await request();
    await worker.tick();
    expect(await read()).toMatchObject({ active: null, latestBuild: { state: "failed", errorCode: "runtime_install_failed" } });
    expect(await imageRow(image.imageId)).toMatchObject({ state: "retiring",
      diagnostic: { failedChecks: [mismatch === "base" ? "base_compatibility" : "runtime_identity"] } });
    expect(presignGet).not.toHaveBeenCalled();
    expect(runFixed).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledOnce();
  });

  it.each(["timeout", "transport", "malformed status"])("does not withdraw an image after a base-status %s failure", async failure => {
    const image = await enableImage();
    vi.mocked(vm.waitForBase).mockRejectedValueOnce(failure === "transport" ? new Error("fixture transport failure") :
      new BuilderVmError(failure === "timeout" ? "timeout" : "provider_response"));
    await request();
    await worker.tick();
    expect(await read()).toMatchObject({ active: null, latestBuild: { state: "failed", errorCode: "runtime_install_failed" } });
    expect(await imageRow(image.imageId)).toMatchObject({ state: "ready", diagnostic: null });
    expect(runFixed).not.toHaveBeenCalled();
  });

  it("keeps an image ready when the frozen TCB helper reports an internal failure", async () => {
    const image = await enableImage();
    // The frozen helper emits this same diagnostic for internal command
    // timeouts and OS errors, so it cannot prove shared-image corruption.
    const proof = { schema: "zeros.diagnostic/v1", component: "build", stage: "integrity", ok: false,
      exitCode: 1, timedOut: false, failedChecks: ["tcb_modified"] };
    runFixed.mockResolvedValueOnce({ exitCode: 1, stdout: `${JSON.stringify(proof)}\n`, diagnostic: proof });
    await request();
    await worker.tick();
    expect(await read()).toMatchObject({ active: null, latestBuild: { state: "failed", errorCode: "tcb_modified" } });
    expect(await imageRow(image.imageId)).toMatchObject({ state: "ready", diagnostic: null });
    expect(runFixed).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
  });

  it.each(["timeout", "transport", "malformed result", "missing diagnostic", "exit mismatch", "unrelated diagnostic"])(
    "does not withdraw an image after an unconfirmed baseline %s", async failure => {
      const image = await enableImage();
      if (failure === "transport") runFixed.mockRejectedValueOnce(new Error("fixture transport failure"));
      else {
        const proof = diagnostic("integrity", "build", failure === "malformed result");
        if (failure === "timeout") proof.timedOut = true;
        if (failure === "exit mismatch") proof.exitCode = 2;
        if (failure === "unrelated diagnostic") proof.component = "installer";
        runFixed.mockResolvedValueOnce({ exitCode: failure === "malformed result" ? 0 : 1, stdout: "unparseable fixture result",
          diagnostic: failure === "missing diagnostic" ? undefined : proof });
      }
      await request();
      await worker.tick();
      expect(await read()).toMatchObject({ active: null, latestBuild: { state: "failed", errorCode: "tcb_modified" } });
      expect(await imageRow(image.imageId)).toMatchObject({ state: "ready", diagnostic: null });
      expect(runFixed).toHaveBeenCalledOnce();
    },
  );

  it.each(["install", "integrity"])("does not withdraw an image after a later %s failure", async stage => {
    const image = await enableImage();
    if (stage === "install") installCode = 17;
    else modified = true;
    await request();
    await worker.tick();
    expect(await read()).toMatchObject({ active: null, latestBuild: { state: "failed",
      errorCode: stage === "install" ? "install_failed" : "tcb_modified" } });
    expect(inputs.some(({ command }) => command === "computer:run-install")).toBe(true);
    expect(await imageRow(image.imageId)).toMatchObject({ state: "ready", diagnostic: null });
  });

  it.each(["ready", "stopped", "failed"])("waits for the base before installing when bootstrap becomes %s", async state => {
    const boat = builderFixture(operations);
    boat.state.baseCompatibilityId = runtime.baseCompatibilityId;
    boat.state.hostState = state === "ready" ? "waiting_for_runtime" : state;
    if (state === "ready") boat.state.baseStatusReplies = [{ success: false, exitCode: 1 },
      { timedOut: true }, { stdout: "private boot output" }, { hostState: "stopped" }];
    create.mockImplementation(input => boat.vms.create(input));
    remove.mockImplementation(value => boat.vms.delete(value));
    vm.baseStatus = value => boat.vms.baseStatus(value);
    const readiness = vi.fn((value: BuilderVm) => boat.vms.waitForBase(value));
    vm.waitForBase = readiness;
    vm.stop = value => boat.vms.stop(value);
    await request();
    await worker.tick();
    expect(readiness).toHaveBeenCalledOnce();
    if (state === "ready") {
      expect((await read()).active).not.toBeNull();
      expect(boat.state.baseStatusCalls).toBe(5);
      expect(inputs[0]?.command).toBe("install-runtime");
    } else {
      await expect(readiness.mock.results[0].value).rejects.toMatchObject({
        check: state === "stopped" ? "timeout" : "builder_stopped" });
      expect(await read()).toMatchObject({ active: null,
        latestBuild: { state: "failed", errorCode: "runtime_install_failed" } });
      expect(runFixed).not.toHaveBeenCalled();
      expect(boat.state.deleted).toBe(true);
    }
  });

  it.each([undefined, `zeros-v2-test-c3-${randomUUID()}`])(
    "claims a bounded B7 sandbox name with prefix %s",
    async (namePrefix) => {
      const requested = await request();
      await service.claimNextBuild(7, {
        operations,
        selectRuntime: async () => ({
          baseImageId: runtime.baseImageId,
          runtimeId: runtime.descriptor.runtimeId,
        }),
        accountScope: "fixture-account",
        billingOrg: "fixture-wallet",
        ...(namePrefix ? { namePrefix } : {}),
      });
      const row = (
        await pool.query(
          "SELECT builder_name,builder_operation_key FROM cloud_computer_templates",
        )
      ).rows[0];
      expect(row.builder_name).toMatch(/^zeros-v2-[a-z0-9][a-z0-9-]{0,52}$/);
      expect(row.builder_operation_key).toBe(
        `computer-build:${requested.build.id}`,
      );
    },
  );

  it.each([
    ["stop_snapshot_failed", "template_capture_failed"],
    ["timeout", "template_stop_failed"],
  ] as const)("reports a %s template stop as %s and cleans up", async (check, error) => {
    vi.mocked(vm.stop).mockRejectedValueOnce(new BuilderVmError(check));
    await request();
    await worker.tick();
    expect(await read()).toMatchObject({ active: null, latestBuild: { state: "failed", errorCode: error } });
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["script failure", "install_failed"],
    ["TCB modification", "tcb_modified"],
  ])("cleans up after %s", async (kind, error) => {
    if (kind === "script failure") installCode = 17;
    else modified = true;
    await request();
    await worker.tick();
    expect(await read()).toMatchObject({
      active: null,
      latestBuild: { state: "failed", errorCode: error },
    });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(
      (
        await pool.query(
          "SELECT state,cleanup_confirmed_at FROM cloud_computer_templates",
        )
      ).rows[0],
    ).toMatchObject({
      state: "retired",
      cleanup_confirmed_at: expect.any(Date),
    });
  });

  it("fences cancellation during installation and cleans the VM", async () => {
    const build = await request();
    pollHook = async () => {
      await service.cancel(
        fixture.organizationId,
        fixture.userId,
        build.build.id,
        { expectedRevision: build.revision },
      );
    };
    await worker.tick();
    expect(await read()).toMatchObject({
      active: null,
      latestBuild: { state: "cancelled" },
    });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(inputs.some(({ command }) => command === "computer:sanitize")).toBe(
      false,
    );
  });

  it("cleans a superseded completion without activating the stale recipe", async () => {
    await request();
    pollHook = async () => {
      await service.saveDraft(fixture.organizationId, fixture.userId, {
        expectedRevision: (await read()).revision,
        repositories: [],
        installScript: "new recipe",
        timeoutSeconds: 900,
      });
    };
    await worker.tick();
    expect(await read()).toMatchObject({
      active: null,
      latestBuild: { state: "superseded" },
    });
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("does not publish a runtime revoked while the install script runs", async () => {
    await request();
    validateRuntime.mockResolvedValue(false);
    await worker.tick();
    expect((await read()).active).toBeNull();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it.each(["error", "cancelled", "wallet_mismatch"])(
    "deletes the journalled allocation when create fails before returning a VM (%s)",
    async (failure) => {
      const build = await request();
      create.mockImplementation(async (input) => {
        await recordOperation(input, "bx_23456789");
        throw new Error(failure);
      });
      await worker.tick();
      expect((await read()).latestBuild).toMatchObject({
        state: "failed",
        errorCode: "allocation_failed",
      });
      expect(create).toHaveBeenCalledTimes(1);
      expect(remove).toHaveBeenCalledWith({
        sandboxId: "bx_23456789",
        purpose: "computer-build",
        operationKey: `computer-build:${build.build.id}`,
      });
      expect(runFixed).not.toHaveBeenCalled();
      expect(vm.stop).not.toHaveBeenCalled();
      expect(
        (
          await pool.query(
            "SELECT provider_resource_id,cleanup_confirmed_at FROM cloud_computer_templates",
          )
        ).rows[0],
      ).toEqual({
        provider_resource_id: "bx_23456789",
        cleanup_confirmed_at: expect.any(Date),
      });
    },
  );

  it("releases capacity only after the operation journal closes a confirmed non-allocation", async () => {
    await request();
    create.mockImplementation(async (input) => {
      await recordOperation(input, null, false);
      throw new Error("closed admission failure before dispatch");
    });
    await worker.tick();
    expect(create).toHaveBeenCalledTimes(1);
    expect(operations.closeUnallocatedCreate).toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(vm.stop).not.toHaveBeenCalled();
    expect(
      (
        await pool.query(
          "SELECT provider_resource_id,cleanup_confirmed_at FROM cloud_computer_templates",
        )
      ).rows[0],
    ).toEqual({
      provider_resource_id: null,
      cleanup_confirmed_at: expect.any(Date),
    });
    const state = await read();
    await service.build(fixture.organizationId, fixture.userId, {
      expectedRevision: state.revision,
      operationId: randomUUID(),
    });
    expect((await service.claimNextBuild(10))?.organizationId).toBe(
      fixture.organizationId,
    );
  });

  it.each(["missing", "dispatched"])(
    "retains the capacity hold when the create journal is %s and non-allocation is unconfirmed",
    async (journalState) => {
      await request();
      create.mockImplementation(async (input) => {
        if (journalState === "dispatched") await recordOperation(input, null);
        else operations.rows.delete(input.operationKey); // Simulate a genuinely missing journal.
        throw new Error("unknown allocation result");
      });
      await worker.tick();
      expect(remove).not.toHaveBeenCalled();
      expect(vm.stop).not.toHaveBeenCalled();
      expect(
        (
          await pool.query(
            "SELECT cleanup_confirmed_at FROM cloud_computer_templates",
          )
        ).rows[0].cleanup_confirmed_at,
      ).toBeNull();
      const state = await read();
      await service.build(fixture.organizationId, fixture.userId, {
        expectedRevision: state.revision,
        operationId: randomUUID(),
      });
      expect(await service.claimNextBuild(10)).toBeNull();
    },
  );

  it("fences an expired worker, reconciles an unknown create with the original key, and deletes it", async () => {
    await request();
    const claim = await service.claimNextBuild(7, {
      operations,
      selectRuntime: async () => ({
        baseImageId: runtime.baseImageId,
        runtimeId: runtime.descriptor.runtimeId,
      }),
      accountScope: "fixture-account",
      billingOrg: "fixture-wallet",
      namePrefix: "zeros-v2-test-computer",
    });
    const allocation = (
      await pool.query(
        "SELECT builder_operation_key,builder_name FROM cloud_computer_templates",
      )
    ).rows[0];
    const key = allocation.builder_operation_key;
    await recordOperation(
      {
        purpose: "computer-build",
        source: { kind: "base", baseImageId: runtime.baseImageId },
        name: allocation.builder_name,
        operationKey: key,
        ttlSeconds: 1800,
      },
      null,
    );
    await pool.query(
      "UPDATE cloud_computer_v2_builds SET deadline_at=now()-interval '1 second' WHERE id=$1",
      [claim!.build.id],
    );
    create.mockImplementation(async (input) => {
      await recordOperation(input, "bx_23456789");
      // Replayed allocation can bind the ID and still fail readiness because
      // the expired VM is already archived. Deletion must bypass readiness.
      throw new Error("builder_stopped");
    });
    await worker.tick();
    expect(await read()).toMatchObject({
      active: null,
      latestBuild: { state: "failed", errorCode: "build_timeout" },
    });
    expect(create.mock.calls[0][0].operationKey).toBe(key);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(runFixed).not.toHaveBeenCalled();
    expect(vm.stop).not.toHaveBeenCalled();
    expect(
      await service.markBuildStage(claim!.build.id, 7, "runtime"),
    ).toMatchObject({ applied: false });
  });

  it("retains global and per-org capacity when VM cleanup is uncertain", async () => {
    installCode = 1;
    remove.mockRejectedValue(new Error("closed fixture failure"));
    vi.mocked(vm.stop).mockRejectedValue(new Error("closed fixture failure"));
    await request();
    await worker.tick();
    const state = await read();
    await service.build(fixture.organizationId, fixture.userId, {
      expectedRevision: state.revision,
      operationId: randomUUID(),
    });
    expect(await service.claimNextBuild(10)).toBeNull();
    expect(
      (
        await pool.query(
          "SELECT cleanup_confirmed_at FROM cloud_computer_templates",
        )
      ).rows[0].cleanup_confirmed_at,
    ).toBeNull();
    const other = await seedReadyCloudWorkspace(pool, { runtimeV4: false });
    await service.build(other.organizationId, other.userId, {
      expectedRevision: 0,
      operationId: randomUUID(),
    });
    expect((await service.claimNextBuild(11))?.organizationId).toBe(
      other.organizationId,
    );
    const third = await seedReadyCloudWorkspace(pool, { runtimeV4: false });
    await service.build(third.organizationId, third.userId, {
      expectedRevision: 0,
      operationId: randomUUID(),
    });
    expect(await service.claimNextBuild(12)).toBeNull();
  });

  it("retries cleanup after restart without allocating another VM and releases capacity", async () => {
    installCode = 1;
    remove.mockRejectedValueOnce(new Error("closed fixture failure"));
    vi.mocked(vm.stop).mockRejectedValueOnce(
      new Error("closed fixture failure"),
    );
    await request();
    await worker.tick();
    const state = await read();
    await service.build(fixture.organizationId, fixture.userId, {
      expectedRevision: state.revision,
      operationId: randomUUID(),
    });
    expect(await service.claimNextBuild(10)).toBeNull();
    await pool.query(
      "UPDATE cloud_computer_templates SET cleanup_retry_at=now()-interval '1 second' WHERE cleanup_confirmed_at IS NULL",
    );
    // A fresh worker has no process-local history; the resource/key comes from
    // the durable journal. Do not start the next recipe during this assertion.
    selectRuntime.mockResolvedValue(null);
    const restarted = new ComputerTemplateWorker({
      pool,
      service,
      vms: vm,
      operations,
      snapshots: workerOptions.snapshots,
      github,
      accountScope: "fixture-account",
      billingOrg: "fixture-wallet",
      pollMs: 0,
      runtime: { select: selectRuntime, load: loadRuntime, validate: validateRuntime },
      artifacts: { presignGet: vi.fn() },
    });
    await restarted.tick();
    expect(create).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(2);
    expect(
      (
        await pool.query(
          "SELECT cleanup_confirmed_at FROM cloud_computer_templates",
        )
      ).rows[0].cleanup_confirmed_at,
    ).toBeInstanceOf(Date);
    expect((await read()).latestBuild).toMatchObject({
      state: "failed",
      errorCode: "runtime_unavailable",
    });
  });

  it("clones with a single-repo token on stdin, revokes it, and never persists tokens, URLs or org values in the build", async () => {
    const repo = await repository();
    const build = await request({
      repositories: [repo],
      installScript: "true",
      timeoutSeconds: 900,
      environment: [
        {
          op: "set",
          name: "PRIVATE_SETTING",
          value: "synthetic-org-only-value",
        },
      ],
    });
    const original = runFixed.getMockImplementation()!;
    runFixed.mockImplementation(async (vm, command, input) => {
      const output = await original(vm, command, input);
      if (command !== "computer:run-install") return output;
      const value = JSON.parse(input.toString());
      if (value.action !== "poll") return output;
      const partial = value.after === 0;
      return {
        ...output,
        stdout: JSON.stringify({
          schema: "zeros.computer-install/v1",
          buildId: value.buildId,
          workerFence: value.workerFence,
          state: partial ? "running" : "succeeded",
          exitCode: partial ? null : 0,
          timedOut: false,
          truncated: false,
          chunks: [
            {
              seq: partial ? 1 : 2,
              stream: "stdout",
              text: partial ? "package synthetic-clo" : "ne-credential ready\n",
            },
          ],
          nextAfter: partial ? 1 : 2,
        }),
      };
    });
    await worker.tick();
    expect(github.mintContentsRead).toHaveBeenCalledWith({
      installationId: 123,
      repositoryId: 456,
    });
    expect(github.revoke).toHaveBeenCalledWith("synthetic-clone-credential");
    expect(
      inputs.find(({ command }) => command === "computer:clone-repos")?.value
        .repositories[0],
    ).toMatchObject({
      id: "456",
      credential: { token: "synthetic-clone-credential" },
    });
    expect(JSON.stringify(inputs).includes("synthetic-org-only-value")).toBe(
      false,
    );
    const persisted = JSON.stringify(
      (
        await pool.query(
          `SELECT to_jsonb(build) AS build,to_jsonb(template) AS template,
      (SELECT jsonb_agg(log) FROM cloud_computer_build_logs log WHERE log.build_id=build.id) AS logs
      FROM cloud_computer_v2_builds build JOIN cloud_computer_templates template ON template.build_id=build.id WHERE build.id=$1`,
          [build.build.id],
        )
      ).rows,
    );
    expect(persisted.includes("synthetic-clone-credential")).toBe(false);
    expect(persisted.includes("signature=fixture")).toBe(false);
    expect(persisted.includes("synthetic-org-only-value")).toBe(false);
    expect(persisted).toContain("package [redacted] ready");
    expect((await read()).active?.id).toBe(build.build.id);
  });

  it.each(["mint", "revoke", "suspended"])(
    "fails closed and cleans up when repository %s fails",
    async (kind) => {
      const repo = await repository();
      await request({
        repositories: [repo],
        installScript: "true",
        timeoutSeconds: 900,
      });
      if (kind === "mint")
        github.mintContentsRead.mockRejectedValue(
          new Error("untrusted broker detail"),
        );
      if (kind === "revoke")
        github.revoke.mockRejectedValue(new Error("untrusted broker detail"));
      if (kind === "suspended")
        github.mintContentsRead.mockImplementation(async () => {
          await pool.query(
            "UPDATE github_installations SET suspended_at=now() WHERE id=$1",
            [repo.installationId],
          );
          return {
            token: "synthetic-clone-credential",
            expiresAtMs: Date.now() + 3_600_000,
          };
        });
      await worker.tick();
      expect(await read()).toMatchObject({
        active: null,
        latestBuild: { state: "failed", errorCode: "repository_access_denied" },
      });
      if (kind !== "mint") expect(github.revoke).toHaveBeenCalledTimes(1);
      expect(
        inputs.some(({ command }) => command === "computer:run-install"),
      ).toBe(false);
      expect(remove).toHaveBeenCalledTimes(1);
    },
  );

  it("cleans up a VM whose allocation completes after cancellation", async () => {
    const build = await request();
    const original = create.getMockImplementation()!;
    create.mockImplementation(async (input) => {
      await service.cancel(
        fixture.organizationId,
        fixture.userId,
        build.build.id,
        { expectedRevision: build.revision },
      );
      return original(input);
    });
    await worker.tick();
    expect((await read()).latestBuild?.state).toBe("cancelled");
    expect(remove).toHaveBeenCalledTimes(1);
    expect(runFixed).not.toHaveBeenCalled();
  });

  it("does not stop an unrelated VM returned with a mismatched allocation identity", async () => {
    await request();
    create.mockImplementation(async input => {
      await recordOperation(input, null);
      return { sandboxId: "unrelated-resource", purpose: "runtime-qualification", operationKey: "foreign-operation" };
    });
    await worker.tick();
    expect((await read()).latestBuild).toMatchObject({
      state: "failed",
      errorCode: "allocation_failed",
    });
    expect(vm.stop).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(
      (
        await pool.query(
          "SELECT provider_resource_id,stopped_at,cleanup_confirmed_at FROM cloud_computer_templates",
        )
      ).rows[0],
    ).toEqual({
      provider_resource_id: null,
      stopped_at: null,
      cleanup_confirmed_at: null,
    });
  });

  it("keeps an active template when the completion commits but its DB reply is lost", async () => {
    const build = await request();
    const complete = service.completeBuild.bind(service);
    vi.spyOn(service, "completeBuild").mockImplementation(async (...args) => {
      await complete(...args);
      throw new Error("lost DB reply");
    });
    await worker.tick();
    expect((await read()).active?.id).toBe(build.build.id);
    expect(remove).not.toHaveBeenCalled();
  });

  it("repeats the same install start after a lost SSH reply, then reconnects by cursor", async () => {
    const build = await request();
    const original = runFixed.getMockImplementation()!;
    let lost = false;
    runFixed.mockImplementation(async (vm, command, input) => {
      const output = await original(vm, command, input);
      if (command === "computer:run-install" && !lost) {
        lost = true;
        throw new Error("lost SSH reply");
      }
      return output;
    });
    await worker.tick();
    const starts = inputs.filter(
      ({ command, value }) =>
        command === "computer:run-install" && value.action === "start",
    );
    expect(starts).toHaveLength(2);
    expect(starts[0]).toEqual(starts[1]);
    expect((await read()).active?.id).toBe(build.build.id);
  });

  it("retries intermittent poll failures after successful polls without restarting the script", async () => {
    const build = await request();
    const original = runFixed.getMockImplementation()!;
    let polls = 0;
    runFixed.mockImplementation(async (vm, command, input) => {
      const output = await original(vm, command, input);
      if (
        command !== "computer:run-install" ||
        JSON.parse(input.toString()).action !== "poll"
      )
        return output;
      polls++;
      if ([4, 6, 8].includes(polls)) throw new Error("lost SSH reply");
      if (polls < 9) {
        const data = JSON.parse(output.stdout);
        Object.assign(data, {
          state: "running",
          exitCode: null,
          chunks: [],
          nextAfter: 0,
        });
        output.stdout = JSON.stringify(data);
      }
      return output;
    });
    await worker.tick();
    expect((await read()).active?.id).toBe(build.build.id);
    expect(
      inputs.filter(
        ({ command, value }) =>
          command === "computer:run-install" && value.action === "start",
      ),
    ).toHaveLength(1);
    expect(polls).toBe(9);
  });

  it("reports helper log truncation through C1's cursor API", async () => {
    const build = await request();
    const original = runFixed.getMockImplementation()!;
    runFixed.mockImplementation(async (vm, command, input) => {
      const output = await original(vm, command, input);
      if (
        command === "computer:run-install" &&
        JSON.parse(input.toString()).action === "poll"
      ) {
        const data = JSON.parse(output.stdout);
        data.chunks[0].seq = data.nextAfter = 19;
        data.truncated = true;
        output.stdout = JSON.stringify(data);
      }
      return output;
    });
    await worker.tick();
    expect(
      (
        await service.logs(
          fixture.organizationId,
          fixture.userId,
          build.build.id,
          { after: 0 },
        )
      ).truncated,
    ).toBe(true);
  });
});
