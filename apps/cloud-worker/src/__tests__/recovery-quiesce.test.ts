import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLOUD_RECOVERY_QUIESCE_FEATURE, type CloudRecoveryReply, type CloudRecoveryRequest } from "@zeros/protocol/cloud-v2-relay";
import { CloudV2PromptPullReplySchema } from "@zeros/protocol/cloud-v2-prompts";
import { RuntimeQuiescence, type RuntimeCensus } from "../runtime-quiescence";
import { RECOVERY_RETRY_MS, RECOVERY_STATUS_MS, RecoveryQuiesce } from "../recovery-quiesce";
import { openRecoveryTurnHold, releaseRecoveryTurnHold, RECOVERY_TURN_HOLD } from "../recovery-turn-hold";
import { WORKSPACE_STARTING_MESSAGE } from "../agents";
import { CloudWorker } from "../worker";
import { CLOUD_WORKER_FEATURES } from "../worker-features";
import { CLIENT_A, FakeRelay, WORKSPACE_ID, browserFrame, config } from "./worker-fixtures";

const ID = "44444444-4444-4444-8444-444444444444";
const quiet = (): RuntimeCensus => ({ clients: false, requests: false, agents: false, terminals: false, setup: false,
  checkout: false, configuration: false, prompts: false, attachments: false, storage: false, tools: false });
const directories: string[] = [], workers: CloudWorker[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(workers.splice(0).map(worker => worker.dispose()));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
const temp = async () => { const directory = await mkdtemp(join(tmpdir(), "zeros-recovery-")); directories.push(directory); return directory; };

describe("recovery census (recovery-quiesce-v1)", () => {
  it("ignores attached clients, terminals and terminal output, and still waits for turns, setup and writes", () => {
    let now = 0;
    const census = quiet(), gate = new RuntimeQuiescence(() => census, () => now);
    census.clients = true; census.terminals = true;
    gate.ticket("recovery"); now += 30_000;
    expect(gate.ticket()).toBeNull();
    const ticket = gate.ticket("recovery")!;
    expect(ticket).toMatchObject({ scope: "recovery" });
    gate.activity("terminal");
    expect(gate.valid(ticket)).toBe(true);
    for (const kind of ["agents", "setup", "requests", "prompts", "storage", "tools", "checkout", "attachments", "configuration"] as const) {
      census[kind] = true; expect(gate.valid(ticket), kind).toBe(false); census[kind] = false;
    }
    gate.activity();
    expect(gate.valid(ticket)).toBe(false);
  });
});

function quiesce(reply: (input: CloudRecoveryRequest) => Promise<CloudRecoveryReply>) {
  const census = quiet(), gate = new RuntimeQuiescence(() => census, () => Date.now());
  const order: string[] = [], requests: CloudRecoveryRequest[] = [], paused: boolean[] = [];
  const recovery = new RecoveryQuiesce({ gate,
    request: async input => { requests.push(input); order.push(input.op); return reply(input); },
    flush: async () => { order.push("flush"); },
    pausePrompts: value => { paused.push(value); order.push(value ? "pause" : "resume"); } });
  const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
  return { census, gate, recovery, order, requests, paused, advance };
}

describe("recovery seal", () => {
  it("waits 30 s quiet, freezes and pauses claims, flushes, then seals with the ticket's generation", async () => {
    vi.useFakeTimers();
    const f = quiesce(async input => ({ id: input.id, generation: input.generation, status: "sealed" }));
    f.recovery.requested({ id: ID });
    await f.advance(29_000);
    expect(f.requests).toHaveLength(0);
    await f.advance(2_000);
    expect(f.order.slice(0, 3)).toEqual(["pause", "flush", "seal"]);
    expect(f.requests[0]).toEqual({ op: "seal", id: ID, generation: expect.any(Number) });
    expect(f.gate.open).toBe(false); expect(f.recovery.frozen).toBe(true);
    // Sealed: admissions park, and the worker confirms with the same binding once a minute.
    let admitted = false; void Promise.resolve(f.gate.admit()).then(() => { admitted = true; });
    await f.advance(RECOVERY_STATUS_MS);
    expect(f.requests.at(-1)).toEqual({ op: "status", id: ID, generation: f.requests[0]!.generation });
    expect(admitted).toBe(false);
  });

  it("stays frozen on a lost reply, pending, a 409 binding refusal or another binding; only a matching cancelled releases", async () => {
    vi.useFakeTimers();
    const replies: Array<(input: CloudRecoveryRequest) => Promise<CloudRecoveryReply>> = [
      async () => { throw new Error("socket hang up"); },
      async input => ({ id: input.id, generation: input.generation, status: "pending" }),
      async () => { throw Object.assign(new Error("recovery_binding_changed"), { status: 409 }); },
      async input => ({ id: input.id, generation: input.generation + 1, status: "cancelled" }),
      async input => ({ id: "55555555-5555-4555-8555-555555555555", generation: input.generation, status: "cancelled" }),
      async input => ({ id: input.id, generation: input.generation, status: "cancelled" }),
    ];
    const f = quiesce(input => replies.shift()!(input));
    f.recovery.requested({ id: ID });
    await f.advance(31_000);
    const first = f.requests[0]!;
    for (let i = 0; i < 4; i++) { await f.advance(RECOVERY_RETRY_MS); expect(f.gate.open, `reply ${i}`).toBe(false); }
    // Every retry repeats the same seal binding.
    expect(f.requests.slice(0, 5).every(request => request.op === "seal" && request.id === ID && request.generation === first.generation)).toBe(true);
    await f.advance(RECOVERY_RETRY_MS);
    expect(f.gate.open).toBe(true); expect(f.recovery.frozen).toBe(false); expect(f.paused.at(-1)).toBe(false);
    // A later hint for another attempt starts over.
    f.recovery.requested({ id: "66666666-6666-4666-8666-666666666666" });
    await f.advance(31_000);
    expect(f.requests.at(-1)).toMatchObject({ op: "seal", id: "66666666-6666-4666-8666-666666666666" });
  });

  it("never seals while a turn runs, and reopens without sealing when work arrives during the flush", async () => {
    vi.useFakeTimers();
    let gate!: RuntimeQuiescence;
    const f = quiesce(async input => ({ id: input.id, generation: input.generation, status: "sealed" }));
    gate = f.gate;
    f.census.agents = true;
    f.recovery.requested({ id: ID });
    await f.advance(120_000);
    expect(f.requests).toHaveLength(0); expect(gate.open).toBe(true);
    f.census.agents = false;
    // Work arrives while flushing: nothing is sent, admissions reopen, and the next quiet window seals.
    let flushes = 0;
    (f.recovery as unknown as { options: { flush: () => Promise<void> } }).options.flush = async () => { if (flushes++ === 0) gate.activity(); };
    await f.advance(31_000);
    expect(f.requests).toHaveLength(0); expect(gate.open).toBe(true); expect(f.paused).toEqual([true, false]);
    await f.advance(31_000);
    expect(f.requests).toHaveLength(1);
  });
});

describe("recovery turn hold", () => {
  it("is created only by a recovery marker, survives a restart, and releases durably", async () => {
    const directory = await temp();
    expect(await openRecoveryTurnHold(directory)).toBe(false);
    await writeFile(join(directory, "restored-from-checkpoint"), "");
    expect(await openRecoveryTurnHold(directory)).toBe(false);
    await writeFile(join(directory, "restored-from-checkpoint"), "recovery\n");
    expect(await openRecoveryTurnHold(directory)).toBe(true);
    expect((await stat(join(directory, RECOVERY_TURN_HOLD))).mode & 0o777).toBe(0o600);
    // Setup removes the marker after admission; a restarted worker still holds.
    await rm(join(directory, "restored-from-checkpoint"));
    expect(await openRecoveryTurnHold(directory)).toBe(true);
    await releaseRecoveryTurnHold(directory);
    expect(await openRecoveryTurnHold(directory)).toBe(false);
  });
});

class RecoveryRelay extends FakeRelay {
  pulls = 0;
  setupReports: unknown[] = [];
  refuseSetup = false;
  hint?: string;
  recoveryCalls: CloudRecoveryRequest[] = [];
  async reportSetup(input: unknown): Promise<void> {
    this.setupReports.push(input);
    if (this.refuseSetup) throw Object.assign(new Error("fixture report refused"), { status: 409 });
  }
  async promptRequest(op: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    const body = input as { waitMs?: number };
    if (op !== "pull") return { ok: true };
    this.pulls++;
    if (this.hint) { const id = this.hint; this.hint = undefined; return { prompts: [], stops: [], recovery: { id } }; }
    if (body.waitMs === 0) return { prompts: [], stops: [] };
    return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
  }
  async recovery(input: CloudRecoveryRequest): Promise<CloudRecoveryReply> {
    this.recoveryCalls.push(input); return { id: input.id, generation: input.generation, status: "sealed" };
  }
}

async function boot(options: { marker?: string; setup?: string; directory?: string; relay?: RecoveryRelay } = {}) {
  const directory = options.directory ?? await temp();
  if (options.marker !== undefined) await writeFile(join(directory, "restored-from-checkpoint"), options.marker);
  const relay = options.relay ?? new RecoveryRelay();
  const worker = new CloudWorker({ directory, transport: relay, workspaceId: WORKSPACE_ID, prepareCheckout: async () => ({ createdBranch: true }), drivers: {} });
  workers.push(worker); worker.start();
  await relay.receive({ ...config, workspace: { ...config.workspace, ...(options.setup ? { setup: options.setup } : {}) }, promptOutbox: 1 });
  return { directory, relay, worker };
}

describe("joined worker", () => {
  it("advertises recovery-quiesce-v1 and parses the pull hint", () => {
    expect(CLOUD_WORKER_FEATURES.split(",")).toContain(CLOUD_RECOVERY_QUIESCE_FEATURE);
    expect(CloudV2PromptPullReplySchema.parse({ prompts: [], stops: [], recovery: { id: ID } }).recovery).toEqual({ id: ID });
  });

  it("an ordinary restore pulls at once; a recovery replacement with a no-op setup releases its hold and then pulls", async () => {
    const ordinary = await boot({ marker: "" });
    await vi.waitFor(() => expect(ordinary.relay.pulls).toBeGreaterThan(0));
    const recovered = await boot({ marker: "recovery" });
    await vi.waitFor(() => expect(recovered.relay.pulls).toBeGreaterThan(0));
    await expect(stat(join(recovered.directory, RECOVERY_TURN_HOLD))).rejects.toThrow();
  });

  it("persists and re-reports recovery no-op success after a refused report and a restart", async () => {
    const relay = new RecoveryRelay(); relay.refuseSetup = true;
    const first = await boot({ marker: "recovery", relay });
    await vi.waitFor(() => expect(relay.pulls).toBeGreaterThan(0));
    const path = join(first.directory, "workspace-setup", `${WORKSPACE_ID}.json`);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ workspaceId: WORKSPACE_ID, state: "succeeded", exitCode: 0 });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await vi.waitFor(() => expect(relay.setupReports).toContainEqual(expect.objectContaining({ state: "succeeded" })));
    await first.worker.dispose();
    const next = await boot({ directory: first.directory });
    await vi.waitFor(() => expect(next.relay.setupReports).toContainEqual(expect.objectContaining({ state: "succeeded" })));
    const ordinary = await boot({ marker: "" });
    await vi.waitFor(() => expect(ordinary.relay.pulls).toBeGreaterThan(0));
    expect(ordinary.relay.setupReports).toHaveLength(0);
  });

  it("a recovery replacement whose setup fails keeps the hold: no pull, and bridge turns are refused as starting", async () => {
    const f = await boot({ marker: "recovery", setup: "exit 3" });
    await vi.waitFor(async () => expect(await readFile(join(f.directory, "workspace-setup", `${WORKSPACE_ID}.json`), "utf8")).toContain("\"failed\""), { timeout: 5_000 });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(f.relay.pulls).toBe(0);
    expect((await stat(join(f.directory, RECOVERY_TURN_HOLD))).isFile()).toBe(true);
    await f.relay.receive({ t: "open", clientId: CLIENT_A });
    const prompt = browserFrame("AGENT_PROMPT", { agentId: "codex", sessionId: "s", executionId: "s", chatId: "chat", prompt: [{ type: "text", text: "hi" }] });
    await f.relay.request(CLIENT_A, prompt);
    await vi.waitFor(() => expect(f.relay.response(prompt.id)).toMatchObject({ type: "AGENT_ERROR", agentId: "codex", code: "WORKSPACE_STARTING",
      message: WORKSPACE_STARTING_MESSAGE, failure: { kind: "transport-closed", stage: "prompt", agentId: "codex", message: WORKSPACE_STARTING_MESSAGE } }));
    expect(JSON.stringify(f.relay.response(prompt.id))).not.toContain("cloud\":");
  });

  it("forwards the pull hint and seals once the recovery census is quiet", async () => {
    const f = await boot();
    // The long poll is in flight (the first, immediate pull has returned).
    await vi.waitFor(() => expect(f.relay.pulls).toBeGreaterThan(1));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    f.relay.hint = ID;
    (f.worker as unknown as { promptInbox: { hint(): void } }).promptInbox.hint();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(f.relay.recoveryCalls[0]).toMatchObject({ op: "seal", id: ID });
  });
});
