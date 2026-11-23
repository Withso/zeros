import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Gate0Failure } from "../gate0.js";
import { signInAccount, signInAll, transportCode, type SignInDeps } from "./accounts.js";
import { FakeAlpha } from "../__fixtures__/rehearsal-alpha-fake.js";
import { REHEARSAL_READS } from "../__fixtures__/rehearsal-reads.js";
import { shiftClock } from "./clock.js";
import { RehearsalFailure, type Database, type RehearsalState, type StageName } from "./contract.js";
import { assertRepository, safeLine } from "./guard.js";
import { accountLines, turnLine, PERSONAL_ROUTE_GAPS, preconditionLines, readAccount, refusal, writeLines, type PreconditionFacts } from "./plan.js";
import { cleanup, cleanupNeedsAccount, inventoryLines, NO_ACCOUNT, readInventory, runStages, stageContext, timingLines } from "./runner.js";
import { parseArguments, sharedBaseFacts, targetPorts } from "./rehearsal-cli.js";
import { CONNECT_CLIENT_FEATURES, call, until, checkText, connectWorkspace, createProject, createWorkspace, fileTarget, frameCode, openBridge, waitState, writeFile } from "./steps.js";
import { FIXTURE_TWO } from "./stage-provision.js";
import { loadState, newState, saveState, stateTarget } from "./state.js";
import { localStack } from "./local-stack.js";
import { agentCredentialsFromEnv, ALPHA_TARGET, NETWORK_RETRY_MS, networkRetries, checkGithubToken, databaseErrorCode, databaseRefusal, liveApi, liveBridge, liveRelease, targetIdentity, liveDatabase, OUTSIDE_PROBE_LIMIT, SET_APP_SYSTEM, tokenLines, tokenRefusal, type DatabaseClient } from "./live.js";
import { platformOwners, probeDiagnostics, proActor, resolveProbe } from "./plan.js";

const R1 = "Withso/zeros-dev-fixture";
const TIMING = { pollMs: 30_000, stateMs: 120_000, copyMs: 120_000, turnMs: 120_000, scanMs: 300_000, archiveScanMs: 3_900_000, idleStopMs: 2_100_000,
  computerMs: 3_600_000 };

// Every fixture is public; vendor/private's repository is a public Withso fixture despite its name.
const R3 = "Withso/zeros-dev-fixture-submodules", SUBMODULE_FIXTURE = "Withso/zeros-dev-fixture-private-sub";
function setup(options: { provisioned?: boolean; owner?: "personal" | "organization"; submodules?: boolean; waiting?: FakeAlpha } = {}) {
  const alpha = new FakeAlpha([R1, ...options.provisioned === false ? [] : [FIXTURE_TWO], ...options.submodules === false ? [] : [R3, SUBMODULE_FIXTURE]]);
  const state = newState(randomUUID(), alpha.organizationId, new Date(alpha.now), options.owner ?? "organization");
  // On the Personal route the test user starts with no GitHub sign-in; setup connects one and builds the base. The probe
  // organization already has its Cloud Computer.
  if (options.owner === "personal") alpha.githubIdentity = false;
  else { alpha.computer = { active: "22222222-2222-2222-2222-222222222222", builds: [{ id: "22222222-2222-2222-2222-222222222222", state: "succeeded",
    snapshot: "zeros-probe-base", builderSandboxId: null }] }; alpha.snapshots.add("zeros-probe-base"); }
  const lines: string[] = [];
  const saved: RehearsalState[] = [];
  const ports = alpha.ports(options.waiting ? { waiting: { organizationId: options.waiting.organizationId, ports: options.waiting.ports() } } : {});
  const ctx = stageContext(ports, state, async () => { saved.push(structuredClone(state)); },
    { one: R1, two: FIXTURE_TWO, submodules: R3, submoduleFixture: SUBMODULE_FIXTURE }, TIMING, 30);
  const options_ = { switches: new Set(["projects", "personal", "retention"] as const), maxActive: 10, runCap: 30, log: (line: string) => lines.push(line) };
  return { alpha, state, ctx, lines, saved, options: options_ };
}
const EMPTY = { workspaces: 0, projects: 0, branches: 0, pulls: 0, machines: 0, objects: 0, environments: 0, githubSignIns: 0, pro: 0, computerBase: 0, installScripts: 0, agentLogins: 0,
  databaseRows: 0 };

describe("rehearsal guards", () => {
  it("refuses every repository but the fixtures, by name", () => {
    expect(assertRepository("Withso/zeros-dev-fixture")).toBe("Withso/zeros-dev-fixture");
    expect(assertRepository("Withso/zeros-dev-fixture-two")).toBe("Withso/zeros-dev-fixture-two");
    for (const refused of ["Withso/zeros", "withso/ZEROS", "Withso/zeros-dev", "someone/zeros-dev-fixture", "Withso/zeros-dev-fixture/../zeros", "Withso/zeros-dev-fixturex"])
      expect(() => assertRepository(refused), refused).toThrow(RehearsalFailure);
  });

  it("withholds any line that could carry a credential, URL, email or body", () => {
    for (const unsafe of ["see https://api-alpha.zeros.build/v1/me", "Bearer abc", "eyJhbGciOiJIUzI1NiJ9.payload", "ghs_abcdefghijklmnop", "user-1@zeros.build",
      `token ${"a".repeat(60)}`, "password=hunter2", '{"error":"x"}', "two\nlines"])
      expect(safeLine(unsafe), unsafe).toBe("line withheld (unsafe)");
    expect(safeLine("stage projects: failed copy_ready timeout")).toBe("stage projects: failed copy_ready timeout");
  });

  it("parses the command line and refuses what it does not know", () => {
    expect(parseArguments(["all", "--plan", "--switches", "projects,personal,retention"]))
      .toMatchObject({ stages: ["provision", "setup", "projects", "personal", "retention", "submodules", "waiting"], plan: true, owner: "personal", account: 2, waitingAccount: 3 });
    expect(parseArguments(["all", "--owner", "organization", "--account", "owner"])).toMatchObject({ stages: ["provision", "setup", "projects", "retention"], account: "owner" });
    expect(parseArguments(["personal", "--account", "4", "--other", "5", "--pro-actor", "3e515301"])).toMatchObject({ account: 4, other: 5, proActor: "3e515301" });
    expect(parseArguments(["retention", "--account", "3", "--run", randomUUID()])).toMatchObject({ stages: ["retention"], account: 3, waitingAccount: 4 });
    expect(parseArguments(["waiting", "--waiting-account", "5"])).toMatchObject({ stages: ["waiting"], waitingAccount: 5 });
    expect(() => parseArguments(["waiting", "--account", "5", "--waiting-account", "5"])).toThrow(RehearsalFailure);
    for (const bad of [["nope"], ["all", "--plan", "--cleanup", "--run", "x"], ["all", "--cleanup"], ["all", "--account", "11"], ["all", "--switches", "billing"],
      ["all", "--repository", "Withso/zeros"], ["all", "--owner", "team"], ["all", "--account", "4", "--other", "4"], ["all", "--pro-actor", "3E5153"]])
      expect(() => parseArguments(bad), bad.join(" ")).toThrow(RehearsalFailure);
  });
});

describe("rehearsal state file", () => {
  let directory: string;
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "rehearsal-")); });
  afterEach(() => rm(directory, { recursive: true, force: true }));

  it("is written 0600 in a 0700 directory, whole, and read back exactly", async () => {
    const state = newState(randomUUID(), randomUUID(), new Date());
    state.created.workspaces.push(randomUUID());
    const folder = join(directory, "state");
    await saveState(state, folder);
    expect((await stat(folder)).mode & 0o777).toBe(0o700);
    expect((await stat(join(folder, `${state.runId}.json`))).mode & 0o777).toBe(0o600);
    expect(await loadState(state.runId, folder)).toEqual(state);
    expect(await readFile(join(folder, `${state.runId}.json`), "utf8")).not.toMatch(/token|password|secret|@/i);
  });

  it("refuses a state that is not a run's", async () => {
    await expect(loadState("../etc/passwd", directory)).rejects.toThrow(RehearsalFailure);
    const state = newState(randomUUID(), randomUUID(), new Date());
    await expect(saveState({ ...state, prefix: "x-" }, directory)).rejects.toThrow(RehearsalFailure);
  });
});

describe("shiftClock refusals", () => {
  it("moves only this run's prefixed workspaces in its organizations, at most four, and reads the shift back", async () => {
    const { alpha, state, ctx } = setup();
    const own = await ctx.ports.api.json("POST", `/v1/cloud-v2/organizations/${state.organizationId}/cloud-projects`,
      { name: `${state.prefix}p`, level: "organization", repositories: [{ repository: R1 }] });
    const project = (own.body as { project: { id: string } }).project.id;
    const make = async (name: string) => ((await ctx.ports.api.json("POST", "/v1/cloud-v2/workspaces", { name, projectId: project, branch: name })).body as { workspace: { id: string } }).workspace.id;
    const mine = await make(`${state.prefix}w`), unprefixed = await make("someone-else"), foreign = await make(`${state.prefix}foreign`);
    alpha.workspaces.get(foreign)!.organizationId = randomUUID();
    state.created.workspaces.push(mine, unprefixed, foreign);

    await expect(shiftClock(ctx.ports.database, state, [randomUUID()], 1)).rejects.toMatchObject({ code: "not_this_run" });
    await expect(shiftClock(ctx.ports.database, state, [unprefixed], 1)).rejects.toMatchObject({ code: "refused" });
    await expect(shiftClock(ctx.ports.database, state, [foreign], 1)).rejects.toMatchObject({ code: "refused" });
    await expect(shiftClock(ctx.ports.database, state, [mine, mine], 1)).rejects.toMatchObject({ code: "too_many" });
    await expect(shiftClock(ctx.ports.database, state, [1, 2, 3, 4, 5].map(() => mine), 1)).rejects.toMatchObject({ code: "too_many" });
    for (const days of [0, -1, 91, Number.NaN]) await expect(shiftClock(ctx.ports.database, state, [mine], days)).rejects.toMatchObject({ code: "invalid_days" });
    expect(alpha.shifts).toEqual([]);
    expect(await shiftClock(ctx.ports.database, state, [mine], 1.5)).toEqual({ workspaces: 1, wakes: 0 });
    expect(alpha.shifts).toEqual([{ ids: [mine], days: 1.5 }]);
    expect(state.shifts).toBe(1);
  });
});

describe("rehearsal stages against a fake Alpha", () => {
  it("runs provision, projects and retention in order, then cleanup leaves an empty inventory", async () => {
    const { alpha, state, ctx, lines, options } = setup();
    expect(await runStages(ctx, ["provision", "projects", "retention"], options)).toBe(true);
    expect(lines.filter(line => line.startsWith("stage "))).toEqual(["stage provision: ok", "stage projects: ok", "stage retention: ok"]);
    expect(state.stages.provision?.counts).toEqual({ present: 4 });
    // Boat's record of the copy's archive is printed: its status as a note, its lifetime and attempt times as counts.
    expect(state.stages.projects?.counts).toEqual({ workspaces: 2, pulls: 2, turns: 3, copiesGone: 2, environments: 2,
      copyLifetimeSeconds: 60, copySnapshotAttemptAfterCreateSeconds: 50, copySnapshotCompletedAfterCreateSeconds: 60, copyHydrated: 1 });
    expect(state.stages.projects?.notes).toEqual(["copy_snapshot:completed", "copy_archive:completed", "turn_agent:claude", "environment:seeded"]);
    expect(state.stages.retention?.notes).toEqual(["environment_case:seeded_edited", "wake_w_snapshot:completed", "wake_k_snapshot:completed"]);
    // W opened on its own machine after the wakes' stops still holds the work written before the person's stop.
    expect(state.stages.retention?.counts).toMatchObject({ ownDiskKept: 1 });
    // Every environment this run seeded is empty again at the end of its stage.
    expect([...alpha.environments.values()].every(environment => environment.files.size === 0)).toBe(true);
    expect(state.stages.retention?.counts).toMatchObject({ restored: 1, rebuilt: 1, removal: 1 });
    // Four shifts of both workspaces, then W alone: the hour to its reopened stop's backup, and the removal.
    expect(alpha.shifts.map(shift => shift.ids.length)).toEqual([2, 2, 2, 2, 1, 1]);
    // Two copies, five workspace starts and opens in A, two copies' worth in C, C's Cloud Computer rebuild, and W's open on
    // its own machine after the wakes.
    expect(state.machineStarts).toBe(13);
    expect(state.stages.retention?.counts?.computerRebuilt).toBe(1);
    const { inventory } = await cleanup(ctx, { log: line => lines.push(line) });
    expect(inventory).toEqual(EMPTY);
    // Fixtures are never created or deleted.
    expect([...alpha.repositories.keys()].sort()).toEqual([R1, FIXTURE_TWO, R3, SUBMODULE_FIXTURE].map(name => name.toLowerCase()).sort());
    for (const line of lines) expect(safeLine(line)).toBe(line);
  });

  it("provision is check-only: a missing fixture fails it and nothing is written", async () => {
    const { alpha, ctx, options } = setup({ provisioned: false });
    expect(await runStages(ctx, ["provision"], options)).toBe(false);
    expect(ctx.state.stages.provision).toMatchObject({ step: "repository_missing", code: "create_it_by_hand" });
    expect(alpha.writes).toEqual([]);
    expect(alpha.repositories.has(FIXTURE_TWO.toLowerCase())).toBe(false);
  });

  it("skips the backup removal when S4 is not deployed, and cleanup removes the backup it leaves", async () => {
    const { alpha, ctx, options } = setup();
    alpha.s4 = false;
    expect(await runStages(ctx, ["retention"], options)).toBe(true);
    expect(ctx.state.stages.retention?.counts?.removal).toBe(0);
    expect(alpha.objects.size).toBe(1);
    expect((await cleanup(ctx, { log: () => undefined })).inventory).toEqual(EMPTY);
    expect(alpha.objects.size).toBe(0);
  });

  it("refuses a stage whose switch is not declared, a stage not written yet, and an organization over its machine cap", async () => {
    const { alpha, ctx, lines, options } = setup();
    expect(await runStages(ctx, ["projects"], { ...options, switches: new Set(["retention"] as const) })).toBe(false);
    expect(lines.at(-1)).toBe("stage projects: failed switch undeclared_projects");
    expect(await runStages(ctx, ["submodules"], options)).toBe(false);
    expect(lines.at(-1)).toBe("stage submodules: failed owner personal_route_only");
    expect(alpha.writes).toEqual([]);
    expect(await runStages(ctx, ["projects"], { ...options, maxActive: -1 })).toBe(false);
    expect(lines.at(-1)).toBe("stage projects: failed machine_cap active");
    expect(alpha.writes).toEqual([]);
  });

  it("stops at the first failure and runs no later stage", async () => {
    const { ctx, lines, options } = setup();
    ctx.ports.release = async () => false;
    expect(await runStages(ctx, ["projects", "retention"], options)).toBe(false);
    expect(lines.filter(line => line.startsWith("stage "))).toEqual(["stage projects: failed release_identity not_ready"]);
  });

  it("prints a copy archive Boat reports failed, and notes a create that fell back to a direct clone instead of passing it quietly", async () => {
    const { alpha, state, ctx, options } = setup();
    alpha.snapshotStatus = "failed"; alpha.forkFallback = true;
    expect(await runStages(ctx, ["projects"], options)).toBe(true);
    expect(state.stages.projects?.notes).toEqual(expect.arrayContaining(["copy_snapshot:failed", "fork_fallback:no_fork_record"]));
    expect(state.stages.projects?.counts).toMatchObject({ forkFallback: 1 });
  });

  it("connects a workspace of several repositories only with the desktop's client features, and names a refusal by its code", async () => {
    const { alpha, ctx } = setup();
    const project = await createProject(ctx, { name: `${ctx.state.prefix}pair`, repositories: [R1, FIXTURE_TWO] });
    const pair = await createWorkspace(ctx, { name: `${ctx.state.prefix}pair-w`, projectId: project.id, branch: `${ctx.state.prefix}pair` });
    expect((await alpha.api().json("POST", `/v1/cloud-v2/workspaces/${pair.id}/connect`, {})).body).toEqual({ error: { code: "client_update_required" } });
    expect((await connectWorkspace(alpha.api(), pair.id, "connect")).status).toBe(200);
    (await openBridge(ctx, pair.id)).close();
    // The live bridge sends exactly what the desktop sends, and a refusal says why.
    const seen: { path: string; body: unknown; headers: Record<string, string> }[] = [];
    const refusing = { json: async (_method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      seen.push({ path, body, headers });
      return { status: 409, body: { error: { code: "client_update_required", message: "Update Zeros" } } };
    } };
    await expect(liveBridge(refusing)(pair.id)).rejects.toMatchObject({ step: "connect", code: "http_409_client_update_required" });
    expect(seen).toEqual([{ path: `/v1/cloud-v2/workspaces/${pair.id}/connect?wakePolicy=explicit`, body: { wake: true },
      headers: { "X-Zeros-Client-Features": "workspace-repositories-v1", "Idempotency-Key": expect.stringMatching(/^[0-9a-f-]{36}$/) } }]);
  });

  it("reopens the bridge after an abnormal close as the desktop does, never resends an interrupted request, and names a close", async () => {
    const connects: string[] = [];
    const api = { json: async (_method: string, path: string) => { connects.push(path);
      return { status: 200, body: { url: "wss://relay.example.test/v2/cloud/workspaces/w/bridge", protocols: ["zeros.cloud.v2", `ticket.${connects.length}`] } }; } };
    type Listener = (...args: never[]) => void;
    const sockets: { readyState: number; listeners: Map<string, Listener[]>; emit(event: string, ...args: unknown[]): void }[] = [];
    let hangNext = false;
    const openProbe = async () => {
      const socket = { readyState: 1, listeners: new Map<string, Listener[]>(),
        on(event: string, listener: Listener) { this.listeners.set(event, [...this.listeners.get(event) ?? [], listener]); return this; },
        emit(event: string, ...args: unknown[]) { for (const listener of this.listeners.get(event) ?? []) (listener as (...values: unknown[]) => void)(...args); } };
      sockets.push(socket);
      const close = (code: number) => { socket.readyState = 3; socket.emit("close", code); };
      return { socket, frames: [], close: () => undefined, send: () => "id",
        request: async () => ({ type: "AGENT_SESSION_CREATED" }),
        op: async (op: string) => {
          if (hangNext) { hangNext = false; close(1006); throw new Gate0Failure(op, "bridge_closed_1006"); }
          return { ok: socket === sockets.at(-1) };
        },
        closeWith: close } as never;
    };
    const bridge = await liveBridge(api as never, 1_000, 10, openProbe)("00000000-0000-4000-8000-000000000001");
    expect(await bridge.op("chats.upsert", {})).toEqual({ ok: true });
    // The relay drops the socket (1006): the next request reconnects with a fresh ticket and goes out on the new socket.
    sockets[0]!.readyState = 3; sockets[0]!.emit("ping"); sockets[0]!.emit("close", 1006);
    expect(await bridge.op("chats.upsert", {})).toEqual({ ok: true });
    expect(connects).toHaveLength(2);
    // A close while a request is out: that request fails, named, and is not resent.
    hangNext = true;
    await expect(bridge.op("turns.list", {})).rejects.toMatchObject({ step: "turns.list", code: expect.stringMatching(/^bridge_closed_1006:open_\d+s:pings_0$/) });
    expect(connects).toHaveLength(2);
    // A refusal (4001 access_revoked) is never reopened.
    expect(await bridge.op("chats.upsert", {})).toEqual({ ok: true });
    sockets.at(-1)!.readyState = 3; sockets.at(-1)!.emit("close", 4001);
    await expect(bridge.op("chats.upsert", {})).rejects.toMatchObject({ code: expect.stringMatching(/^bridge_closed_4001:open_\d+s:pings_0$/) });
    expect(connects).toHaveLength(3);
    expect(connects.every(path => path.endsWith("/connect?wakePolicy=explicit"))).toBe(true);
  });

  it("prints each step's elapsed time as it finishes, and ends each stage with its total and slowest steps", async () => {
    const { ctx, lines, options } = setup();
    expect(await runStages(ctx, ["provision", "projects"], options)).toBe(true);
    const projects = lines.filter(line => line.startsWith("  projects "));
    expect(projects.some(line => /^ {2}projects step project_one \d+(\.\d)?s$/.test(line))).toBe(true);
    const total = projects.find(line => line.startsWith("  projects timing total "));
    expect(total).toMatch(/^ {2}projects timing total \d+(\.\d)?s over \d+ steps$/);
    const rows = projects.filter(line => /^ {2}projects timing (?!total)/.test(line));
    expect(rows.length).toBeGreaterThan(0); expect(rows.length).toBeLessThanOrEqual(5);
    // Slowest first.
    const secondsOf = (line: string) => Number(/ (\d+(?:\.\d)?)s /.exec(line)![1]);
    expect(rows.map(secondsOf)).toEqual([...rows.map(secondsOf)].sort((a, b) => b - a));
    expect(timingLines("x", [{ step: "a", ms: 2_500 }, { step: "b", ms: 61_000 }])).toEqual(["  x timing total 64s over 2 steps",
      `  x timing ${"b".padEnd(24)}    61s 96%`, `  x timing ${"a".padEnd(24)}   2.5s 4%`]);
  });

  it("--local reaches only the Dev stack: its origin, its own database, the profile's store; never PlanetScale, R2 for Alpha or Alpha's origin", async () => {
    const launcher = {
      workspace: () => ({ state: { owner: "o", status: "active", launcher: {}, ports: { api: 4100, database: 54329 },
        cloudSwitches: { CLOUD_V2_READY_COPIES_ENABLED: "true", CLOUD_V2_PERSONAL_CLOUD_ENABLED: "true", CLOUD_V2_RETENTION_ENABLED: "false", CLOUD_V2_SHARED_BASE_SNAPSHOT: "auto" } } }),
      origin: () => "https://api.o.dev.example.test",
      databaseUrl: (_w: unknown, port: number, role: string) => `postgresql://${role}:x@127.0.0.1:${port}/zeros_dev_o`,
      storage: () => ({ endpoint: "https://store.example.test", bucket: "dev", accessKeyId: "id", secretAccessKey: "secret" }),
    };
    const stack = localStack(launcher);
    // Requests go to this stack's own recorded API port on loopback; the public origin is kept for what depends on it.
    expect(stack.target).toEqual({ kind: "local", origin: "https://api.o.dev.example.test", channel: "development", loopback: "http://127.0.0.1:4100" });
    expect([...stack.switches].sort()).toEqual(["personal", "projects"]);
    // Every Alpha input is behind `need`, which throws here: none is read.
    const ports = targetPorts(stack, name => { throw new Error(`reached ${name}`); }, { client: url => {
      const opened: string[] = [];
      return { connect: async () => { opened.push(url); }, end: async () => undefined,
        query: async (text: string) => ({ rows: text.startsWith("SELECT 1") ? [{ one: 1 }] : [], rowCount: 0 }) };
    } });
    expect(ports.target).toBe(stack.target);
    expect(ports.storageConfig()).toEqual(launcher.storage());
    const database = ports.database("run");
    expect(await database.read("SELECT 1 AS one")).toEqual([{ one: 1 }]);
    await database.close();
    // The release identity and the API go to the stack's own loopback port only, and accept its own channel.
    const fetched: string[] = [];
    const fetchImpl = (async (url: string) => {
      fetched.push(String(url));
      if (!String(url).startsWith("http://127.0.0.1:4100/")) throw new Error("left the stack");
      // A Dev stack's real answer: never ready (no deployed source sha), so 503, but current migrations and a pinned worker.
      return new Response(JSON.stringify(devIdentity), { status: 503 });
    }) as typeof fetch;
    const devIdentity: Record<string, unknown> = { version: 1, ready: false, sourceSha: null, channel: "development", maintenance: false,
      migrations: { state: "current", head: "0271_x.sql", expectedHead: "0271_x.sql", manifestSha256: "c".repeat(64) },
      cloud: { enabled: true, ready: false, state: "unready" }, worker: { sha256: "b".repeat(64), sourceSha: null, sourceSha256: null, qualification: null } };
    expect(await liveRelease(fetchImpl, stack.target)).toBe(true);
    // Migrations behind, maintenance, cloud off or another channel: not ready.
    for (const change of [{ migrations: { state: "pending", head: "0270_x.sql", expectedHead: "0271_x.sql" } }, { maintenance: true },
      { cloud: { enabled: false } }, { channel: "alpha" }, { migrations: { state: "current", head: "0270_x.sql", expectedHead: "0271_x.sql" } }])
      expect(() => targetIdentity(stack.target, { ...devIdentity, ...change })).toThrow();
    // Alpha's check is unchanged: the same answer is not Alpha's.
    expect(() => targetIdentity(ALPHA_TARGET, { ...devIdentity, channel: "alpha" })).toThrow();
    await liveApi(async () => "token", fetchImpl, stack.target).json("GET", "/v1/me");
    expect(fetched.length).toBeGreaterThan(0);
    expect(fetched.every(url => url.startsWith("http://127.0.0.1:4100/"))).toBe(true);
    // Alpha's identity is refused on the local target, and the local one on Alpha's.
    expect(() => targetIdentity(stack.target, { channel: "alpha", ready: true, maintenance: false, sourceSha: "a".repeat(40),
      cloud: { enabled: true, ready: true, state: "healthy" }, worker: { sha256: "b".repeat(64) } })).toThrow();
    // A stack that is not running, or has no store in the profile, is named.
    expect(() => localStack({ ...launcher, workspace: () => null })).toThrow(expect.objectContaining({ code: "not_set_up" }));
    expect(() => localStack({ ...launcher, workspace: () => ({ state: { owner: "o", status: "active" } }) })).toThrow(expect.objectContaining({ code: "not_running" }));
    expect(() => localStack({ ...launcher, storage: () => ({}) })).toThrow(expect.objectContaining({ code: "profile_storage" }));
  });

  describe("transient network failures", () => {
    // A fetch that fails once in transport (as undici does: TypeError "fetch failed" with the code on its cause), then answers.
    const failingOnce = (code: string) => {
      const seen: { url: string; method: string }[] = [];
      const fetchImpl = (async (url: string, init?: RequestInit) => {
        seen.push({ url: String(url), method: init?.method ?? "GET" });
        if (seen.length === 1) throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as typeof fetch;
      return { seen, fetchImpl };
    };
    const waits: number[] = [];
    const sleep = async (ms: number) => { waits.push(ms); };
    beforeEach(() => { waits.length = 0; networkRetries.take(); });

    it("retries a read after a reset, counts it once, and waits 1 s", async () => {
      for (const code of ["ECONNRESET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT", "ETIMEDOUT", "EAI_AGAIN"]) {
        const { seen, fetchImpl } = failingOnce(code);
        expect(await liveApi(async () => "token", fetchImpl, ALPHA_TARGET, sleep).json("GET", "/v1/me")).toEqual({ status: 200, body: { ok: true } });
        expect(seen.length).toBe(2);
      }
      expect(waits).toEqual(Array(6).fill(1_000));
      expect(networkRetries.take()).toBe(6);
      expect(networkRetries.take()).toBe(0);
    });

    it("gives up after four tries, 1, 3 and 9 s apart, named by the transport code", async () => {
      const fetchImpl = (async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }); }) as unknown as typeof fetch;
      const api = liveApi(async () => "token", fetchImpl, ALPHA_TARGET, sleep);
      await expect(call(api, "GET", "/v1/me", "me")).rejects.toMatchObject({ step: "me", code: "network:ECONNRESET" });
      expect(waits).toEqual([...NETWORK_RETRY_MS]);
      expect(networkRetries.take()).toBe(3);
    });

    it("never repeats a write a reset interrupted mid-request: it fails as before, named", async () => {
      const { seen, fetchImpl } = failingOnce("ECONNRESET");
      const api = liveApi(async () => "token", fetchImpl, ALPHA_TARGET, sleep);
      await expect(call(api, "POST", "/v1/cloud-v2/workspaces", "create", {})).rejects.toMatchObject({ step: "create", code: "network:ECONNRESET" });
      expect(seen.length).toBe(1);
      expect(networkRetries.take()).toBe(0);
    });

    it("repeats a write that never left (a connect-phase failure)", async () => {
      for (const code of ["ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT", "EAI_AGAIN"]) {
        const { seen, fetchImpl } = failingOnce(code);
        expect((await liveApi(async () => "token", fetchImpl, ALPHA_TARGET, sleep).json("POST", "/v1/cloud-v2/workspaces", {})).status).toBe(200);
        expect(seen.map(item => item.method)).toEqual(["POST", "POST"]);
      }
      expect(networkRetries.take()).toBe(3);
    });

    it("repeats a write idempotent by its own key, as the connect-ticket request is", async () => {
      const { seen, fetchImpl } = failingOnce("ECONNRESET");
      const api = liveApi(async () => "token", fetchImpl, ALPHA_TARGET, sleep);
      expect((await call(api, "POST", "/v1/cloud-v2/workspaces/w/connect", "connect", {}, { headers: { "Idempotency-Key": "k" } })).status).toBe(200);
      expect(seen.length).toBe(2);
      expect(networkRetries.take()).toBe(1);
    });

    it("a poll takes a read that failed in transport as not yet", async () => {
      let reads = 0;
      const clock = { now: () => 0, sleep: async () => undefined };
      const value = await until({ ports: { clock } } as never, "wait", 60_000, 1_000, async () => {
        reads++;
        if (reads === 1) throw new RehearsalFailure("read", "network:ECONNRESET");
        return "ready";
      });
      expect(value).toBe("ready"); expect(reads).toBe(2);
      // Anything else still fails the poll at once.
      await expect(until({ ports: { clock } } as never, "wait", 60_000, 1_000, async () => { throw new RehearsalFailure("read", "http_500"); }))
        .rejects.toMatchObject({ code: "http_500" });
    });

    it("repeats the bridge open after it fails, with a fresh ticket, and opens loopback of the stack's own port with --local", async () => {
      const { seen, fetchImpl } = failingOnce("ECONNRESET");
      const tickets: number[] = [];
      const api: Parameters<typeof liveBridge>[0] = { json: async (method, path, body, headers) => {
        if (path.includes("/connect")) { tickets.push(tickets.length);
          return { status: 200, body: { url: "wss://api.o.dev.example.test/v1/cloud-v2/bridge/w", protocols: ["zeros.cloud.v2", `ticket.${tickets.length}`] } }; }
        return liveApi(async () => "token", fetchImpl, ALPHA_TARGET, sleep).json(method, path, body, headers);
      } };
      const opened: string[] = [];
      const socket = { readyState: 1, on: () => socket };
      const openProbe = async (ticket: { url: string }) => {
        opened.push(ticket.url);
        if (opened.length === 1) throw new Gate0Failure("bridge_open", "connect_failed");
        return { socket, op: async () => ({}), request: async () => ({}), send: () => undefined, frames: [], close: () => undefined } as never;
      };
      await liveBridge(api, 1_000, 10, openProbe, { loopback: "http://127.0.0.1:4100", sleep })("w");
      expect(tickets.length).toBe(2);
      expect(opened).toEqual(["ws://127.0.0.1:4100/v1/cloud-v2/bridge/w", "ws://127.0.0.1:4100/v1/cloud-v2/bridge/w"]);
      expect(waits).toEqual([1_000]);
      expect(networkRetries.take()).toBe(1);
      expect(seen.length).toBe(0);
    });

    it("prints each stage's network retries at its end", async () => {
      const { ctx, lines, options } = setup();
      // Retries from before the stage are taken and dropped; the stage's own are printed once, at its end.
      let calls = 0;
      ctx.ports.networkRetries = () => calls++ === 0 ? 5 : 2;
      expect(await runStages(ctx, ["provision"], options)).toBe(true);
      expect(lines.filter(line => line.includes("network retries"))).toEqual(["  provision network retries 2"]);
    });
  });

  it("refuses a state file from the other target, and records the target on a new one", async () => {
    expect(stateTarget(newState(randomUUID(), randomUUID(), new Date(), "personal", "local"))).toBe("local");
    const old = newState(randomUUID(), randomUUID(), new Date(), "personal");
    delete (old as { target?: string }).target;
    expect(stateTarget(old)).toBe("alpha");
  });

  it("declares on connect exactly the client features today's desktop declares, by the protocol's constants", async () => {
    const root = new URL("../../../../../", import.meta.url).pathname;
    const desktop = await readFile(join(root, "apps/desktop/src/renderer/platform/cloud-v2.ts"), "utf8");
    const protocol = await readFile(join(root, "packages/protocol/src/cloud-v2-relay.ts"), "utf8");
    const connect = desktop.slice(desktop.indexOf("export async function connectCloudV2Workspace"));
    const names = /clientFeatures: \[([^\]]*)\]/.exec(connect)?.[1]?.split(",").map(name => name.trim()).filter(Boolean) ?? [];
    const alias = (name: string) => new RegExp(`export const ${name} = ([A-Z_]+);`).exec(desktop)?.[1] ?? name;
    const value = (name: string) => new RegExp(`export const ${alias(name)} = "([^"]+)";`).exec(protocol)?.[1];
    expect(names.length).toBeGreaterThan(0);
    expect(names.map(value)).toEqual([...CONNECT_CLIENT_FEATURES]);
  });

  it("addresses a file in the second repository as the desktop does, and names a reply of another kind", async () => {
    const { ctx } = setup();
    const project = await createProject(ctx, { name: `${ctx.state.prefix}files`, repositories: [R1, FIXTURE_TWO] });
    const pair = await createWorkspace(ctx, { name: `${ctx.state.prefix}files-w`, projectId: project.id, branch: `${ctx.state.prefix}files` });
    const second = pair.repositories!.find(row => row.repository === FIXTURE_TWO)!;
    const bridge = await openBridge(ctx, pair.id), scope = { workspaceId: pair.id, cwd: "/home/user/p" };
    const path = `${second.checkoutPath}/x.txt`;
    // As run b7a1fa7b sent it: the project folder as cwd and the path absolute, served by the first repository.
    await expect(writeFile(bridge, scope, path, "x\n", "write_old")).rejects.toMatchObject({ step: "write_old", code: "reply:error" });
    expect(fileTarget(scope, path, pair)).toEqual({ workspaceId: pair.id, repository: FIXTURE_TWO, path: "x.txt" });
    await writeFile(bridge, scope, path, "x\n", "write", pair);
    await checkText(bridge, scope, path, "x\n", "read", "content", pair);
    await expect(checkText(bridge, scope, `${second.checkoutPath}/absent.txt`, "x", "read_absent", "content", pair)).rejects.toMatchObject({ code: "reply:error" });
    bridge.close();
  });

  it("seeds an environment an earlier run's cleanup left empty at a revision above 0, and never one that holds anything", async () => {
    const { alpha, state, ctx, options } = setup();
    for (const repository of [R1, FIXTURE_TWO]) alpha.environments.set(alpha.repositoryId(repository), { revision: 4, files: new Map() });
    expect(await runStages(ctx, ["projects"], options)).toBe(true);
    expect(state.stages.projects?.notes).toContain("environment:seeded");
  });

  it("names a session reply that is not a session by its type and code, closed values only", async () => {
    const { alpha, ctx, lines, options } = setup();
    alpha.sessionReply = { type: "ERROR", code: "agent_credential_missing", message: "secret-ish text" };
    expect(await runStages(ctx, ["projects"], options)).toBe(false);
    expect(lines.filter(line => line.startsWith("stage "))).toEqual(["stage projects: failed turn_claude_session frame:ERROR:agent_credential_missing"]);
    expect(frameCode({ type: "AGENT_ERROR", error: { code: "auth failed: token=abc" } })).toBe("frame:AGENT_ERROR:other");
    expect(frameCode({ type: "AGENT_PROMPT_COMPLETE" })).toBe("frame:AGENT_PROMPT_COMPLETE");
  });

  it("skips and counts every turn when the account has no connected agent, never passing one", async () => {
    const { alpha, state, ctx, options } = setup();
    alpha.agentConnections = [];
    expect(await runStages(ctx, ["projects"], options)).toBe(true);
    expect(state.stages.projects?.notes).toContain("turn_skipped:no_agent_credential");
    expect(state.stages.projects?.counts).toMatchObject({ turns: 0, turnsSkipped: 3 });
    expect(alpha.turns).toEqual([]);
  });

  it("runs the first turn once per connected agent, in the order claude, codex, cursor, and the rewind on the first", async () => {
    const { alpha, state, ctx, options } = setup();
    alpha.agentConnections = ["cursor", "codex"];
    expect(await runStages(ctx, ["projects"], options)).toBe(true);
    expect(state.stages.projects?.notes).toEqual(expect.arrayContaining(["turn_agent:codex", "turn_agent:cursor"]));
    expect(state.stages.projects?.counts).toMatchObject({ turns: 4 });
    expect(alpha.turns.map(turn => turn.chatId).slice(0, 2)).toEqual([`${state.prefix}chat-ok-codex`, `${state.prefix}chat-ok-cursor`]);
  });

  it("says in --plan which agent runs the turns, or that they are skipped and what would cover them", () => {
    const base = { label: "2", organizations: [], admin: false, connections: { organization: 0, personal: 0, logins: [] }, activeMachines: 0,
      fixtureConnection: false, githubIdentity: false, pro: true, personal: { id: "p", seat: "pro" } };
    expect(turnLine({ ...base, agents: { personal: ["claude"], probe: null } }, "personal", "2"))
      .toBe("turns: claude (connected) for account 2 in its Personal organization; the first turn runs once per agent, the rewind on claude");
    expect(turnLine({ ...base, agents: { personal: [], probe: null } }, "personal", "2")).toMatch(/^turns: none connected .*turn_skipped:no_agent_credential.*connect a Claude, Codex or Cursor credential/);
    expect(turnLine({ ...base, agents: { personal: [], probe: null } }, "organization", "2")).toBe("turns: unknown (account 2's agent connections in the probe organization unread)");
    expect(turnLine({ failed: "sign_in:http_401" }, "personal", "2")).toBe("turns: unknown (account 2 unread: sign_in:http_401)");
  });

  it("notes a create whose fork lacked a checkout (the copy distrusted and cloned directly), and the copy's archive record", async () => {
    const { alpha, state, ctx, options } = setup();
    alpha.copyDistrusted = true; alpha.copyArchive = "completed";
    expect(await runStages(ctx, ["projects"], options)).toBe(true);
    expect(state.stages.projects?.notes).toEqual(expect.arrayContaining(["copy_archive:completed", "fork_fallback:copy_distrusted"]));
    expect(state.stages.projects?.notes).not.toContain("fork_fallback:not_a_fork");
    expect(state.stages.projects?.counts).toMatchObject({ forkFallback: 1 });
  });

  it("stops creating machines at the run's cap", async () => {
    const { alpha, state } = setup();
    const ctx = stageContext(alpha.ports(), state, async () => undefined, { one: R1, two: FIXTURE_TWO }, TIMING, 3);
    const lines: string[] = [];
    expect(await runStages(ctx, ["projects"], { switches: new Set(["projects"] as const), maxActive: 10, runCap: 3, log: line => lines.push(line) })).toBe(false);
    expect(lines.filter(line => line.startsWith("stage ")).at(-1)).toMatch(/^stage projects: failed machine_cap run_cap$/);
    expect(state.machineStarts).toBe(3);
    expect((await cleanup(ctx, { log: () => undefined })).inventory).toEqual(EMPTY);
  });

  for (const [stage, owner, prelude] of [["projects", "organization", []], ["retention", "organization", []], ["setup", "personal", []],
    ["personal", "personal", ["setup"]], ["submodules", "personal", ["setup"]]] as [StageName, "personal" | "organization", StageName[]][]) {
    it(`cleanup after a failure at any step of ${stage} (${owner} route) leaves an empty inventory`, async () => {
      const clean = setup({ owner });
      expect(await runStages(clean.ctx, prelude, clean.options)).toBe(true);
      const offset = clean.alpha.calls;
      expect(await runStages(clean.ctx, [stage], clean.options)).toBe(true);
      const total = clean.alpha.calls - offset;
      expect(total).toBeGreaterThan(5);
      let failed = 0;
      for (let at = 1; at <= total; at++) for (const after of [false, true]) {
        const { alpha, ctx, lines, options } = setup({ owner });
        expect(await runStages(ctx, prelude, options)).toBe(true);
        alpha.fault = { at: alpha.calls + at, after };
        const passed = await runStages(ctx, [stage], options);
        alpha.fault = undefined;
        if (passed) continue;
        failed++;
        const failure = lines.filter(line => line.startsWith("stage ")).at(-1);
        expect(failure, `call ${at}${after ? " after" : ""}`).toMatch(/^stage \w+: failed \S+ \S+$/);
        const { inventory } = await cleanup(ctx, { log: () => undefined });
        expect(inventory, `call ${at}${after ? " after" : ""}: ${failure}`).toEqual(EMPTY);
      }
      // Nearly every injected fault fails the stage (a read the stage tolerates, such as a missing file, may not).
      expect(failed).toBeGreaterThan(total);
    }, 120_000);
  }

  it("prints the inventory by kind and names what remains", async () => {
    const { ctx } = setup();
    const inventory = await readInventory(ctx, true);
    expect(inventoryLines(inventory)).toEqual({ clean: true, lines: [...Object.keys(EMPTY).map(kind => `inventory ${kind} 0`), "inventory clean"] });
    expect(inventoryLines({ ...inventory, machines: 2, pulls: 1 }).lines.at(-1)).toBe("inventory remaining: pulls, machines");
  });
});

describe("rehearsal environments and the worker-off record", () => {
  it("never overwrites an account's environment: an existing one skips seeding, and retention uses a hand-made ignored file", async () => {
    const { alpha, state, ctx, options } = setup();
    alpha.environments.set(alpha.repositoryId(R1), { revision: 3, files: new Map([[".env", "theirs"]]) });
    expect(await runStages(ctx, ["projects", "retention"], options)).toBe(true);
    expect(state.stages.projects?.notes).toEqual(["copy_snapshot:completed", "copy_archive:completed", "turn_agent:claude", "environment_skipped:environment_exists"]);
    expect(state.stages.projects?.counts?.environments).toBeUndefined();
    expect(state.stages.retention?.notes).toEqual(["environment_case:hand_made_ignored", "environment_skipped:environment_exists", "wake_w_snapshot:completed", "wake_k_snapshot:completed"]);
    expect(alpha.environments.get(alpha.repositoryId(R1))).toEqual({ revision: 3, files: new Map([[".env", "theirs"]]) });
    expect(state.created.environments).toEqual([]);
    expect((await cleanup(ctx, { log: () => undefined })).inventory).toEqual(EMPTY);
  });

  it("skips seeding when a repository does not ignore .env", async () => {
    const { alpha, state, ctx, options } = setup();
    alpha.ignoresEnv = false;
    expect(await runStages(ctx, ["projects"], options)).toBe(true);
    expect(state.stages.projects?.notes).toEqual(["copy_snapshot:completed", "copy_archive:completed", "turn_agent:claude", "environment_skipped:path_not_ignored"]);
    expect(alpha.writes.filter(write => write.startsWith("PATCH"))).toEqual([]);
  });

  it("cleanup clears an environment a failed stage seeded", async () => {
    const { alpha, ctx, options } = setup();
    // Fail the stage right after both seeds: at the second workspace create, which follows them.
    let calls = 0;
    const api = ctx.ports.api;
    ctx.ports.api = { json: async (method, path, body, headers) => {
      if (method === "POST" && path === "/v1/cloud-v2/workspaces" && ++calls === 2) throw new Error("lost");
      return api.json(method, path, body, headers);
    } };
    expect(await runStages(ctx, ["projects"], options)).toBe(false);
    expect([...alpha.environments.values()].some(environment => environment.files.size > 0)).toBe(true);
    ctx.ports.api = api;
    expect((await cleanup(ctx, { log: () => undefined })).inventory).toEqual(EMPTY);
    expect([...alpha.environments.values()].every(environment => environment.files.size === 0)).toBe(true);
  });

  it("fails the stop when the row does not record the worker unit verified off", async () => {
    const { alpha, ctx, lines, options } = setup();
    alpha.workerOff = false;
    expect(await runStages(ctx, ["retention"], options)).toBe(false);
    expect(lines).toContain("stage retention: failed stop_worker_off unverified");
    expect(ctx.state.stages.retention).toMatchObject({ ok: false, step: "stop_worker_off", code: "unverified" });
  });
});

describe("rehearsal reads: every statement is in the read-role test's catalog", () => {
  it("lists each statement the stages, cleanup and --plan's readers send", async () => {
    const normal = (text: string) => text.replace(/\s+/g, " ").trim();
    const catalog = new Set(REHEARSAL_READS.map(entry => normal(entry.text)));
    const seen = new Set<string>();
    // Every stage on the Personal route, then cleanup, against the fake.
    const three = new FakeAlpha([R1]); three.githubIdentity = false;
    const { alpha, ctx, options } = setup({ owner: "personal", waiting: three });
    expect(await runStages(ctx, ["provision", "setup", "projects", "personal", "retention", "submodules", "waiting"],
      { ...options, switches: new Set(["projects", "personal", "retention"] as const) })).toBe(true);
    await cleanup(ctx, { log: () => undefined });
    for (const text of [...alpha.readTexts, ...three.readTexts]) seen.add(normal(text));
    // --plan's readers, through a database that records what it is asked.
    const recording: Database = { read: async text => { seen.add(normal(text)); return [{ id: "abcdef12-0000-0000-0000-000000000000", present: true, n: 0 }]; },
      transaction: async () => { throw new Error("no writes"); }, close: async () => {} };
    await platformOwners(recording);
    await resolveProbe(recording, "probe").catch(() => undefined);
    await proActor(recording, "abcdef12");
    await probeDiagnostics(recording, randomUUID(), randomUUID());
    await sharedBaseFacts(recording, "b".repeat(64), async () => true);
    const missing = [...seen].filter(text => !catalog.has(text));
    expect(missing).toEqual([]);
    expect(seen.size).toBeGreaterThan(15);
  });
});

describe("rehearsal database roles", () => {
  /** A PlanetScale and a Postgres that record what was asked of them. */
  function provider(custom?: () => DatabaseClient) {
    const requests: { method: string; path: string; body?: unknown }[] = [], statements: string[] = [];
    let next = 0;
    const live = new Set<string>();
    const planetScale = async (method: "GET" | "POST" | "DELETE", path: string, body?: unknown) => {
      requests.push({ method, path, ...(body === undefined ? {} : { body }) });
      if (path === "/databases/alpha") return { status: 200, body: { default_branch: "main" } };
      if (method === "POST") { const id = `role-${++next}`; live.add(id); return { status: 201, body: { id, name: "n", username: "u", password: "p", access_host_url: "h.example" } }; }
      const id = path.split("/").at(-1)!;
      if (method === "DELETE") { live.delete(id); return { status: 204, body: null }; }
      return { status: live.has(id) ? 200 : 404, body: null };
    };
    const client = (): DatabaseClient => ({
      connect: async () => undefined, end: async () => undefined,
      query: async text => { statements.push(text); return { rows: text.includes("session_user") ? [{ name: "u.routing" }] : [{ id: "abcdef12-0000-0000-0000-000000000000" }], rowCount: 1 }; },
    });
    const database = liveDatabase({ organization: "o", database: "alpha", tokenId: "t", token: "t", roleName: kind => `r-${kind}`, planetScale,
      client: custom ?? client, sleep: async () => undefined });
    const inherited = () => requests.filter(request => request.method === "POST").map(request => (request.body as { inherited_roles: string[] }).inherited_roles);
    return { database, requests, statements, live, inherited };
  }

  it("reads through a pg_read_all_data role, app.system set by its own statement first, never postgres, and deletes it at close", async () => {
    const { database, statements, live, inherited } = provider();
    expect(await platformOwners(database)).toEqual(["abcdef12"]);
    await database.read("SELECT 1 AS one");
    expect(inherited()).toEqual([["pg_read_all_data"]]);
    expect(statements).toContain("BEGIN READ ONLY");
    // Each read: BEGIN READ ONLY, then set_config as its own statement, then the text itself, unwrapped.
    expect(statements.filter(text => text.includes("CROSS JOIN LATERAL") || text.includes("MATERIALIZED"))).toEqual([]);
    const read = statements.indexOf("SELECT 1 AS one");
    expect(statements.slice(read - 2, read + 1)).toEqual(["BEGIN READ ONLY", SET_APP_SYSTEM, "SELECT 1 AS one"]);
    expect(statements.filter(text => text === SET_APP_SYSTEM)).toHaveLength(2);
    expect(statements.some(text => text.startsWith("GRANT"))).toBe(false);
    expect(live.size).toBe(1);
    await database.close();
    expect(live.size).toBe(0);
  });

  it("retries a role PlanetScale's API refuses with 429 or 5xx, bounded, under a new name each time; never another status", async () => {
    let refusals = 2, names: string[] = [];
    const statuses = (status: number) => async (method: "GET" | "POST" | "DELETE", path: string, body?: unknown) => {
      if (path === "/databases/alpha") return { status: 200, body: { default_branch: "main" } };
      if (method === "POST") {
        names.push((body as { name: string }).name);
        if (refusals-- > 0) return { status, body: { code: "unavailable" } };
        return { status: 201, body: { id: "role-1", name: "n", username: "u", password: "p", access_host_url: "h.example" } };
      }
      return { status: method === "DELETE" ? 204 : 404, body: null };
    };
    const client = (): DatabaseClient => ({ connect: async () => undefined, end: async () => undefined, query: async () => ({ rows: [{ one: 1 }], rowCount: 1 }) });
    let n = 0;
    const make = (status: number) => liveDatabase({ organization: "o", database: "alpha", tokenId: "t", token: "t", roleName: kind => `r-${kind}-${++n}`,
      planetScale: statuses(status), client, sleep: async () => undefined });
    expect(await make(503).read("SELECT 1 AS one")).toEqual([{ one: 1 }]);
    expect(names).toEqual(["r-read-1", "r-read-2", "r-read-3"]);
    refusals = 10; names = [];
    await expect(make(503).read("SELECT 1 AS one")).rejects.toMatchObject({ step: "database_read_role", code: "http_503" });
    expect(names).toHaveLength(4);
    refusals = 1; names = [];
    await expect(make(403).read("SELECT 1 AS one")).rejects.toMatchObject({ code: "http_403" });
    expect(names).toHaveLength(1);
  });

  it("mints a postgres role only for a write transaction, grants zeros_app to its session user, and deletes it before returning", async () => {
    const { database, statements, live, inherited } = provider();
    expect(await database.transaction(async query => { expect(live.size).toBe(1); return (await query("SELECT 2")).rowCount; })).toBe(1);
    expect(inherited()).toEqual([["postgres"]]);
    expect(statements).toContain('GRANT zeros_app TO "u.routing"');
    expect(live.size).toBe(0);
    await expect(database.transaction(async () => { throw new RehearsalFailure("work", "failed"); })).rejects.toMatchObject({ code: "failed" });
    expect(live.size).toBe(0);
    expect(statements).toContain("ROLLBACK");
  });

  it("names a database failure by SQLSTATE only, and replaces a dropped read connection once", async () => {
    expect(databaseErrorCode({ code: "42501", message: "permission denied for table users" })).toBe("sqlstate_42501");
    expect(databaseErrorCode({ code: "57P01" })).toBe("connection");
    expect(databaseRefusal({ code: "23514", message: "cloud_creator_ineligible" })).toBe("sqlstate_23514:cloud_creator_ineligible");
    expect(databaseRefusal({ code: "P0001", message: "seat refresh scope changed" })).toBe("sqlstate_P0001:seat_refresh_scope_changed");
    expect(databaseRefusal({ code: "23505", constraint: "account_entitlements_pkey", message: "duplicate key value violates unique constraint \"x\"" }))
      .toBe("sqlstate_23505:account_entitlements_pkey");
    expect(databaseRefusal({ code: "23514", message: "new row for relation \"account_entitlements\" violates check constraint" })).toBe("sqlstate_23514");
    expect(databaseRefusal({ code: "P0001", message: "user a@b.c is not allowed" })).toBe("sqlstate_P0001");
    expect(databaseRefusal(new Error("something else"))).toBeNull();
    expect(databaseErrorCode({ code: "08006" })).toBe("connection");
    expect(databaseErrorCode(new Error("read ECONNRESET"))).toBe("connection");
    let dropped = false;
    const { database: flaky, live, inherited } = provider(() => ({ connect: async () => undefined, end: async () => undefined,
      query: async text => {
        if (text === "SELECT 1 AS one" && !dropped) { dropped = true; throw Object.assign(new Error("terminated"), { code: "57P01" }); }
        return { rows: [{ one: 1 }], rowCount: 1 };
      } }));
    expect(await flaky.read("SELECT 1 AS one")).toEqual([{ one: 1 }]);
    // Two read roles minted, the first deleted when its connection dropped.
    expect(inherited()).toEqual([["pg_read_all_data"], ["pg_read_all_data"]]);
    expect(live.size).toBe(1);
    await flaky.close();
    expect(live.size).toBe(0);
    // A refused query is not retried: its SQLSTATE is the code.
    const { database: refused, inherited: once } = provider(() => ({ connect: async () => undefined, end: async () => undefined,
      query: async text => { if (text === "SELECT 1") throw Object.assign(new Error("permission denied"), { code: "42501" }); return { rows: [], rowCount: 0 }; } }));
    await expect(refused.read("SELECT 1")).rejects.toMatchObject({ step: "database", code: "sqlstate_42501" });
    expect(once()).toHaveLength(1);
  });

  it("stage A never asks for a write; stage C's only writes are its shifts", async () => {
    const projects = setup();
    expect(await runStages(projects.ctx, ["projects"], projects.options)).toBe(true);
    expect(projects.alpha.transactions).toBe(0);
    const retention = setup();
    expect(await runStages(retention.ctx, ["retention"], retention.options)).toBe(true);
    expect(retention.alpha.transactions).toBe(retention.alpha.shifts.length);
  });
});

describe("rehearsal on the Personal route", () => {
  const all = { switches: new Set(["projects", "personal", "retention"] as const) };

  it("runs provision, setup, projects, personal and retention in the test user's Personal organization, then cleanup restores everything", async () => {
    const { alpha, state, ctx, lines, options } = setup({ owner: "personal" });
    expect(await runStages(ctx, ["provision", "setup", "projects", "personal", "retention"], { ...options, ...all })).toBe(true);
    expect(lines.filter(line => line.startsWith("stage "))).toEqual(["stage provision: ok", "stage setup: ok", "stage projects: ok", "stage personal: ok", "stage retention: ok"]);
    expect(ctx.projectLevel).toBe("personal");
    // Setup presses no Build: the organization has no base yet, and the first project makes Zeros prepare one.
    expect(state.stages.setup?.counts).toEqual({ proChanges: 1, githubSignIn: 1, baseReadyAtSetup: 0 });
    expect(state.stages.setup?.notes).toEqual(["cloud_computer:base_none"]);
    expect(alpha.writes.some(write => write.includes("/computer/builds") && !write.startsWith("POST /v1/cloud-v2/organizations/:id/computer/builds"))).toBe(false);
    expect(state.created.bases).toHaveLength(1);
    // Pro ended: the machine stopped after the 20-minute idle stop; four reads and the list were hidden from the second user.
    expect(state.stages.personal?.counts).toMatchObject({ workspaces: 1, hiddenReads: 9, minutesToStop: 20 });
    expect(state.stages.personal?.notes).toEqual(["worker_token:not_observable"]);
    expect(alpha.proChanges.map(grant => grant.enabled)).toEqual([true, false, true]);
    expect(alpha.writes.filter(write => write.startsWith("other"))).toEqual([]);
    expect(state.created.githubSignIns).toEqual([alpha.organizationId]);
    const { inventory } = await cleanup(ctx, { log: line => lines.push(line) });
    expect(inventory).toEqual(EMPTY);
    // Pro is back to "none" (the grant ends; there was none before), the token sign-in is gone, and the base this run built
    // is no longer live, its Boat named snapshot deleted (the build row stays, as history).
    expect(alpha.pro()).toBe(false);
    expect(alpha.patConnected).toBe(false);
    expect(alpha.computer.active).toBeNull();
    expect(alpha.snapshots.size).toBe(0);
    // The automatic base the first project caused, and retention's rebuild; both build rows stay, as history.
    expect(alpha.computer.builds).toHaveLength(2);
    for (const line of lines) expect(safeLine(line)).toBe(line);
  });

  it("rehearses submodules: the copy fetched both, the forked workspace holds both at their commits, the token sign-in named", async () => {
    const { ctx, state, options } = setup({ owner: "personal" });
    expect(await runStages(ctx, ["setup", "submodules"], { ...options, ...all })).toBe(true);
    expect(state.stages.submodules?.counts).toEqual({ copyFetched: 2, copyPublic: 2, workspaceFetched: 2, workspaceInitialized: 2 });
    // There is no private submodule fixture: reported, not failed.
    expect(state.stages.submodules?.notes).toEqual(["private_submodule:not_rehearsed_no_fixture"]);
    expect((await cleanup(ctx, { log: () => undefined })).inventory).toEqual(EMPTY);
  });

  it("refuses submodules until its fixtures exist, and off the Personal route", async () => {
    const missing = setup({ owner: "personal", submodules: false });
    expect(await runStages(missing.ctx, ["submodules"], { ...missing.options, ...all })).toBe(false);
    expect(missing.ctx.state.stages.submodules).toMatchObject({ step: "fixtures", code: "missing" });
    expect(missing.alpha.writes).toEqual([]);
    const organization = setup();
    expect(await runStages(organization.ctx, ["submodules"], organization.options)).toBe(false);
    expect(organization.ctx.state.stages.submodules).toMatchObject({ step: "owner", code: "personal_route_only" });
  });

  it("keeps the base with --keep-base, and never builds or removes a base the organization already had", async () => {
    const kept = setup({ owner: "personal" });
    expect(await runStages(kept.ctx, ["setup", "personal"], { ...kept.options, ...all })).toBe(true);
    expect(kept.ctx.state.created.bases).toHaveLength(1);
    expect((await cleanup(kept.ctx, { keepBase: true, log: () => undefined })).inventory).toEqual(EMPTY);
    expect(kept.alpha.computer.active).not.toBeNull();
    expect(kept.alpha.snapshots.size).toBe(1);
    const existing = setup({ owner: "personal" });
    existing.alpha.computer = { active: "11111111-1111-1111-1111-111111111111", builds: [{ id: "11111111-1111-1111-1111-111111111111", state: "succeeded", snapshot: "theirs", builderSandboxId: null }] };
    existing.alpha.snapshots.add("theirs");
    expect(await runStages(existing.ctx, ["setup", "personal"], { ...existing.options, ...all })).toBe(true);
    expect(existing.ctx.state.stages.setup?.counts?.baseReadyAtSetup).toBe(1);
    expect(existing.ctx.state.stages.setup?.notes).toEqual(["cloud_computer:base_ready"]);
    expect(existing.ctx.state.created.computerBuild).toBeUndefined();
    expect(existing.ctx.state.created.bases ?? []).toEqual([]);
    expect((await cleanup(existing.ctx, { log: () => undefined })).inventory).toEqual(EMPTY);
    expect(existing.alpha.computer.active).toBe("11111111-1111-1111-1111-111111111111");
    expect(existing.alpha.snapshots.has("theirs")).toBe(true);
  });

  describe("stage waiting: a create made while the base is still being prepared", () => {
    const third = () => { const three = new FakeAlpha([R1]); three.githubIdentity = false; return three; };
    const waitingAll = { switches: new Set(["projects", "personal", "retention"] as const) };

    it("waits for the automatic base, boots from it, and cleanup restores the third account and its organization", async () => {
      const three = third();
      const { ctx, state, lines, options } = setup({ owner: "personal", waiting: three });
      expect(await runStages(ctx, ["setup", "waiting"], { ...options, ...waitingAll })).toBe(true);
      expect(state.stages.waiting?.counts).toEqual({ proChanges: 1, githubSignIn: 1, createdWhilePreparing: 1, baseWaitSeconds: 300,
        waitedPastBootDeadline: 0, bootedFromBase: 1 });
      expect(state.waiting?.organizationId).toBe(three.organizationId);
      expect(state.waiting?.created.bases).toHaveLength(1);
      // Nobody pressed Build in either organization.
      expect([...three.writes].some(write => write.includes("/computer/builds"))).toBe(false);
      const { inventory, failures } = await cleanup(ctx, { log: line => lines.push(line) });
      expect({ inventory, failures }).toEqual({ inventory: EMPTY, failures: 0 });
      expect(three.pro()).toBe(false);
      expect(three.patConnected).toBe(false);
      expect(three.computer.active).toBeNull();
      expect(three.snapshots.size).toBe(0);
      for (const line of lines) expect(safeLine(line)).toBe(line);
    });

    it("names #1260's F1: a wait past the boot deadline that fails the workspace after its machine boots", async () => {
      const broken = third();
      broken.baseBuildMs = 15 * 60_000; broken.bootDeadlineFromCreate = true;
      const run = setup({ owner: "personal", waiting: broken });
      expect(await runStages(run.ctx, ["setup", "waiting"], { ...run.options, ...waitingAll })).toBe(false);
      expect(run.state.stages.waiting).toMatchObject({ step: "waiting_running", code: "state_failed:worker_boot_timeout:none" });
      expect((await cleanup(run.ctx, { log: () => undefined })).inventory).toEqual(EMPTY);
      // Fixed: the same wait passes, and the run says it passed the deadline.
      const fixed = third();
      fixed.baseBuildMs = 15 * 60_000;
      const good = setup({ owner: "personal", waiting: fixed });
      expect(await runStages(good.ctx, ["setup", "waiting"], { ...good.options, ...waitingAll })).toBe(true);
      expect(good.state.stages.waiting?.counts).toMatchObject({ baseWaitSeconds: 900, waitedPastBootDeadline: 1, bootedFromBase: 1 });
    });

    it("refuses an organization that is not fresh; with the shared base configured, its install script gives it its own base to wait for", async () => {
      const used = third();
      used.computer = { active: "33333333-3333-3333-3333-333333333333", builds: [{ id: "33333333-3333-3333-3333-333333333333", state: "succeeded", snapshot: "theirs", builderSandboxId: null }] };
      used.snapshots.add("theirs");
      const refused = setup({ owner: "personal", waiting: used });
      expect(await runStages(refused.ctx, ["setup", "waiting"], { ...refused.options, ...waitingAll })).toBe(false);
      expect(refused.state.stages.waiting).toMatchObject({ step: "waiting_fresh", code: "base_ready" });
      expect((await cleanup(refused.ctx, { log: () => undefined })).inventory).toEqual(EMPTY);
      expect(used.computer.active).toBe("33333333-3333-3333-3333-333333333333");
      // The Production configuration: the shared base is set. The main organization rides it (ready at once, no machine);
      // stage waiting's organization gets a one-line install script first, so it builds its own base and the create waits.
      const shared = third();
      shared.sharedBase = true;
      const production = setup({ owner: "personal", waiting: shared });
      production.alpha.sharedBase = true;
      expect(await runStages(production.ctx, ["setup", "personal", "waiting"], { ...production.options, ...waitingAll })).toBe(true);
      expect(production.alpha.computer.builds.filter(build => build.shared)).toHaveLength(1);
      expect(shared.computer.builds.filter(build => build.shared)).toHaveLength(0);
      expect(production.state.stages.waiting?.counts).toMatchObject({ createdWhilePreparing: 1, bootedFromBase: 1 });
      expect(shared.installScript).not.toBeNull();
      expect((await cleanup(production.ctx, { log: () => undefined })).inventory).toEqual(EMPTY);
      expect(shared.installScript).toBeNull();
      // The shared base loses only the organization's pointer: Zeros's snapshot is never deleted.
      expect(production.alpha.computer.active).toBeNull();
      expect(production.alpha.snapshots.has("zeros-shared")).toBe(true);
    });

    it("refuses setup on a server before the safe switch-on, which reports no base", async () => {
      const { alpha, ctx, state, options } = setup({ owner: "personal" });
      alpha.automaticBase = false;
      expect(await runStages(ctx, ["setup"], { ...options, ...waitingAll })).toBe(false);
      expect(state.stages.setup).toMatchObject({ step: "cloud_computer", code: "base_view_absent" });
    });

    it("cleanup after a failure at any step of waiting leaves an empty inventory", async () => {
      const probe = third();
      const clean = setup({ owner: "personal", waiting: probe });
      expect(await runStages(clean.ctx, ["setup"], { ...clean.options, ...waitingAll })).toBe(true);
      const offset = probe.calls;
      expect(await runStages(clean.ctx, ["waiting"], { ...clean.options, ...waitingAll })).toBe(true);
      const total = probe.calls - offset;
      expect(total).toBeGreaterThan(5);
      let failed = 0;
      for (let at = 1; at <= total; at++) for (const after of [false, true]) {
        const three = third();
        const { ctx, lines, options } = setup({ owner: "personal", waiting: three });
        expect(await runStages(ctx, ["setup"], { ...options, ...waitingAll })).toBe(true);
        three.fault = { at: three.calls + at, after };
        const passed = await runStages(ctx, ["waiting"], { ...options, ...waitingAll });
        three.fault = undefined;
        if (passed) continue;
        failed++;
        const failure = lines.filter(line => line.startsWith("stage ")).at(-1);
        const { inventory } = await cleanup(ctx, { log: () => undefined });
        expect(inventory, `call ${at}${after ? " after" : ""}: ${failure}`).toEqual(EMPTY);
      }
      expect(failed).toBeGreaterThan(total);
    }, 120_000);
  });

  it("fails retention when a clean open after the Cloud Computer rebuild is not rebuilt from the live build", async () => {
    const { alpha, ctx, options } = setup({ owner: "personal" });
    alpha.staleRestorePin = true;
    expect(await runStages(ctx, ["setup", "retention"], { ...options, ...all })).toBe(false);
    expect(ctx.state.stages.retention).toMatchObject({ step: "rebuilt_pin", code: "not_live_build" });
    expect((await cleanup(ctx, { log: () => undefined })).inventory).toEqual(EMPTY);
  });

  it("puts back a grant that existed before the run, exactly", async () => {
    const { alpha, ctx, options } = setup({ owner: "personal" });
    const before = { enabled: true, validFrom: new Date(alpha.now - 1e9).toISOString(), validUntil: new Date(alpha.now + 3_600_000).toISOString() };
    alpha.proGrant = { ...before };
    expect(await runStages(ctx, ["setup", "personal"], { ...options, ...all })).toBe(true);
    expect((await cleanup(ctx, { log: () => undefined })).inventory).toEqual(EMPTY);
    expect(alpha.proGrant).toEqual(before);
  });

  it("cleanup after Pro was left off turns it on to delete, then puts the grant back", async () => {
    const { alpha, ctx, options } = setup({ owner: "personal" });
    expect(await runStages(ctx, ["setup"], { ...options, ...all })).toBe(true);
    // Fail stage B just after its Pro-off change: the workspace now answers 403 pro_required.
    let changes = 0;
    const port = ctx.ports.pro!;
    ctx.ports.pro = { read: port.read, change: async (grant, reason) => { const id = await port.change(grant, reason); if (++changes === 1) throw new RehearsalFailure("injected", "fault"); return id; } };
    expect(await runStages(ctx, ["personal"], { ...options, ...all })).toBe(false);
    expect(alpha.pro()).toBe(false);
    ctx.ports.pro = port;
    expect((await cleanup(ctx, { log: () => undefined })).inventory).toEqual(EMPTY);
    expect(alpha.pro()).toBe(false);
  });

  it("cleans up again after a cleanup that ended Pro before its inventory: Pro on, sign-in off, inventory clean, Pro ended", async () => {
    const { alpha, ctx, options, state } = setup({ owner: "personal" });
    expect(await runStages(ctx, ["setup", "projects"], { ...options, switches: new Set(["projects", "personal", "retention"] as const) })).toBe(true);
    // As the failed cleanup left it: Pro put back to none (so the organization has no cloud), the sign-in still stored.
    await alpha.proPort().change({ enabled: false, validFrom: new Date(alpha.now - 60_000).toISOString(), validUntil: null }, "Alpha rehearsal: end Pro (failed cleanup)");
    state.created.pro!.operations.push(randomUUID());
    expect(alpha.pro()).toBe(false);
    expect(alpha.patConnected).toBe(true);
    expect((await alpha.api().json("GET", `/v1/cloud-v2/github/connection?organizationId=${alpha.organizationId}`)).status).toBe(404);
    const lines: string[] = [];
    const { inventory, failures } = await cleanup(ctx, { log: line => lines.push(line) });
    expect({ inventory, failures, lines }).toEqual({ inventory: EMPTY, failures: 0, lines: [] });
    expect(alpha.patConnected).toBe(false);
    expect(alpha.pro()).toBe(false);
    // Pro on for the cleanup, then back to none.
    expect(alpha.proChanges.slice(-2).map(grant => grant.enabled)).toEqual([true, false]);
  });

  it("recovers a cleanup that stopped after its sign-in was gone: the run's own sign-in back, environments cleared, then off, Pro ended", async () => {
    const { alpha, ctx, options, state } = setup({ owner: "personal" });
    expect(await runStages(ctx, ["setup", "projects"], { ...options, switches: new Set(["projects", "personal", "retention"] as const) })).toBe(true);
    expect(state.created.environments).toHaveLength(2);
    // As the failed cleanup left it: no workspace or project, Pro ended, the token sign-in disconnected, both seeded
    // environments still stored, and their routes answering 409 github_connection_required.
    for (const target of state.created.environments) alpha.environments.set(target.repositoryId, { revision: 3, files: new Map([[".env", "SEEDED=1\n"]]) });
    await alpha.proPort().change({ enabled: false, validFrom: new Date(alpha.now - 60_000).toISOString(), validUntil: null }, "Alpha rehearsal: end Pro (failed cleanup)");
    state.created.pro!.operations.push(randomUUID());
    alpha.patConnected = false;
    await alpha.proPort().change({ enabled: true, validFrom: new Date(alpha.now - 60_000).toISOString(), validUntil: null }, "Alpha rehearsal: test probe");
    const target = state.created.environments[0]!;
    expect((await alpha.api().json("GET", `/v1/cloud-v2/organizations/${state.organizationId}/environment/${target.repositoryId}?repository=${target.repository}`)).body)
      .toEqual({ error: { code: "github_connection_required" } });
    await alpha.proPort().change({ enabled: false, validFrom: new Date(alpha.now - 60_000).toISOString(), validUntil: null }, "Alpha rehearsal: test probe");
    const lines: string[] = [];
    const { inventory, failures } = await cleanup(ctx, { log: line => lines.push(line) });
    expect({ inventory, failures, lines }).toEqual({ inventory: EMPTY, failures: 0, lines: [] });
    expect([...alpha.environments.values()].map(environment => environment.files.size)).toEqual([0, 0]);
    expect(state.created.environments).toEqual([]);
    expect(alpha.patConnected).toBe(false);
    expect(alpha.pro()).toBe(false);
  });

  it("never signs in for cleanup where the run made no sign-in: the environments stay counted, never read as clean", async () => {
    const { alpha, ctx, options, state } = setup({ owner: "personal" });
    expect(await runStages(ctx, ["setup", "projects"], { ...options, switches: new Set(["projects", "personal", "retention"] as const) })).toBe(true);
    for (const target of state.created.environments) alpha.environments.set(target.repositoryId, { revision: 3, files: new Map([[".env", "SEEDED=1\n"]]) });
    state.created.githubSignIns = [];
    alpha.patConnected = false;
    const lines: string[] = [];
    const { inventory } = await cleanup(ctx, { log: line => lines.push(line) });
    expect(inventory.environments).toBe(2);
    expect(alpha.patConnected).toBe(false);
    expect(lines.filter(line => line.startsWith("cleanup environment:"))).toEqual(Array(2).fill("cleanup environment: http_409_github_connection_required"));
  });

  describe("the rehearsal's agent credential", () => {
    const SECRET = "rehearsal-synthetic-credential-0123456789";
    const credential = () => ({ provider: "claude" as const, kind: "claude-setup-token" as const, source: "ZEROS_REHEARSAL_CLAUDE_SETUP_TOKEN",
      material: () => ({ kind: "claude-setup-token", accessToken: SECRET }) });
    const switches = new Set(["projects", "personal", "retention"] as const);

    it("connects it as Settings does, runs the turns on it, and cleanup removes and revokes it, reading both back", async () => {
      const { alpha, ctx, options, state } = setup({ owner: "personal" });
      alpha.agentConnections = [];
      ctx.ports.agentCredentials = [credential()];
      expect(await runStages(ctx, ["setup", "projects"], { ...options, switches })).toBe(true);
      expect(state.stages.setup?.notes).toContain("agent_login:connected:claude");
      expect(state.stages.projects?.notes).toContain("turn_agent:claude");
      expect(state.stages.projects?.counts).toMatchObject({ turns: 3 });
      expect(state.stages.projects?.counts?.turnsSkipped).toBeUndefined();
      const [login] = state.created.agentLogins!;
      expect(alpha.agentSelections.get("claude")?.credentialId).toBe(login!.credentialId);
      const lines: string[] = [];
      const { inventory, failures } = await cleanup(ctx, { log: line => lines.push(line) });
      expect({ inventory, failures, lines }).toEqual({ inventory: EMPTY, failures: 0, lines: [] });
      expect(alpha.agentSelections.get("claude")?.credentialId).toBeNull();
      expect(alpha.agentCredentials.get(login!.credentialId)?.revoked).toBe(true);
      expect(state.created.agentLogins).toEqual([]);
      // The value reached the credential route's body and nothing else.
      expect(alpha.agentMaterialValues).toEqual([SECRET]);
      expect(JSON.stringify(state)).not.toContain(SECRET);
    });

    it("finishes a cleanup that stopped after taking it out of the organization, and a second cleanup finds nothing", async () => {
      const { alpha, ctx, options, state } = setup({ owner: "personal" });
      alpha.agentConnections = [];
      ctx.ports.agentCredentials = [credential()];
      expect(await runStages(ctx, ["setup"], { ...options, switches })).toBe(true);
      const [login] = state.created.agentLogins!;
      // As a cleanup that stopped between the two writes left it: no longer selected, not yet revoked.
      await alpha.api().json("DELETE", `/v1/organizations/${state.organizationId}/agent-connections/accounts/${login!.credentialId}`, {});
      expect((await readInventory(ctx, false, false, { pro: false })).agentLogins).toBe(1);
      for (let pass = 0; pass < 2; pass++) {
        const lines: string[] = [];
        const { inventory, failures } = await cleanup(ctx, { log: line => lines.push(line) });
        expect({ inventory, failures, lines }).toEqual({ inventory: EMPTY, failures: 0, lines: [] });
      }
      expect(alpha.agentCredentials.get(login!.credentialId)?.revoked).toBe(true);
    });

    it("leaves a connection already there alone, uses it for the turns, and keeps its own on a second setup", async () => {
      const existing = setup({ owner: "personal" });
      existing.ctx.ports.agentCredentials = [credential()];
      expect(await runStages(existing.ctx, ["setup", "projects"], { ...existing.options, switches })).toBe(true);
      expect(existing.state.stages.setup?.notes).toContain("agent_login:existing:claude");
      expect(existing.state.stages.projects?.notes).toContain("turn_agent:claude");
      expect(existing.alpha.agentCredentials.size).toBe(0);
      expect(existing.state.created.agentLogins ?? []).toEqual([]);
      expect((await cleanup(existing.ctx, { log: () => undefined })).inventory).toEqual(EMPTY);
      expect(existing.alpha.agentSelections.size).toBe(0);

      const again = setup({ owner: "personal" });
      again.alpha.agentConnections = [];
      again.ctx.ports.agentCredentials = [credential()];
      expect(await runStages(again.ctx, ["setup"], { ...again.options, switches })).toBe(true);
      again.state.stages = {};
      expect(await runStages(again.ctx, ["setup"], { ...again.options, switches })).toBe(true);
      expect(again.state.stages.setup?.notes).toContain("agent_login:kept:claude");
      expect(again.alpha.agentCredentials.size).toBe(1);
    });

    it("reads every credential .env.agent sets, one per agent in a fixed order, and a bad value fails by its name only", () => {
      expect(agentCredentialsFromEnv({})).toEqual([]);
      const picked = agentCredentialsFromEnv({ ZEROS_REHEARSAL_CURSOR_API_KEY: `key_${"c".repeat(20)}`, ZEROS_REHEARSAL_CLAUDE_API_KEY: `claude-${"k".repeat(20)}`,
        ZEROS_REHEARSAL_CLAUDE_SETUP_TOKEN: SECRET, ZEROS_REHEARSAL_OPENAI_API_KEY: `openai-${"o".repeat(20)}` });
      expect(picked.map(entry => [entry.provider, entry.kind, entry.source])).toEqual([["claude", "claude-setup-token", "ZEROS_REHEARSAL_CLAUDE_SETUP_TOKEN"],
        ["codex", "codex-api-key", "ZEROS_REHEARSAL_OPENAI_API_KEY"], ["cursor", "cursor-api-key", "ZEROS_REHEARSAL_CURSOR_API_KEY"]]);
      expect(picked[0]!.material()).toEqual({ kind: "claude-setup-token", accessToken: SECRET });
      let failure: unknown;
      try { agentCredentialsFromEnv({ ZEROS_REHEARSAL_CLAUDE_API_KEY: "short value" }); } catch (error) { failure = error; }
      expect(failure).toMatchObject({ step: "agent_credential", code: "invalid:ZEROS_REHEARSAL_CLAUDE_API_KEY" });
      expect(JSON.stringify(failure)).not.toContain("short value");
    });

    it("connects every credential set, runs the first turn on each, names a failing one by its agent, and cleanup removes all", async () => {
      const { alpha, ctx, options, state } = setup({ owner: "personal" });
      alpha.agentConnections = [];
      ctx.ports.agentCredentials = [credential(),
        { provider: "codex", kind: "codex-api-key", source: "ZEROS_REHEARSAL_OPENAI_API_KEY", material: () => ({ kind: "codex-api-key", apiKey: `${SECRET}-codex` }) },
        { provider: "cursor", kind: "cursor-api-key", source: "ZEROS_REHEARSAL_CURSOR_API_KEY", material: () => ({ kind: "cursor-api-key", apiKey: `${SECRET}-cursor` }) }];
      expect(await runStages(ctx, ["setup", "projects"], { ...options, switches })).toBe(true);
      expect(state.stages.setup?.notes).toEqual(expect.arrayContaining(["agent_login:connected:claude", "agent_login:connected:codex", "agent_login:connected:cursor"]));
      expect(state.stages.setup?.counts).toMatchObject({ agentLogins: 3 });
      expect(state.stages.projects?.notes).toEqual(expect.arrayContaining(["turn_agent:claude", "turn_agent:codex", "turn_agent:cursor"]));
      expect(state.stages.projects?.counts).toMatchObject({ turns: 5 });
      expect(state.created.agentLogins!.map(login => login.provider)).toEqual(["claude", "codex", "cursor"]);
      const lines: string[] = [];
      expect((await cleanup(ctx, { log: line => lines.push(line) }))).toEqual({ inventory: EMPTY, failures: 0 });
      expect(lines).toEqual([]);
      expect([...alpha.agentCredentials.values()].every(row => row.revoked)).toBe(true);
      expect(JSON.stringify(state)).not.toContain(SECRET);
      // A failing agent is named by its own step.
      const again = setup({ owner: "personal" });
      again.alpha.agentConnections = ["claude", "codex"];
      again.alpha.sessionReply = null;
      const original = again.alpha.bridge.bind(again.alpha);
      again.ctx.ports.bridge = async id => {
        const bridge = await original(id);
        return { ...bridge, request: (type, fields, step) => type === "AGENT_NEW_SESSION" && fields.agentId === "codex"
          ? Promise.resolve({ type: "ERROR", code: "agent_unavailable" }) : bridge.request(type, fields, step) };
      };
      expect(await runStages(again.ctx, ["setup", "projects"], { ...again.options, switches })).toBe(false);
      expect(again.state.stages.projects).toMatchObject({ step: "turn_codex_session", code: "frame:ERROR:agent_unavailable" });
    });

    it("lists in --plan every agent the first turn runs on: connected ones and the rehearsal's credentials", () => {
      const summary = { label: "2", organizations: [], admin: false, connections: { organization: 0, personal: 0, logins: [] }, activeMachines: 0,
        fixtureConnection: false, githubIdentity: false, pro: true, personal: { id: "p", seat: "pro" }, agents: { personal: [], probe: null } };
      expect(turnLine(summary, "personal", "2", ["claude", "cursor"])).toBe("turns: claude (the rehearsal's credential, connected by setup and removed by cleanup), "
        + "cursor (the rehearsal's credential, connected by setup and removed by cleanup) for account 2 in its Personal organization; the first turn runs once per agent, the rewind on claude");
      expect(turnLine({ ...summary, agents: { personal: ["codex"], probe: null } }, "personal", "2", ["claude"])).toBe("turns: claude (the rehearsal's credential, "
        + "connected by setup and removed by cleanup), codex (connected) for account 2 in its Personal organization; the first turn runs once per agent, the rewind on claude");
    });
  });

  it("names a failed workspace's error code and machine when its connect is refused or its wait sees it fail", async () => {
    const { alpha, ctx, options } = setup({ owner: "personal" });
    expect(await runStages(ctx, ["setup"], { ...options, switches: new Set(["projects", "personal", "retention"] as const) })).toBe(true);
    const project = await createProject(ctx, { name: `${ctx.state.prefix}fail`, repositories: [R1] });
    const workspace = await createWorkspace(ctx, { name: `${ctx.state.prefix}fail-w`, projectId: project.id, branch: `${ctx.state.prefix}fail` });
    const row = alpha.workspaces.get(workspace.id)!;
    Object.assign(row, { state: "failed", errorCode: "cloud_source_checkout_failed" });
    await expect(openBridge(ctx, workspace.id)).rejects.toMatchObject({ step: "connect", code: `http_409_workspace_unavailable:failed:cloud_source_checkout_failed:${row.boatSandboxId}` });
    await expect(waitState(ctx, workspace.id, "running", "probe_running")).rejects
      .toMatchObject({ code: `state_failed:cloud_source_checkout_failed:${row.boatSandboxId}` });
  });

  it("never replaces a sign-in or a grant it did not make, and refuses B before setup", async () => {
    const existing = setup({ owner: "personal" });
    existing.alpha.patConnected = true;
    expect(await runStages(existing.ctx, ["setup"], { ...existing.options, ...all })).toBe(false);
    expect(existing.ctx.state.stages.setup).toMatchObject({ step: "github_sign_in", code: "exists" });
    const foreign = setup({ owner: "personal" });
    foreign.alpha.proGrant = "foreign";
    expect(await runStages(foreign.ctx, ["setup"], { ...foreign.options, ...all })).toBe(false);
    expect(foreign.ctx.state.stages.setup).toMatchObject({ step: "pro", code: "foreign_grant" });
    expect(foreign.alpha.proChanges).toEqual([]);
    const early = setup({ owner: "personal" });
    expect(await runStages(early.ctx, ["personal"], { ...early.options, ...all })).toBe(false);
    expect(early.ctx.state.stages.personal).toMatchObject({ step: "pro", code: "run_setup_first" });
  });

  it("refuses the Personal route's stages without the personal switch, and setup on the organization route", async () => {
    const personal = setup({ owner: "personal" });
    expect(await runStages(personal.ctx, ["projects"], { ...personal.options, switches: new Set(["projects"] as const) })).toBe(false);
    expect(personal.ctx.state.stages.projects).toMatchObject({ step: "switch", code: "undeclared_personal" });
    const organization = setup({ owner: "organization" });
    expect(await runStages(organization.ctx, ["setup"], organization.options)).toBe(false);
    expect(organization.ctx.state.stages.setup).toMatchObject({ code: "organization_route_awaiting_approval" });
  });
});

describe("rehearsal without an account", () => {
  it("runs provision with nobody signed in and refuses the stages that need an account, naming why", async () => {
    const { alpha, state, ctx, lines, options } = setup();
    ctx.ports.api = NO_ACCOUNT;
    expect(await runStages(ctx, ["provision", "projects"], { ...options, accountUnavailable: "sign_in:http_429_rate_limit_exceeded" })).toBe(false);
    expect(lines.filter(line => line.startsWith("stage "))).toEqual(["stage provision: ok",
      "stage projects: failed account_unavailable sign_in:http_429_rate_limit_exceeded"]);
    expect(alpha.writes).toEqual([]);
    expect(cleanupNeedsAccount(state)).toBe(false);
    expect((await cleanup(ctx, { accountless: true, log: () => undefined })).inventory).toEqual(EMPTY);
  });

  it("refuses an accountless cleanup of a run that created anything only the API removes", async () => {
    const { ctx, state } = setup();
    state.machineStarts = 1;
    await expect(cleanup(ctx, { accountless: true, log: () => undefined })).rejects.toMatchObject({ code: "account_required" });
  });
});

describe("rehearsal sign-in", () => {
  const account = { label: "3", email: "user-3@zeros.build", password: "pw" };
  const session = () => ({ accessToken: async () => "t", close: vi.fn(async () => undefined) });
  const me = (organizations: unknown[]) => ({ json: async () => ({ status: 200, body: { user: { id: randomUUID() }, organizations } }) });
  const deps = (overrides: Partial<SignInDeps> = {}): SignInDeps & { waits: number[] } => {
    const waits: number[] = [];
    return { waits, subject: async () => "user_3", signIn: async () => session(), api: () => me([{ id: randomUUID(), slug: null }]),
      sleep: async ms => { waits.push(ms); }, ...overrides };
  };

  it("names a transport failure by closed values, and retries a read that failed in transport as it retries a throttle", async () => {
    const reset = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });
    expect(transportCode(reset())).toBe("network:ECONNRESET");
    expect(transportCode(Object.assign(new Error("x"), { code: "ETIMEDOUT" }))).toBe("network:ETIMEDOUT");
    expect(transportCode(new DOMException("t", "TimeoutError"))).toBe("timeout");
    expect(transportCode(new DOMException("a", "AbortError"))).toBe("aborted");
    expect(transportCode(new SyntaxError("Unexpected token < in JSON"))).toBe("json_parse");
    expect(transportCode(Object.assign(new TypeError("fetch failed"), { cause: new Error("other") }))).toBe("network");
    expect(transportCode(new Error("pw leaked"))).toBeNull();
    expect(transportCode(Object.assign(new Error("x"), { code: "not a code" }))).toBeNull();
    // A read that resets once is retried after 5 s; one that keeps failing is named, never "unexpected".
    let calls = 0;
    const flaky = deps({ api: () => ({ json: async () => { if (calls++ === 0) throw reset(); return { status: 200, body: { user: { id: randomUUID() }, organizations: [] } }; } }) });
    expect(await signInAccount(account, flaky)).toMatchObject({ ok: true });
    expect(flaky.waits).toEqual([5_000]);
    const down = deps({ api: () => ({ json: async () => { throw reset(); } }) });
    expect(await signInAccount(account, down)).toEqual({ ok: false, label: "3", step: "me_read", code: "network:ECONNRESET" });
    expect(down.waits).toEqual([5_000, 15_000, 45_000]);
    // A sign-in is not a read: a transport failure there is named, not retried.
    const signIn = deps({ signIn: async () => { throw reset(); } });
    expect(await signInAccount(account, signIn)).toEqual({ ok: false, label: "3", step: "sign_in", code: "network:ECONNRESET" });
    expect(signIn.waits).toEqual([]);
  });

  it("names the failed step and its closed code, and closes a session it opened", async () => {
    expect(await signInAccount(account, deps({ subject: async () => { throw new RehearsalFailure("subject_lookup", "not_found"); } })))
      .toEqual({ ok: false, label: "3", step: "subject_lookup", code: "not_found" });
    expect(await signInAccount(account, deps({ signIn: async () => { throw new Gate0Failure("sign_in", "http_400_invalid_credentials"); } })))
      .toEqual({ ok: false, label: "3", step: "sign_in", code: "http_400_invalid_credentials" });
    expect(await signInAccount(account, deps({ signIn: async () => { throw new Error("pw leaked"); } })))
      .toEqual({ ok: false, label: "3", step: "sign_in", code: "unexpected" });
    const opened = session();
    expect(await signInAccount(account, deps({ signIn: async () => opened, api: () => ({ json: async () => ({ status: 401, body: null }) }) })))
      .toEqual({ ok: false, label: "3", step: "me_read", code: "http_401" });
    expect(opened.close).toHaveBeenCalledTimes(1);
    expect(await signInAccount(account, deps({ api: () => me([{ id: "not-a-uuid" }]) }))).toEqual({ ok: false, label: "3", step: "me_read", code: "schema:organizations.0.id" });
    // An organization without a slug is not a failure.
    expect(await signInAccount(account, deps())).toMatchObject({ ok: true, organizations: [{ slug: null }], selected: "none" });
  });

  it("retries a throttled step after 5, 15 and 45 seconds, then reports it", async () => {
    let calls = 0;
    const throttledOnce = deps({ signIn: async () => { if (++calls === 1) throw new Gate0Failure("sign_in", "http_429_rate_limit_exceeded"); return session(); } });
    expect(await signInAccount(account, throttledOnce)).toMatchObject({ ok: true });
    expect(throttledOnce.waits).toEqual([5_000]);
    const always = deps({ signIn: async () => { throw new Gate0Failure("sign_in", "http_429"); } });
    expect(await signInAccount(account, always)).toEqual({ ok: false, label: "3", step: "sign_in", code: "http_429" });
    expect(always.waits).toEqual([5_000, 15_000, 45_000]);
    const notThrottled = deps({ signIn: async () => { throw new Gate0Failure("sign_in", "http_400"); } });
    await signInAccount(account, notThrottled);
    expect(notThrottled.waits).toEqual([]);
  });

  it("chooses the probe's WorkOS organization when WorkOS asks, else the first offered, and says which", async () => {
    const choosing = (offered: string[], probe?: string) => deps({ ...(probe ? { probeWorkosOrganization: probe } : {}),
      signIn: async input => { expect(input.selectOrganization(offered)).toBe(probe && offered.includes(probe) ? probe : offered[0]); return session(); } });
    expect(await signInAccount(account, choosing(["org_a", "org_probe"], "org_probe"))).toMatchObject({ selected: "probe" });
    expect(await signInAccount(account, choosing(["org_a"], "org_probe"))).toMatchObject({ selected: "other" });
  });

  it("signs accounts in one at a time, three seconds apart, and keeps going after a failure", async () => {
    let n = 0;
    const spaced = deps({ signIn: async () => { if (++n === 1) throw new Gate0Failure("sign_in", "http_400"); return session(); } });
    const results = await signInAll([account, { ...account, label: "4" }, { ...account, label: "5" }], spaced);
    expect(results.map(result => result.ok)).toEqual([false, true, true]);
    expect(spaced.waits).toEqual([3_000, 3_000]);
  });
});

describe("what the rehearsal publishes on public fixtures", () => {
  // Every fixture is public: a branch, commit, committed file, pull request title or body carries fixed test text only.
  const FIXED = [/^zr-[0-9a-f]{8}-[a-z0-9-]{1,40}(\.txt)?\n?$/, /^Alpha rehearsal fixture; closed unmerged\.$/];
  const FORBIDDEN = [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, /@/, /:\/\//, /\.(build|test|com|dev)\b/i, /\d{4}-\d{2}-\d{2}/,
    /zeros user|probe|alpha\.test/i];
  for (const owner of ["organization", "personal"] as const) it(`on the ${owner} route: branches, commits, files and pull requests carry fixed test text only`, async () => {
    const { alpha, ctx, options } = setup({ owner });
    const stages: StageName[] = owner === "personal" ? ["setup", "projects", "personal", "retention", "submodules"] : ["projects", "retention"];
    expect(await runStages(ctx, stages, { ...options, switches: new Set(["projects", "personal", "retention"] as const) })).toBe(true);
    expect(alpha.published.length).toBeGreaterThan(5);
    for (const text of alpha.published) {
      expect(FIXED.some(pattern => pattern.test(text)), text).toBe(true);
      for (const pattern of FORBIDDEN) expect(pattern.test(text), `${pattern} in ${text}`).toBe(false);
    }
  });
});

describe("rehearsal GitHub token check", () => {
  const fixtures = [R1, FIXTURE_TWO, R3, SUBMODULE_FIXTURE];
  /** GitHub as a fine-grained token sees it: what it lists (with visibility), and 422 (validation) for the writes it may make. */
  const github = (token: { lists: { name: string; private?: boolean }[]; writable: string[]; pulls?: string[] }) => vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? "GET";
    if (url.pathname === "/user/repos") return Response.json(url.searchParams.get("page") === "1"
      ? token.lists.map(row => ({ full_name: row.name, private: row.private ?? false })) : []);
    const name = url.pathname.split("/").slice(2, 4).join("/");
    if (!token.lists.some(row => row.name === name)) return Response.json({ message: "Not Found" }, { status: 404 });
    if (method === "GET") return Response.json({ full_name: name });
    const allowed = url.pathname.endsWith("/pulls") ? (token.pulls ?? token.writable) : token.writable;
    return Response.json({ message: "x" }, { status: allowed.includes(name) ? 422 : 403 });
  });
  const scoped = fixtures.map(name => ({ name }));

  it("accepts a token that writes the fixtures and only reads public repositories outside them; changes nothing", async () => {
    const lists = [...scoped, { name: "Withso/zeros" }, { name: "someone/public-thing" }];
    const fetchImpl = github({ lists, writable: fixtures });
    const checked = await checkGithubToken("github_pat_synthetic", fixtures, fetchImpl);
    expect(checked.kind).toBe("fine_grained");
    expect(checked.fixtures.every(row => row.contentsWrite && row.pullRequestsWrite)).toBe(true);
    expect(checked.outside).toEqual([
      { repository: "Withso/zeros", reachable: true, contentsWrite: false, pullRequestsWrite: false },
      { repository: "someone/public-thing", reachable: true, contentsWrite: false, pullRequestsWrite: false }]);
    expect(tokenRefusal(checked, fixtures)).toBeNull();
    const lines = tokenLines(checked, fixtures);
    expect(lines[0]).toBe("github token: kind fine_grained; lists 6 repositories: 4 fixtures, 0 private outside the fixtures, 2 public outside");
    expect(lines).toContain("  public outside the fixtures, read only (both write probes refused): 2: Withso/zeros, someone/public-thing");
    for (const line of lines) expect(safeLine(line)).toBe(line);
    // Its only writes are the two probes per repository, both refused by GitHub's validation (the all-zero commit, an absent branch).
    const writes = fetchImpl.mock.calls.filter(([, init]) => (init?.method ?? "GET") !== "GET");
    expect(writes).toHaveLength((fixtures.length + 2) * 2);
    for (const [, init] of writes) expect(String(init?.body)).toMatch(/0{40}|zr-token-check-absent/);
  });

  it("refuses a private repository outside the fixtures, naming it, and does not probe it", async () => {
    const fetchImpl = github({ lists: [...scoped, { name: "someone/secret", private: true }], writable: fixtures });
    const checked = await checkGithubToken("github_pat_synthetic", fixtures, fetchImpl);
    expect(tokenRefusal(checked, fixtures)).toBe("reaches_private_outside_fixtures");
    expect(tokenLines(checked, fixtures)[0]).toContain("1 private outside the fixtures: someone/secret");
    expect(fetchImpl.mock.calls.some(([input]) => String(input).includes("someone/secret"))).toBe(false);
  });

  it("refuses write on a public repository outside the fixtures, naming it", async () => {
    const pullsOnly = await checkGithubToken("github_pat_synthetic", fixtures,
      github({ lists: [...scoped, { name: "Withso/zeros" }], writable: fixtures, pulls: [...fixtures, "Withso/zeros"] }));
    expect(tokenRefusal(pullsOnly, fixtures)).toBe("writes_outside_fixtures");
    expect(tokenLines(pullsOnly, fixtures)).toContain("  public outside the fixtures it can write: Withso/zeros");
    const contents = await checkGithubToken("github_pat_synthetic", fixtures, github({ lists: [...scoped, { name: "Withso/zeros" }], writable: [...fixtures, "Withso/zeros"] }));
    expect(tokenRefusal(contents, fixtures)).toBe("writes_outside_fixtures");
  });

  it("refuses a classic token, and one without write on a fixture", async () => {
    expect(tokenRefusal(await checkGithubToken("ghp_synthetic", fixtures, github({ lists: scoped, writable: fixtures })), fixtures)).toBe("kind_classic");
    expect(tokenRefusal(await checkGithubToken("github_pat_synthetic", fixtures, github({ lists: scoped, writable: fixtures.slice(1) })), fixtures))
      .toBe("fixture_contents_read_only");
    expect(tokenRefusal(await checkGithubToken("github_pat_synthetic", fixtures, github({ lists: scoped, writable: fixtures, pulls: [] })), fixtures))
      .toBe("fixture_pull_requests_read_only");
    expect(tokenRefusal(await checkGithubToken("github_pat_synthetic", fixtures, github({ lists: scoped.slice(0, 3), writable: fixtures })), fixtures))
      .toBe("fixture_unreachable");
  });

  it("refuses a token too broad to probe", async () => {
    const many = Array.from({ length: OUTSIDE_PROBE_LIMIT + 1 }, (_, index) => ({ name: `someone/public-${index}` }));
    await expect(checkGithubToken("github_pat_synthetic", fixtures, github({ lists: [...scoped, ...many], writable: fixtures })))
      .rejects.toMatchObject({ code: "too_broad_to_check" });
  });
});

describe("rehearsal --plan", () => {
  it("prints the preconditions block safely, for each state it can observe", async () => {
    const states: PreconditionFacts[] = [
      { release: { sourceSha: "a".repeat(40), workerSha256: "b".repeat(64) }, runtime: { found: true, actingUser: true, syncContext: true },
        projectsRead: "http_404_not_found:route_or_resource", computer: "http_404_not_found", sharedBaseInUse: 0 },
      { release: null, runtime: null, projectsRead: null, computer: null, sharedBaseInUse: null },
      { release: { sourceSha: "a".repeat(40), workerSha256: "b".repeat(64) }, runtime: { found: false, actingUser: false, syncContext: false },
        projectsRead: "200", computer: "none", sharedBaseInUse: 3 },
      { release: null, runtime: null, projectsRead: "200", computer: "absent", sharedBaseInUse: null },
    ];
    // The lines come back through safeLine already: a line it refused would read "line withheld (unsafe)".
    for (const facts of states) for (const line of preconditionLines(facts)) expect(line).not.toBe("line withheld (unsafe)");
    // The shared base for the pinned runtime comes first, with what it means for the switch.
    const shared = (sharedBase: PreconditionFacts["sharedBase"]) => preconditionLines({ ...states[1]!, sharedBase });
    expect(shared({ table: false })[1]).toBe("  shared base for the pinned runtime: not built (no cloud_v2_shared_bases table: the server predates the shared base)");
    expect(shared({ table: true, pinned: null, atBoat: null, perName: [], ownBases: 0 })[1]).toContain("do not turn ready copies on");
    expect(shared({ table: true, pinned: { name: "zeros-alpha-base-1a2b3c4d5e6f", state: "building" }, atBoat: false, perName: [], ownBases: 2 })[1])
      .toBe("  shared base for the pinned runtime: zeros-alpha-base-1a2b3c4d5e6f building: do not turn ready copies on, at Boat no");
    const ready = shared({ table: true, pinned: { name: "zeros-alpha-base-1a2b3c4d5e6f", state: "ready" }, atBoat: true,
      perName: [{ name: "zeros-alpha-base-1a2b3c4d5e6f", organizations: 4 }], ownBases: 2 });
    expect(ready.slice(1, 3)).toEqual(["  shared base for the pinned runtime: zeros-alpha-base-1a2b3c4d5e6f ready, at Boat yes",
      "  organizations per shared base: zeros-alpha-base-1a2b3c4d5e6f 4; organizations on their own base: 2"]);
    const reads = { read: async (text: string) => text.includes("to_regclass") ? [{ present: true }] : text.includes("FROM cloud_v2_shared_bases")
      ? [{ name: "zeros-alpha-base-1a2b3c4d5e6f", state: "ready" }] : text.includes("GROUP BY") ? [{ name: "zeros-alpha-base-1a2b3c4d5e6f", organizations: 4 }] : [{ n: 2 }] };
    expect(await sharedBaseFacts(reads, "b".repeat(64), async name => name === "zeros-alpha-base-1a2b3c4d5e6f"))
      .toEqual({ table: true, pinned: { name: "zeros-alpha-base-1a2b3c4d5e6f", state: "ready" }, atBoat: true,
        perName: [{ name: "zeros-alpha-base-1a2b3c4d5e6f", organizations: 4 }], ownBases: 2 });
    expect(await sharedBaseFacts({ read: async () => [{ present: false }] }, null, async () => true)).toEqual({ table: false });
    const lines = preconditionLines(states[0]!);
    expect(lines).toContain("  projects routes: not mounted (CLOUD_V2_READY_COPIES_ENABLED off)");
    expect(lines.join(" ")).toContain("CLOUD_V2_READY_COPIES_ENABLED=true, CLOUD_V2_PERSONAL_CLOUD_ENABLED=true, CLOUD_V2_RETENTION_ENABLED=true");
  });

  it("reads accounts with GETs only and lists every write without making one", async () => {
    const { alpha, state } = setup();
    const summary = await readAccount(alpha.api(), "owner", state.organizationId, "Withso");
    expect(alpha.writes).toEqual([]);
    expect(summary).toMatchObject({ admin: true, fixtureConnection: true, githubIdentity: true, connections: { organization: 1, personal: 0, logins: ["Withso"] } });
    for (const line of accountLines(summary)) expect(line).not.toBe("line withheld (unsafe)");
    const switches = new Set(["projects", "retention"] as const), org = "organization" as const;
    expect(refusal("projects", summary, switches, org)).toBeNull();
    expect(refusal("retention", summary, new Set(["projects"] as const), org)).toBe("undeclared_retention");
    expect(refusal("personal", summary, switches, org)).toBe("personal_route_only");
    expect(refusal("projects", { ...summary, admin: false }, switches, org)).toBe("not_owner_or_admin");
    expect(refusal("projects", { ...summary, fixtureConnection: false }, switches, org)).toBe("no_fixture_connection");
    expect(refusal("projects", { ...summary, githubIdentity: false }, switches, org)).toBe("no_github_identity");
    expect(refusal("retention", { failed: "sign_in:http_400_invalid_credentials" }, switches, org)).toBe("account_unavailable:sign_in:http_400_invalid_credentials");
    // provision uses only the App: no account, or a failed one, does not refuse it.
    expect(refusal("provision", { failed: "sign_in:network" }, switches, org)).toBeNull();
    expect(refusal("setup", summary, switches, org)).toBe("awaiting_approval");
    // The Personal route: every stage but provision needs the personal switch; setup needs the token and the actor.
    const all = new Set(["projects", "personal", "retention"] as const);
    expect(refusal("projects", summary, switches)).toBe("undeclared_personal");
    expect(refusal("setup", summary, all)).toBeNull();
    expect(refusal("setup", summary, all, "personal", { token: false, proActor: "resolved" })).toBe("no_github_token");
    expect(refusal("setup", summary, all, "personal", { token: true, proActor: "ambiguous" })).toBe("pro_actor_ambiguous");
    expect(refusal("personal", summary, all)).toBeNull();
    expect(refusal("retention", { ...summary, personal: null }, all)).toBe("no_personal_organization");
    expect(refusal("submodules", summary, all)).toBe("fixtures_not_named");
    expect(refusal("submodules", summary, all, "personal", { token: true, proActor: "resolved", submoduleFixtures: "missing" })).toBe("fixtures_missing");
    expect(refusal("submodules", summary, all, "personal", { token: true, proActor: "resolved", submoduleFixtures: "present" })).toBeNull();
    expect(refusal("submodules", summary, all, "organization")).toBe("personal_route_only");
    for (const line of PERSONAL_ROUTE_GAPS) expect(safeLine(line)).toBe(line);
    alpha.githubIdentity = false;
    expect((await readAccount(alpha.api(), "9", state.organizationId, "Withso")).githubIdentity).toBe(false);
    expect(refusal("waiting", summary, all, "personal", { token: true, proActor: "resolved" })).toBe("waiting_account_not_configured");
    expect(refusal("waiting", summary, all, "personal", { token: true, proActor: "resolved", waitingAccount: "base_ready" })).toBe("waiting_account_base_ready");
    expect(refusal("waiting", summary, all, "personal", { token: true, proActor: "none", waitingAccount: "fresh" })).toBe("pro_actor_none");
    expect(refusal("waiting", summary, all, "personal", { token: true, proActor: "resolved", waitingAccount: "fresh" })).toBeNull();
    expect(refusal("waiting", summary, all, "organization")).toBe("personal_route_only");
    for (const stage of ["provision", "setup", "projects", "personal", "retention", "submodules", "waiting"] as StageName[])
      for (const owner of ["personal", "organization"] as const)
        for (const line of writeLines(stage, "zr-<run>-", { one: R1, two: FIXTURE_TWO }, owner)) { expect(line).not.toBe("line withheld (unsafe)"); }
  });
});
