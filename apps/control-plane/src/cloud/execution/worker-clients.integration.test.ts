import { generateKeyPairSync, randomUUID } from "node:crypto";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { manageCloudExecution, type CloudExecutionChange } from "../../manage-cloud-execution.js";
import { CloudV2Lifecycle } from "../lifecycle.js";
import type { CloudV2Compute } from "../boat.js";
import { CLOUD_V2_RESTORE_AUTH_PREFIX } from "../checkpoint-active-restore.js";
import { CloudExecutionActivations } from "./activation.js";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

// Only tests cross the deployment boundary; integration resolves the same
// relative sources, while a separate worktree can pin the worker revision.
const root = new URL(process.env.CLOUD_EXECUTION_TEST_CLIENT_ROOT ?? "../../../../../", import.meta.url);
const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const canChangeOwner = process.platform === "linux" && (process.getuid?.() === 0 || spawnSync("sudo", ["-n", "true"], { stdio: "ignore" }).status === 0);
database("real acting-user worker clients against HTTP routes and PostgreSQL", () => {
  let pool: pg.Pool, f: ExecutionFixture, directory: string;
  let clients: { HybridTransport: any; ExecutionContexts: any; CloudWorker: any; protocol: any;
    removeLegacyMaterial: any; seedEnvironment: any; WorkspaceScope: any; configureGitIdentity: any };
  let worker: any, contexts: any, config: any;
  let loseCleanReply: boolean;
  let startWorker: (token?: string) => Promise<void>;
  type Call = { path: string; body: any; headers: Headers; status?: number; reply?: any };
  let calls: Call[];
  const volumes: string[] = [];
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8, statement_timeout: 4000 });
    clients = {
      ...await import(new URL("apps/cloud-worker/src/hybrid-transport.ts", root).href),
      ...await import(new URL("apps/cloud-worker/src/sharing/execution-contexts.ts", root).href),
      ...await import(new URL("apps/cloud-worker/src/worker.ts", root).href),
      ...await import(new URL("apps/cloud-worker/src/sharing/legacy-material.ts", root).href),
      ...await import(new URL("apps/cloud-worker/src/workspace/environment-seed.ts", root).href),
      ...await import(new URL("apps/cloud-worker/src/workspace/scope.ts", root).href),
      ...await import(new URL("apps/cloud-worker/src/credentials/git-identity.ts", root).href),
      protocol: await import(new URL("packages/protocol/src/cloud-v2-relay.ts", root).href),
    };
  });
  beforeEach(async () => {
    calls = []; config = undefined; loseCleanReply = false;
    directory = await mkdtemp(join(tmpdir(), "execution-clients-"));
    const tokenFile = join(directory, "token");
    const fetcher: typeof fetch = async (input, init) => {
      const request = new Request(input, init), path = new URL(request.url).pathname;
      if (!path.startsWith("/v2/cloud/worker/")) return f.fetcher(input, init);
      const call: Call = { path, headers: request.headers, body: request.body ? await request.clone().json() : undefined };
      calls.push(call);
      const response = await f.app.fetch(request);
      call.status = response.status;
      if (response.headers.get("content-type")?.includes("application/json")) call.reply = await response.clone().json();
      if (loseCleanReply && path.endsWith("/boot-clean") && response.ok) {
        loseCleanReply = false;
        throw new TypeError("Fixture lost the committed boot-clean reply");
      }
      return response;
    };
    f = await executionFixture(pool);
    await f.login(); await f.login(f.viewer); await f.activate();
    startWorker = async (token = f.token) => {
      config = undefined;
      worker = new clients.HybridTransport({ apiUrl: "https://api.example.test", workspaceId: f.workspace.id, tokenFile, port: 0,
        runtimeSha256: "b".repeat(64), fetch: fetcher,
        publicKeys: [generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString()] });
      await writeFile(tokenFile, token, { mode: 0o600 });
      contexts = new clients.ExecutionContexts({ post: (path: string, body: unknown) => worker.contextRequest(path, body) });
      worker.start({ open: async () => {}, close: () => {}, frame: async (frame: any) => { if (frame.t === "config") config = frame; } });
      await expect.poll(() => config).toBeDefined();
    };
    await startWorker();
  });
  afterEach(async () => {
    contexts?.dispose(); await worker?.dispose(); await f?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
    for (const volume of volumes.splice(0)) await rm(volume, { recursive: true, force: true });
    vi.restoreAllMocks(); vi.unstubAllGlobals();
  });
  afterAll(() => pool.end());
  const clean = () => contexts.clean(async () => ({ processes: 0, legacyMaterial: "none" }));
  const localDisk = async () => {
    const paths = { root: join(directory,"repository"), state: join(directory,"state"), home: join(directory,"home"), shm: join(directory,"shm") };
    for (const path of Object.values(paths)) await mkdir(path);
    execFileSync("git",["init","-q",paths.root]);
    await writeFile(join(paths.root,".gitignore"),".env*\n");
    const scope = new clients.WorkspaceScope({ ...config.workspace,checkoutPath: paths.root });
    return { paths,scope,exists: (path: string) => lstat(path).then(() => true, () => false) };
  };
  const offer = async (input = f.prompt(), user = f.creator) => {
    expect((await f.send(input, user)).status).toBe(201);
    const delivery = (await worker.promptRequest("pull", { waitMs: 0, held: [] })).prompts.find((value: any) => value.payload.userMessageId === input.userMessageId);
    expect(delivery.senderUserId).toBe(user.id);
    await worker.promptRequest("ack", { userMessageId: input.userMessageId, deliveryId: delivery.deliveryId });
    return { input, begin: { userMessageId: input.userMessageId, deliveryId: delivery.deliveryId, dispatchId: randomUUID() } };
  };
  const begin = async (offered: Awaited<ReturnType<typeof offer>>) => {
    const result = clients.protocol.CloudV2BeginActiveReplySchema.parse(await worker.promptRequest("begin", offered.begin));
    const request = { chatId: offered.input.chatId, userMessageId: offered.input.userMessageId, dispatchId: offered.begin.dispatchId,
      generation: result.actingUser.generation, contextId: result.contextId };
    return { ...offered, result, request, lease: await contexts.turnLease(request) };
  };
  const finish = (turn: Awaited<ReturnType<typeof begin>>) => worker.promptRequest("outcome", {
    userMessageId: turn.input.userMessageId, dispatchId: turn.begin.dispatchId, state: "completed",
  });

  it("gates every personal lease behind boot-clean and replays a lost successful reply", async () => {
    expect(config).toMatchObject({ actingUser: 1, agents: {}, gitIdentity: null, promptOutbox: 1, notifyUser: 1 });
    for (const key of ["api", "environment", "mcpServers", "codeReview"]) expect(config).not.toHaveProperty(key);
    await expect(worker.contextRequest("bootstrap-lease", { contextId: config.bootstrapContextId })).rejects.toMatchObject({ status: 409, contextCode: "actor_busy" });
    loseCleanReply = true; await clean();
    const receipts = calls.filter(value => value.path.endsWith("/boot-clean"));
    expect(receipts).toHaveLength(2); expect(receipts[0]!.body).toEqual(receipts[1]!.body);
    expect(receipts[1]!.reply).toEqual({ retired: 0 });
    const lease = await contexts.bootstrapLease(config.bootstrapContextId);
    expect(lease.userId).toBe(f.creator.id);
    await contexts.retire(lease.contextId, "setup_done", 0);
    await contexts.retire(lease.contextId, "setup_done", 0);
    const ended = calls.filter(value => value.path.endsWith(`/${lease.contextId}/retired`));
    expect(ended[0]!.body).toEqual(ended[1]!.body);
    for (const call of calls) {
      expect(call.headers.get("x-zeros-worker-boot")).toBe(worker.bootId);
      expect(call.headers.get("content-type")).toBe("application/json");
      expect(call.headers.get("x-zeros-worker-features")?.split(",")).toContain("acting-user-v1");
    }
  });

  it("keeps existing feature flags on the WebSocket configuration path too", async () => {
    const current = await f.cp.store.workerSession(f.token, worker.bootId);
    const frame = await f.cp.workers.config(current!);
    expect(clients.protocol.CloudV2ControlFrameSchema.parse(frame)).toMatchObject({ actingUser: 1, notifyUser: 1, promptOutbox: 1 });
  });

  it("passes begin, steer, handover and stable leases through the real strict decoders", async () => {
    await clean();
    const a = await begin(await offer());
    expect(a.lease.userId).toBe(f.creator.id);
    expect(Object.keys(a.lease.agents)).toEqual(["claude"]);
    expect(await contexts.turnLease(a.request)).toEqual(a.lease);
    const steer = await begin(await offer(f.prompt(randomUUID(), { mode: "steer" })));
    expect(steer.result).toMatchObject({ mode: "steer", contextId: a.result.contextId, parentContextId: a.result.contextId, actingUser: a.result.actingUser });
    expect(steer.lease).toEqual(a.lease); await finish(steer); await finish(a);
    const b = await offer(f.prompt(), f.viewer);
    await expect(worker.promptRequest("begin", b.begin)).rejects.toMatchObject({ status: 409, contextCode: "actor_busy" });
    await expect(contexts.retire(a.result.contextId, "outcome", 1)).rejects.toMatchObject({ status: 409, contextCode: "execution_not_retired" });
    await contexts.retire(a.result.contextId, "outcome", 0);
    const next = await begin(b);
    expect(next.result.actingUser).toMatchObject({ userId: f.viewer.id, generation: "2" });
    expect(next.lease.agents.claude.apiKey).not.toBe(a.lease.agents.claude.apiKey);
    expect(next.lease.api.token).not.toBe(a.lease.api.token);
  });

  it("never leases after an unproven boot cleanup and preserves the closed error", async () => {
    await expect(contexts.clean(async () => 1)).rejects.toMatchObject({ status: 409, contextCode: "execution_not_retired" });
    const before = calls.length;
    await expect(contexts.bootstrapLease(config.bootstrapContextId)).rejects.toMatchObject({ status: 409, contextCode: "execution_not_retired" });
    expect(calls).toHaveLength(before);
    expect((await pool.query("SELECT state FROM cloud_v2_execution_contexts WHERE workspace_id=$1", [f.workspace.id])).rows)
      .toEqual([{ state: "active" }]);
  });

  it("posts the real disk cleanup result, erases the managed Creator files and permits only personal leases", async () => {
    const disk=await localDisk();
    await clients.seedEnvironment(disk.scope,disk.paths.state,{versionId:randomUUID(),repositoryId:"42",variables:{},
      files:[{path:".env.local",content:"VALUE=synthetic-creator-value\n"}]},new AbortController().signal);
    await clients.configureGitIdentity(disk.paths.home,{name:"Fixture Creator",email:"creator@example.test"});
    await mkdir(join(disk.paths.state,"terminals"));
    await writeFile(join(disk.paths.state,"terminals","fixture.json"),JSON.stringify({screen:"synthetic terminal"}));
    await contexts.clean(async () => ({processes:0,legacyMaterial:await clients.removeLegacyMaterial(disk.paths)}));
    expect(calls.find(call=>call.path.endsWith("/boot-clean"))).toMatchObject({body:{processes:0,legacyMaterial:"removed"},status:200,reply:{retired:0}});
    expect(await disk.exists(join(disk.paths.root,".env.local"))).toBe(false);
    expect(await disk.exists(join(disk.paths.state,"terminals","fixture.json"))).toBe(false);
    expect(await readFile(join(disk.paths.home,".config/zeros/git-identity"),"utf8")).not.toContain("Fixture Creator");
    const lease=await contexts.bootstrapLease(config.bootstrapContextId);
    expect(lease.userId).toBe(f.creator.id);
  });

  it("keeps modified seed bytes, records the closed class and refuses every lease", async () => {
    const disk=await localDisk(),path=join(disk.paths.root,".env.local");
    await clients.seedEnvironment(disk.scope,disk.paths.state,{versionId:randomUUID(),repositoryId:"42",variables:{},
      files:[{path:".env.local",content:"VALUE=synthetic-creator-value\n"}]},new AbortController().signal);
    await rm(path); await writeFile(path,"MEMBER_FILE=keep\n");
    await expect(contexts.clean(async () => {
      const refusals: string[] = [], legacyMaterial = await clients.removeLegacyMaterial(disk.paths, (value: string) => refusals.push(value));
      return { processes: 0, legacyMaterial, refusals };
    }))
      .rejects.toMatchObject({status:409,contextCode:"execution_not_retired"});
    const receipt=calls.find(call=>call.path.endsWith("/boot-clean"));
    expect(receipt).toMatchObject({body:{processes:0,legacyMaterial:"refused",refusals:["seed_target_modified"]},status:409,reply:{error:{code:"execution_not_retired"}}});
    expect((await pool.query("SELECT first_failed_refusals FROM cloud_v2_execution_boots WHERE workspace_id=$1 AND boot_id=$2", [f.workspace.id, worker.bootId])).rows)
      .toEqual([{ first_failed_refusals: ["seed_target_modified"] }]);
    expect(await readFile(path,"utf8")).toBe("MEMBER_FILE=keep\n");
    const before=calls.length;
    await expect(contexts.bootstrapLease(config.bootstrapContextId)).rejects.toMatchObject({contextCode:"execution_not_retired"});
    expect(calls).toHaveLength(before);
  });

  it("keeps a version-1 journal and its bytes, reporting the required legacy upgrade", async () => {
    const disk = await localDisk(), path = join(disk.paths.root, ".env.local"), journalPath = join(disk.paths.state, "environment-seed/manifest.json");
    await clients.seedEnvironment(disk.scope, disk.paths.state, { versionId: randomUUID(), repositoryId: "42", variables: {},
      files: [{ path: ".env.local", content: "LEGACY=synthetic\n" }] }, new AbortController().signal);
    const journal = JSON.parse(await readFile(journalPath, "utf8")); journal.version = 1;
    for (const entry of journal.files) delete entry.sha256;
    await writeFile(journalPath, JSON.stringify(journal));
    await expect(contexts.clean(async () => {
      const refusals: string[] = [], legacyMaterial = await clients.removeLegacyMaterial(disk.paths, (value: string) => refusals.push(value));
      return { processes: 0, legacyMaterial, refusals };
    })).rejects.toMatchObject({ status: 409, contextCode: "execution_not_retired" });
    expect(calls.find(call => call.path.endsWith("/boot-clean"))).toMatchObject({
      body: { processes: 0, legacyMaterial: "refused", refusals: ["seed_journal_outdated"] }, status: 409,
    });
    expect(await readFile(path, "utf8")).toBe("LEGACY=synthetic\n");
    expect(JSON.parse(await readFile(journalPath, "utf8")).version).toBe(1);
  });

  it.skipIf(!canChangeOwner)("refuses a foreign-owned nested seed parent and keeps the file", async () => {
    const disk = await localDisk(), parent = join(disk.paths.root, "private-env"), path = join(parent, ".env.local");
    await clients.seedEnvironment(disk.scope, disk.paths.state, { versionId: randomUUID(), repositoryId: "42", variables: {},
      files: [{ path: "private-env/.env.local", content: "SYNTHETIC=keep\n" }] }, new AbortController().signal);
    const uid = process.getuid!(), foreign = uid === 0 ? 1 : 0;
    const owner = (value: number) => execFileSync(uid === 0 ? "chown" : "sudo",
      [...(uid === 0 ? [] : ["-n", "chown"]), String(value), "--", parent], { stdio: "pipe" });
    await chmod(parent, 0o777); owner(foreign);
    try {
      expect((await lstat(parent)).uid).toBe(foreign);
      await expect(contexts.clean(async () => {
        const refusals: string[] = [], legacyMaterial = await clients.removeLegacyMaterial(disk.paths, (value: string) => refusals.push(value));
        return { processes: 0, legacyMaterial, refusals };
      })).rejects.toMatchObject({ status: 409, contextCode: "execution_not_retired" });
      expect(calls.find(call => call.path.endsWith("/boot-clean"))).toMatchObject({
        body: { processes: 0, legacyMaterial: "refused", refusals: ["checkout_foreign"] }, status: 409,
      });
      expect(await readFile(path, "utf8")).toBe("SYNTHETIC=keep\n");
    } finally { owner(uid); }
  });

  it.each(["identity", "terminals"])("refuses a %s directory replaced by a link and keeps the foreign files", async kind => {
    const disk=await localDisk(),foreign=join(directory,"foreign"),file=kind==="identity"?"git-identity":"fixture.json";
    await mkdir(foreign);
    await writeFile(join(foreign,file),"FOREIGN_FILE=keep\n");
    if(kind==="identity") {
      await mkdir(join(disk.paths.home,".config"));
      await symlink(foreign,join(disk.paths.home,".config/zeros"));
    } else await symlink(foreign,join(disk.paths.state,"terminals"));
    await expect(contexts.clean(async () => ({processes:0,legacyMaterial:await clients.removeLegacyMaterial(disk.paths)})))
      .rejects.toMatchObject({status:409,contextCode:"execution_not_retired"});
    expect(await readFile(join(foreign,file),"utf8")).toBe("FOREIGN_FILE=keep\n");
  });

  it("refuses a linked ancestor of the actual worker state path and keeps its terminal record", async () => {
    const disk = await localDisk(), foreign = join(directory, "foreign-local");
    const suffix = "share/zeros/cloud-worker", state = join(disk.paths.home, ".local", suffix);
    await mkdir(join(foreign, suffix, "terminals"), { recursive: true });
    const file = join(foreign, suffix, "terminals/fixture.json");
    await writeFile(file, "FOREIGN_FILE=keep\n");
    await symlink(foreign, join(disk.paths.home, ".local"));
    await expect(contexts.clean(async () => ({ processes: 0,
      legacyMaterial: await clients.removeLegacyMaterial({ ...disk.paths, state }) })))
      .rejects.toMatchObject({ status: 409, contextCode: "execution_not_retired" });
    expect(await readFile(file, "utf8")).toBe("FOREIGN_FILE=keep\n");
  });

  it.each([false, true])("joins the CP restore-token pattern to the worker cleanup (foreign entry: %s)", async foreign => {
    const disk = await localDisk();
    expect(CLOUD_V2_RESTORE_AUTH_PREFIX).toBe("/dev/shm/zeros-restore-auth-");
    const name = `${CLOUD_V2_RESTORE_AUTH_PREFIX.slice("/dev/shm/".length)}${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    const path = join(disk.paths.shm, name);
    await mkdir(path, { mode: 0o700 });
    await writeFile(join(path, "token"), "synthetic-restore-credential", { mode: 0o600 });
    if (foreign) await writeFile(join(path, "foreign"), "keep\n");
    const pending = contexts.clean(async () => ({ processes: 0, legacyMaterial: await clients.removeLegacyMaterial(disk.paths) }));
    if (foreign) {
      await expect(pending).rejects.toMatchObject({ status: 409, contextCode: "execution_not_retired" });
      expect(await readFile(join(path, "token"), "utf8")).toBe("synthetic-restore-credential");
      expect(await readFile(join(path, "foreign"), "utf8")).toBe("keep\n");
    } else {
      await pending;
      expect(await disk.exists(path)).toBe(false);
      expect(calls.find(call => call.path.endsWith("/boot-clean"))).toMatchObject({ body: { processes: 0, legacyMaterial: "removed" }, status: 200 });
    }
  });

  it("keeps older-boot contexts unretired when processes are zero but material is refused", async () => {
    await clean();
    const turn = await begin(await offer());
    contexts.dispose(); await worker.dispose();
    await startWorker();
    await expect(contexts.clean(async () => ({ processes: 0, legacyMaterial: "refused" })))
      .rejects.toMatchObject({ status: 409, contextCode: "execution_not_retired" });
    expect(calls.at(-1)).toMatchObject({ path: "/v2/cloud/worker/execution-leases/boot-clean", body: { processes: 0, legacyMaterial: "refused" },
      status: 409, reply: { error: { code: "execution_not_retired" } } });
    expect((await pool.query("SELECT state FROM cloud_v2_execution_contexts WHERE id=$1", [turn.result.contextId])).rows[0].state).not.toBe("retired");
    expect((await pool.query("SELECT clean_at FROM cloud_v2_execution_boots WHERE workspace_id=$1 AND boot_id=$2", [f.workspace.id, worker.bootId])).rows[0].clean_at).toBeNull();
    contexts.dispose(); await worker.dispose();
    await startWorker(); await clean();
    expect((await pool.query("SELECT state,material FROM cloud_v2_execution_contexts WHERE id=$1", [turn.result.contextId])).rows[0])
      .toEqual({ state: "retired", material: null });
  });

  it.each(["v2", "upgraded_v1"])("joins prepare, Stop and resume on a new filesystem with %s cleanup and the initiator's lease", async journalKind => {
    contexts.dispose(); await worker.dispose(); await f.close();
    f = await executionFixture(pool); await f.cp.loginChanges.stop();
    config = (await (await f.hello()).json()).config;
    const disk = await localDisk();
    const environment = { versionId: randomUUID(), repositoryId: "42", variables: {}, files: [{ path: ".env.local", content: "LEGACY=synthetic\n" }] };
    await clients.seedEnvironment(disk.scope, disk.paths.state, environment, new AbortController().signal);
    const journalPath = join(disk.paths.state, "environment-seed/manifest.json");
    if (journalKind === "upgraded_v1") {
      const journal = JSON.parse(await readFile(journalPath, "utf8")); journal.version = 1;
      for (const entry of journal.files) delete entry.sha256;
      await writeFile(journalPath, JSON.stringify(journal));
      await clients.seedEnvironment(disk.scope, disk.paths.state, environment, new AbortController().signal);
    }
    expect(JSON.parse(await readFile(journalPath, "utf8")).version).toBe(2);
    await clients.configureGitIdentity(disk.paths.home, { name: "Fixture Creator", email: "creator@example.test" });
    await pool.query("UPDATE users SET staff_role='platform_owner' WHERE id=$1", [f.admin.id]);
    const change: CloudExecutionChange = { activationId: randomUUID(), action: "prepare", channel: "development",
      organizationId: f.organizationId, workspaceId: f.workspace.id, initiatorUserId: f.viewer.id, operatorUserId: f.admin.id,
      runtimeSha256: "b".repeat(64), reason: "Joined activation fixture" };
    const run = async (action: CloudExecutionChange["action"]) => {
      const input = { ...change, action }, options = { databaseUrl: process.env.TEST_DATABASE_URL!, channel: "development" };
      const plan = await manageCloudExecution(pool, input, options);
      return manageCloudExecution(pool, input, { ...options, execute: true, approval: plan.planSha256 });
    };
    const row = async () => (await pool.query("SELECT * FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0];
    await run("prepare"); expect(await row()).toMatchObject({ execution_mode: "prepared", execution_transition_id: null });
    await run("activate");
    let release!: () => void;
    const compute = { stop: vi.fn(() => new Promise<void>(resolve => { release = resolve; })), delete: vi.fn(async () => {}),
      extendLease: vi.fn(async () => {}) } as unknown as CloudV2Compute;
    const lifecycle = new CloudV2Lifecycle({ store: f.cp.store, compute,
      runtime: { sha256: change.runtimeSha256, url: async () => "https://example.test/runtime" },
      publicKeys: [], sealPortToken: () => null, stopWorker: async () => true, bootEnv: () => ({}), sandboxName: () => "fixture" });
    const stopping = lifecycle.tick(); await expect.poll(() => compute.stop).toHaveBeenCalled();
    try {
      expect(await row()).toMatchObject({ state: "stopping", execution_transition_id: change.activationId });
      expect((await f.worker("hello", { protocol: 2, bootId: f.boot, runtimeSha256: change.runtimeSha256 })).status).toBe(401);
    } finally { release(); await stopping; }
    // Boat can retain the VM identity while rematerializing its filesystem.
    // Use another real device and a newly written file, not mocked stat data.
    const volume = await mkdtemp("/dev/shm/zeros-seed-proof-"); volumes.push(volume);
    const oldIdentity = await lstat(join(disk.paths.root, ".env.local"));
    for (const kind of ["root", "state", "home", "shm"] as const) {
      const target = join(volume, kind); await cp(disk.paths[kind], target, { recursive: true }); disk.paths[kind] = target;
    }
    const newIdentity = await lstat(join(disk.paths.root, ".env.local"));
    expect(newIdentity.dev).not.toBe(oldIdentity.dev);
    await new CloudExecutionActivations(pool, f.cp.execution).step(change.activationId);
    expect(await row()).toMatchObject({ state: "starting", execution_mode: "active", execution_transition_id: change.activationId });
    await startWorker(await f.cp.store.rotateWorkerToken(f.workspace.id));
    for (const field of ["environment", "api", "mcpServers", "codeReview"]) expect(config).not.toHaveProperty(field);
    expect(config).toMatchObject({ actingUser: 1, agents: {}, gitIdentity: null });
    await expect(worker.contextRequest("bootstrap-lease", { contextId: config.bootstrapContextId }))
      .rejects.toMatchObject({ status: 409, contextCode: "actor_busy" });
    await contexts.clean(async () => ({ processes: 0, legacyMaterial: await clients.removeLegacyMaterial(disk.paths) }));
    expect(await row()).toMatchObject({ state: "running", execution_transition_id: null });
    expect((await pool.query("SELECT phase,boot_id,legacy_material FROM cloud_v2_execution_activations WHERE id=$1", [change.activationId])).rows[0])
      .toEqual({ phase: "active", boot_id: worker.bootId, legacy_material: "removed" });
    expect(await disk.exists(join(disk.paths.root, ".env.local"))).toBe(false);
    const lease = await contexts.bootstrapLease(config.bootstrapContextId);
    expect(lease.userId).toBe(f.viewer.id);
    await contexts.retire(lease.contextId, "setup_done", 0);
  });

  it("renews a batch without extending authority on a temporary failure, then retires on Stop", async () => {
    await clean(); const turn = await begin(await offer(f.prompt(), f.viewer));
    const deadline = contexts.expiresAt(turn.result.contextId);
    vi.spyOn(f.cp.execution.deps.logins, "select").mockRejectedValueOnce(new (await import("../../authz.js")).HttpError(503, "agent_credentials_unavailable", "Fixture vault unavailable"));
    await contexts.renew(); expect(contexts.expiresAt(turn.result.contextId)).toBe(deadline);
    expect(calls.at(-1)!.status).toBe(503); expect(contexts.live(turn.result.contextId)).toBe(true);
    const stopped = await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/prompts/stop`, "POST", { chatId: "chat", throughEpoch: "0" }, f.admin, { "X-Zeros-Team-Sharing": "1" });
    expect(stopped.status).toBe(200);
    await contexts.renew(); expect(contexts.live(turn.result.contextId)).toBe(false);
    expect(calls.at(-1)!.reply.leases).toEqual([{ contextId: turn.result.contextId, refused: "cancelled" }]);
    await contexts.retire(turn.result.contextId, "stop", 0);
  });

  it("keeps the worker's context API bearer tied to its sender when writing another person's chat", async () => {
    await clean(); const turn = await begin(await offer(f.prompt(), f.viewer));
    const me = await f.app.request("/api/v0/me", { headers: { authorization: `Bearer ${turn.lease.api.token}` } });
    expect(await me.json()).toMatchObject({ userId: f.viewer.id, credential: "workspace_token" });
    const absent = await f.send(f.prompt(), f.admin);
    expect(absent.status).toBe(409); expect(await absent.json()).toMatchObject({ error: { code: "agent_login_required", agent: "claude" } });
    const sentId = randomUUID();
    const sent = await f.app.request("/api/v0/sessions/chat/messages", { method: "POST",
      headers: { authorization: `Bearer ${turn.lease.api.token}`, "content-type": "application/json" },
      body: JSON.stringify({ message: "A follow-up", messageId: sentId }) });
    expect(sent.status).toBe(201);
    expect((await pool.query("SELECT creator_user_id,sender_context_id FROM cloud_v2_prompt_outbox WHERE workspace_id=$1 AND user_message_id=$2", [f.workspace.id, sentId])).rows[0])
      .toEqual({ creator_user_id: f.viewer.id, sender_context_id: turn.result.contextId });
  });

  it("uses real terminal and client lease serializers with CP-authored identities", async () => {
    await clean();
    const response = await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/connect`, "POST", { wake: false }, f.viewer, { "X-Zeros-Team-Sharing": "1" });
    expect(response.status).toBe(200);
    const grant = await f.cp.store.consumeConnectTicket((await response.json()).protocols[1].slice(7), f.workspace.id);
    const clientId = randomUUID(), handle = await f.cp.execution.clients.open(f.workspace.id, clientId, grant!);
    await f.cp.execution.clients.forward(f.workspace.id, handle.contextId, { type: "PTY_CREATE", id: "terminal-create", sessionId: "terminal" });
    const terminal = await contexts.terminalLease({ clientId, requestId: "terminal-create", terminalId: "terminal" });
    expect(terminal.userId).toBe(f.viewer.id); expect(terminal).not.toHaveProperty("agents");
    await f.cp.execution.clients.forward(f.workspace.id, handle.contextId, { type: "WORKSPACE_REQUEST", id: "write-file", op: "file.write" });
    const operation = await contexts.clientLease({ clientId, requestId: "write-file", operation: "file.write" });
    expect(operation.userId).toBe(f.viewer.id); expect(operation).not.toHaveProperty("environment");
    await contexts.retire(operation.contextId, "operation_done", 0);
    await f.cp.execution.clients.close(f.workspace.id, clientId);
    await contexts.renew(); expect(contexts.live(terminal.contextId)).toBe(true);
    await pool.query("UPDATE auth_sessions SET status='revoked',revoked_at=clock_timestamp() WHERE provider_session_id=$1", [f.viewer.authentication.sessionId]);
    await contexts.renew(); expect(contexts.live(terminal.contextId)).toBe(false);
  });

  it("keeps a real worker's open client alive through twelve renewal cycles and releases it on close", async () => {
    await clean();
    const response = await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/connect`, "POST", { wake: false }, f.viewer, { "X-Zeros-Team-Sharing": "1" });
    expect(response.status).toBe(200);
    const grant = await f.cp.store.consumeConnectTicket((await response.json()).protocols[1].slice(7), f.workspace.id);
    const clientId = randomUUID(), handle = await f.cp.execution.clients.open(f.workspace.id, clientId, grant!);
    let handlers: any, tick: (() => void) | undefined;
    const interval = globalThis.setInterval;
    vi.spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void, ms: number, ...args: unknown[]) => {
      if (ms === 10_000) tick = callback;
      return interval(callback, ms, ...args);
    }) as typeof setInterval);
    const ingress = new clients.CloudWorker({ directory, homeDirectory: directory, transport: {
      start: (value: unknown) => { handlers = value; }, send: async () => true, dispose: async () => {},
      contextRequest: (path: string, body: unknown) => worker.contextRequest(path, body),
    } });
    try {
      ingress.start();
      await handlers.frame({ t: "open", clientId, userId: handle.userId, contextId: handle.contextId });
      expect(tick).toBeTypeOf("function");
      const started = Date.now(), clock = vi.spyOn(Date, "now");
      for (let cycle = 1; cycle <= 12; cycle++) {
        clock.mockReturnValue(started + cycle * 10_000);
        const count = calls.filter(call => call.path.endsWith("/renew")).length;
        tick!();
        await expect.poll(() => calls.filter(call => call.path.endsWith("/renew") && call.status !== undefined).length).toBe(count + 1);
        expect(calls.at(-1)!.reply.leases).toEqual([{ contextId: handle.contextId, expiresAt: started + cycle * 10_000 + 30_000 }]);
      }
      await expect(f.cp.execution.clients.current(f.workspace.id, handle.contextId)).resolves.toMatchObject({ context: { user_id: f.viewer.id } });
      await f.cp.execution.clients.close(f.workspace.id, clientId);
      await handlers.frame({ t: "close", clientId });
      const count = calls.length;
      tick!(); await new Promise<void>(resolve => setImmediate(resolve));
      expect(calls).toHaveLength(count);
      expect(calls.some(call => call.path.endsWith(`/${handle.contextId}/retired`))).toBe(false);
    } finally { await ingress.dispose(); }
  });
});
