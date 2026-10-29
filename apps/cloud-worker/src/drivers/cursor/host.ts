import type { HostEvent, NativeAgent, NativeRun, NativeSDK, OpenParams, PromptParams } from "./native-types";
import { CURSOR_VERSION } from "./native-types";
import { CursorModelCatalog, type CursorModelRecord } from "./model-selection";

interface Turn { id: string; run?: NativeRun; cancelled: boolean; accepting: boolean; steers: number; cancel?: Promise<void>; done: Promise<void>; finish(): void }
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
function isQuestion(value: unknown, depth = 0): boolean {
  const row = record(value);
  return [row.type, row.name].some(name => typeof name === "string" && /^(?:askQuestion|askQuestionToolCall)$/.test(name)) ||
    (depth < 4 && [row.toolCall, row.taskUpdate, row.message].some(child => child && isQuestion(child, depth + 1)));
}
const interactiveError = () => new Error("Cursor requested interactive input, which is unavailable in cloud workspaces.");

/** Runs only in a child whose environment contains this agent's login. SDK
 * callbacks and stream mirrors share one execution id, including during send. */
export class CursorHost {
  private agent?: NativeAgent;
  private turn?: Turn;
  private opening = false;
  private disposed = false;
  private billing?: Promise<unknown>;
  private models?: CursorModelCatalog;
  constructor(private readonly sdk: NativeSDK, private readonly publish: (event: HostEvent) => Promise<void>, private readonly apiKey: string,
    private readonly listModels: (options: { apiKey: string }) => Promise<CursorModelRecord[]>) {}

  async open(params: OpenParams): Promise<{ nativeSessionId: string; version: string }> {
    if (this.agent || this.opening || this.disposed) throw new Error("Cursor host has already been opened.");
    this.opening = true;
    const models = new CursorModelCatalog(await this.listModels({ apiKey: this.apiKey }));
    if (this.disposed) throw new Error("Cursor host closed during model discovery.");
    const options = { cwd: params.cwd, model: models.selection(params.model, params.effort, params.fast === true), apiKey: this.apiKey, mode: "agent" as const,
      ...(params.mcpServers ? { mcpServers: params.mcpServers } : {}),
      disallowedTools: ["askQuestion"], local: { cwd: params.cwd, autoReview: false, sandboxOptions: { enabled: false },
        enableAgentRetries: false, settingSources: ["project", "user"] as Array<"project" | "user">, subagentInherit: {} } };
    const agent = params.nativeSessionId ? await this.sdk.resume(params.nativeSessionId, options) : await this.sdk.create(options);
    if (this.disposed || !agent.agentId || (params.nativeSessionId && agent.agentId !== params.nativeSessionId)) {
      agent.close(); throw new Error("Cursor returned a different or closed native session.");
    }
    this.agent = agent; this.models = models; return { nativeSessionId: agent.agentId, version: CURSOR_VERSION };
  }

  async prompt(params: PromptParams): Promise<{ runId: string }> {
    if (!this.agent || this.disposed || this.turn) throw new Error("Cursor is not ready for another prompt.");
    let finish!: () => void;
    const turn: Turn = { id: params.turnId, cancelled: false, accepting: true, steers: 0, done: new Promise(resolve => { finish = resolve; }), finish: () => finish() };
    this.turn = turn;
    const emit = async (kind: "delta" | "step", value: unknown) => {
      if (this.turn !== turn || this.disposed || turn.cancelled || !turn.accepting) return;
      if (isQuestion(value)) {
        this.turn = undefined; turn.finish();
        if (turn.run) void this.cancel(turn).catch(() => {});
        await this.publish({ t: "event", turnId: turn.id, kind: "error", value: interactiveError().message });
        throw interactiveError();
      }
      await this.publish({ t: "event", turnId: turn.id, kind, value });
    };
    try {
      turn.run = await this.agent.send(params.content, { mode: "agent", model: this.models!.selection(params.model, params.effort, params.fast === true), local: { force: true },
        idempotencyKey: `zeros-${turn.id}`, onDelta: ({ update }) => emit("delta", update), onStep: ({ step }) => emit("step", step) });
      if (this.disposed || this.turn !== turn) { await this.cancel(turn); throw new Error("Cursor turn was closed during send."); }
      await this.publish({ t: "event", turnId: turn.id, kind: "started", value: { agentId: this.agent.agentId, runId: turn.run.id } });
      if (turn.cancelled) await this.cancel(turn);
      void this.consume(turn);
      return { runId: turn.run.id };
    } catch (error) {
      if (this.turn === turn) this.turn = undefined;
      turn.finish(); throw error;
    }
  }

  async steer(turnId: string, text: string): Promise<"delivered" | "queued" | "interrupted"> {
    const turn = this.turn;
    if (!turn || turn.id !== turnId || turn.cancelled || !turn.accepting || !turn.run?.steer || this.disposed || turn.steers >= 128) return "queued";
    turn.steers++;
    try {
      const outcome = await Promise.race([turn.run.steer(text), turn.done.then(() => "uncertain")]);
      return outcome === "complete_delivered" ? "delivered" : outcome === "revert_to_followup" ? "queued" : "interrupted";
    } catch { return "interrupted"; }
  }

  async interrupt(turnId: string): Promise<void> {
    const turn = this.turn; if (!turn || turn.id !== turnId) return;
    turn.cancelled = true; if (turn.run) await this.cancel(turn);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return; this.disposed = true;
    const turn = this.turn; this.turn = undefined;
    if (turn) { turn.cancelled = true; turn.finish(); if (turn.run) void this.cancel(turn).catch(() => {}); }
    this.agent?.close(); this.agent = undefined;
  }

  private async consume(turn: Turn): Promise<void> {
    let terminal: HostEvent;
    try {
      for await (const value of turn.run!.stream()) {
        if (this.disposed || this.turn !== turn) return;
        const message = record(value);
        if ((message.agent_id && message.agent_id !== this.agent!.agentId) || (message.run_id && message.run_id !== turn.run!.id)) continue;
        if (isQuestion(message)) {
          // This SDK has no host approval/question UI. An unexpected request
          // must terminate promptly even if a tool ignores disallowedTools.
          void this.cancel(turn).catch(() => {});
          this.turn = undefined; turn.finish();
          // Publish before IteratorClose, whose native return() may itself
          // await the interactive response that this worker cannot provide.
          await this.publish({ t: "event", turnId: turn.id, kind: "error", value: interactiveError().message });
          throw interactiveError();
        }
        if (!turn.cancelled) await this.publish({ t: "event", turnId: turn.id, kind: "message", value });
      }
      const result = await turn.run!.wait();
      turn.accepting = false;
      terminal = { t: "event", turnId: turn.id, kind: "result", value: { result: turn.cancelled ? { ...result, status: "cancelled" } : result, billed: await this.usage() } };
    } catch (error) {
      void this.cancel(turn).catch(() => {});
      terminal = turn.cancelled
        ? { t: "event", turnId: turn.id, kind: "result", value: { result: { id: turn.run!.id, status: "cancelled" } } }
        : { t: "event", turnId: turn.id, kind: "error", value: error instanceof Error ? error.message : "Cursor stream failed." };
    } finally { turn.accepting = false; turn.finish(); }
    if (this.turn !== turn || this.disposed) return;
    this.turn = undefined;
    await this.publish(terminal).catch(() => {});
  }

  private cancel(turn: Turn): Promise<void> { return turn.cancel ??= turn.run!.cancel(); }
  private async usage(): Promise<unknown> {
    if (!this.agent) return undefined;
    const agent = this.agent;
    if (!this.billing) {
      const flight = Promise.resolve().then(() => agent.getUsage()).catch(() => undefined);
      this.billing = flight; void flight.finally(() => { if (this.billing === flight) this.billing = undefined; });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([this.billing, new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 1000); })]); }
    finally { clearTimeout(timer); }
  }
}
