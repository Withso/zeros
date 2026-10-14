import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { ZerosDevSession } from "./session";
import type { ProductApi, Agent } from "./product";
import type { Run, RunHandle, RunStore, Source } from "./receipts";
import type { ZerosDevRuntime } from "./runtime";
import { parseRepositorySelection, type AgentValues, type RepositorySelection } from "./config";
import { Evidence, assertNoCredentials, redactContent, type EvidenceEvent } from "./evidence";
import { ZerosDevError, closedError } from "./errors";
import type { controlPlaneHealth, controlPlaneLogs, databaseHealth } from "./health";

const COMMANDS = {
  login: [], whoami: [], logout: [], "org ensure": [], "repo ensure": [], "github connect": ["repository", "repository-id"],
  "computer build": ["run", "wait"], "computer status": ["run"], "computer logs": ["run", "after"],
  "workspace create": ["run", "wait"], "workspace resume": ["run", "wait"], "workspace stop": ["run", "wait"], "workspace delete": ["run", "wait"], "workspace status": ["run"],
  "agent send": ["run", "agent", "model", "prompt-file", "prompt", "continue", "wait"], "chat tail": ["run", "prompt"],
  "terminal run": ["run", "script", "command"], "health cp": ["expect-source"], "health cp-logs": ["run"], "health vm": ["run"], "health db": ["run", "expect-runtime"],
  "scenario run smoke": ["run", "agent", "model", "prompt-file", "expect-source", "build-computer"], cleanup: ["run", "all", "apply"],
} satisfies Record<string, string[]>;
export type CommandName = keyof typeof COMMANDS;
export type Command = { name: CommandName; options: Record<string, string | true> };
const switches = new Set(["wait", "all", "apply", "build-computer"]);
const uuid = z.string().uuid();

export const HELP = `Alpha-only Linux zeros-dev (credentials: canonical .env.agent)
  login | whoami | logout
  github connect --repository OWNER/NAME --repository-id NUMERIC_ID
  org ensure | repo ensure
  computer build [--run UUID] [--wait]
  computer status|logs --run UUID [--after N]
  workspace create [--run UUID] [--wait]
  workspace resume|stop|delete|status --run UUID
  agent send --run UUID --agent claude|codex|cursor --model MODEL --prompt-file FILE [--prompt UUID] [--continue PROMPT_UUID]
  chat tail --run UUID --prompt UUID
  terminal run --run UUID --script FILE [--command UUID]
  health cp [--expect-source SHA] | cp-logs|vm --run UUID
  health db --run UUID [--expect-runtime r1-SHA256]
  scenario run smoke --agent AGENT --model MODEL [--run UUID] [--build-computer] [--prompt-file FILE]
  cleanup --run UUID|--all [--apply]
Lifecycle/build/prompt commands wait with finite deadlines. Cleanup defaults to a plan.
No channel, origin, password, token, sandbox-ID or SQL argument is supported.`;

export function parseCommand(args: string[]): Command | null {
  if (args.length === 0 || args.length === 1 && ["help", "--help", "-h"].includes(args[0]!)) return null;
  const flag = args.findIndex(value => value.startsWith("--"));
  const requested = args.slice(0, flag < 0 ? args.length : flag).join(" ");
  const name = requested === "health" ? "health cp" : requested;
  if (!Object.hasOwn(COMMANDS, name)) throw new ZerosDevError("invalid_request");
  const options: Record<string, string | true> = {};
  for (let i = flag < 0 ? args.length : flag; i < args.length; i++) {
    const key = args[i]?.slice(2);
    if (!args[i]?.startsWith("--") || !key || !(COMMANDS[name as CommandName] as string[]).includes(key) || Object.hasOwn(options, key)) throw new ZerosDevError("invalid_request");
    if (switches.has(key)) options[key] = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith("--") || value.length > 4096 || /[\r\n\0]/.test(value)) throw new ZerosDevError("invalid_request");
      options[key] = value;
    }
  }
  for (const key of ["run", "prompt", "command", "continue"]) if (options[key] && !uuid.safeParse(options[key]).success) throw new ZerosDevError("invalid_request");
  if (options["expect-source"] && !/^[a-f0-9]{40}$/.test(String(options["expect-source"])) ||
    options["expect-runtime"] && !/^r1-[a-f0-9]{64}$/.test(String(options["expect-runtime"]))) throw new ZerosDevError("invalid_request");
  if (name === "cleanup" && (!!options.run === !!options.all)) throw new ZerosDevError("invalid_request");
  if (!["login", "whoami", "logout", "org ensure", "repo ensure", "github connect", "health cp", "workspace create", "computer build", "scenario run smoke", "cleanup"].includes(name) && !options.run)
    throw new ZerosDevError("invalid_request");
  if (name === "github connect") parseRepositorySelection(String(options.repository ?? ""), String(options["repository-id"] ?? ""));
  if (["agent send", "scenario run smoke"].includes(name) && (!z.enum(["claude", "codex", "cursor"]).safeParse(options.agent).success ||
    typeof options.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(options.model))) throw new ZerosDevError("invalid_request");
  if (name === "agent send" && !options["prompt-file"] || name === "chat tail" && !options.prompt || name === "terminal run" && !options.script ||
    options.after && !/^(0|[1-9][0-9]{0,8})$/.test(String(options.after))) throw new ZerosDevError("invalid_request");
  return { name: name as CommandName, options };
}

export interface Services {
  session: Pick<ZerosDevSession, "login" | "logout" | "whoami" | "identity" | "fixture">;
  api: ProductApi;
  runs(): Promise<RunStore>;
  source(): Promise<Source>;
  values(): Promise<AgentValues>;
  content(file: string, maxBytes: number): Promise<string>;
  connect(run: Run, signal: AbortSignal): Promise<ZerosDevRuntime>;
  healthCp(): ReturnType<typeof controlPlaneHealth>;
  healthDb(run: Run): ReturnType<typeof databaseHealth>;
  healthLogs(run: Run): ReturnType<typeof controlPlaneLogs>;
  githubConnect(repository: RepositorySelection, signal: AbortSignal, show: (url: string) => void): Promise<void>;
  write(value: unknown): void;
}

/** Only closed result projections and explicitly requested, redacted content
 * may be emitted. Runtime handles, credentials and provider bodies stay private. */
export async function executeCommand(command: Command, services: Services, signal: AbortSignal): Promise<number> {
  const { name, options } = command, runId = typeof options.run === "string" ? options.run : randomUUID();
  const evidence = new Evidence(runId, services.write);
  const result = (data: unknown) => services.write({ schema: "zeros.dev-result/v1", runId, command: name, data });
  const display = async (kind: "chat" | "terminal" | "computer_log", text: string) => services.write({ schema: "zeros.dev-content/v1", runId, kind, text: redactContent(text, await services.values()) });
  const input = async (file: string, maxBytes: number) => { const text = await services.content(file, maxBytes); assertNoCredentials(text, await services.values()); return text; };
  const runtimeWork = async <T>(run: Run, work: (runtime: ZerosDevRuntime) => Promise<T>) => {
    const runtime = await evidence.step("runtime_connect", () => services.connect(run, signal));
    try { return await work(runtime); } finally { await runtime.dispose(); }
  };
  async function withRun(work: (handle: RunHandle) => Promise<void>, fresh = false) {
    const runs = await services.runs();
    await runs.withRun(runId, fresh ? await services.source() : null, async handle => {
      await handle.save();
      services.write({ schema: "zeros.dev-context/v1", runId, localSource: handle.run.source });
      try { await work(handle); }
      finally { handle.run.evidence = [...handle.run.evidence, ...evidence.events].slice(-256); await handle.save(); }
    });
  }
  async function sourceCheck() {
    const health = await evidence.step("health_cp", services.healthCp);
    if (options["expect-source"] && health.sourceSha !== options["expect-source"]) throw new ZerosDevError("identity_changed");
    return health;
  }
  try {
    if (name === "login") { await evidence.step("login", () => services.session.login()); result({ authenticated: true }); }
    else if (name === "logout") { await evidence.step("identity", () => services.session.logout()); result({ authenticated: false }); }
    else if (name === "whoami" || name === "org ensure") { await evidence.step("identity", () => services.session.whoami()); result({ fixture: "confirmed" }); }
    else if (name === "repo ensure") { await evidence.step("repository", () => services.api.ensureRepository(signal)); result({ fixture: "confirmed" }); }
    else if (name === "github connect") {
      const repository = parseRepositorySelection(String(options.repository), String(options["repository-id"]));
      await evidence.step("repository", () => services.githubConnect(repository, signal,
        authorizeUrl => services.write({ schema: "zeros.dev-github-authorization/v1", authorizeUrl })));
      result({ connected: true, fixture: "confirmed" });
    }
    else if (name === "health cp") { await services.session.identity(); result(await sourceCheck()); }
    else if (name === "cleanup") {
      const runs = await services.runs(), ids = options.all ? await runs.list() : [runId];
      let planned = 0, confirmed = 0;
      for (const id of ids) await runs.withRun(id, null, async handle => {
        const row = await evidence.step("cleanup", () => services.api.cleanup(handle, options.apply === true, signal)); planned += row.planned; confirmed += row.confirmed;
      });
      result({ apply: options.apply === true, planned, confirmed });
    } else await withRun(async handle => {
      if (name === "computer build") {
        await evidence.step("computer_build", () => services.api.buildComputer(handle, signal));
        const row = await evidence.step("computer_wait", () => services.api.waitComputer(handle.run, signal)); result({ state: row.state, version: row.version });
      } else if (name === "computer status") {
        const row = await services.api.readBuild(handle.run, signal); result({ state: row.state, version: row.version, templateState: row.templateState });
      } else if (name === "computer logs") {
        const log = await services.api.computerLog(handle.run, Number(options.after ?? 0), signal);
        await display("computer_log", JSON.stringify(log));
      } else if (name === "workspace create") {
        await evidence.step("workspace_create", () => services.api.createWorkspace(handle, signal));
        const row = await evidence.step("workspace_wait", () => services.api.waitWorkspace(handle, "running", signal)); result({ status: row.status, generation: row.generation.number });
      } else if (name === "workspace resume" || name === "workspace stop" || name === "workspace delete") {
        const action = name === "workspace resume" ? "wake" : name === "workspace stop" ? "stop" : "delete";
        await evidence.step(name.replace(" ", "_") as EvidenceEvent["phase"], () => services.api.lifecycle(handle, action, signal));
        const row = await evidence.step("workspace_wait", () => services.api.waitWorkspace(handle, action === "wake" ? "running" : action === "stop" ? "stopped" : "deleted", signal));
        result({ status: row.status, generation: row.generation.number, deletionConfirmed: handle.run.deletionConfirmed });
      } else if (name === "workspace status" || name === "health vm") {
        const row = await evidence.step("health_vm", () => services.api.workspace(handle.run, signal));
        result({ status: safeWorkspaceStatus(row.status), generation: row.generation.number, observed: safeObservedState(row.generation.observedState),
          observationAvailable: row.generation.lastObservedAt !== null });
      } else if (name === "health db") {
        await services.session.whoami(); await services.api.workspace(handle.run, signal);
        const row = await evidence.step("health_db", () => services.healthDb(handle.run));
        if (options["expect-runtime"] && (row.visibility !== "confirmed" || row.engine_runtime_id !== options["expect-runtime"])) throw new ZerosDevError("runtime_changed");
        result(row);
      } else if (name === "health cp-logs") {
        await services.session.whoami(); await services.api.workspace(handle.run, signal);
        result(await evidence.step("health_cp", () => services.healthLogs(handle.run)));
      } else if (name === "agent send") {
        const text = await input(String(options["prompt-file"]), 64 * 1024);
        const receipt = await runtimeWork(handle.run, runtime => evidence.step("agent_settled", () => runtime.prompt(handle,
          { id: options.prompt as string | undefined, agent: options.agent as Agent, model: String(options.model), text, continueFrom: options.continue as string | undefined }, signal)));
        result({ prompt: receipt.id, state: receipt.state });
      } else if (name === "chat tail") {
        const rows = await runtimeWork(handle.run, runtime => evidence.step("chat_tail", () => runtime.tail(String(options.prompt), signal)));
        for (const row of rows) await display("chat", row.payload);
        result({ count: rows.length });
      } else if (name === "terminal run") {
        const script = await input(String(options.script), 2048);
        const terminal = await runtimeWork(handle.run, runtime => evidence.step("terminal_run", () => runtime.terminal(handle, { id: options.command as string | undefined, script }, signal)));
        await display("terminal", terminal.output); result({ exitCode: terminal.exitCode, truncated: terminal.truncated });
        if (terminal.exitCode !== 0) throw new ZerosDevError("terminal_failed");
      } else if (name === "scenario run smoke") {
        const text = options["prompt-file"] ? await input(String(options["prompt-file"]), 64 * 1024) : "Reply exactly ZEROS_DEV_OK. Do not call any tools.";
        const health = await sourceCheck();
        services.write({ schema: "zeros.dev-context/v1", runId, deployedSource: health.sourceSha, ready: health.ready });
        if (!health.ready || !health.cloud.enabled) throw new ZerosDevError("service_unavailable");
        try {
          if (options["build-computer"]) {
            await evidence.step("computer_build", () => services.api.buildComputer(handle, signal));
            await evidence.step("computer_wait", () => services.api.waitComputer(handle.run, signal));
          }
          await evidence.step("workspace_create", () => services.api.createWorkspace(handle, signal));
          await evidence.step("workspace_wait", () => services.api.waitWorkspace(handle, "running", signal));
          for (const stage of ["before", "after"] as const) {
            if (stage === "after") {
              await evidence.step("workspace_stop", () => services.api.lifecycle(handle, "stop", signal));
              await evidence.step("workspace_wait", () => services.api.waitWorkspace(handle, "stopped", signal));
              await evidence.step("workspace_resume", () => services.api.lifecycle(handle, "wake", signal));
              await evidence.step("workspace_wait", () => services.api.waitWorkspace(handle, "running", signal));
            }
            await runtimeWork(handle.run, async runtime => {
              const marker = `.zeros-dev-${runId}`;
              const script = stage === "before" ? `set -e; git rev-parse --is-inside-work-tree; printf '%s' '${runId}' > '${marker}'` :
                `set -e; git rev-parse --is-inside-work-tree; test "$(cat '${marker}')" = '${runId}'`;
              const terminal = await evidence.step("terminal_run", () => runtime.terminal(handle, { script }, signal));
              if (terminal.exitCode !== 0) throw new ZerosDevError("terminal_failed");
              await evidence.step("agent_settled", () => runtime.prompt(handle, { id: scenarioPromptId(runId, stage),
                agent: options.agent as Agent, model: String(options.model), text,
                ...(stage === "after" ? { continueFrom: scenarioPromptId(runId, "before") } : {}) }, signal));
            });
          }
          await evidence.step("workspace_stop", () => services.api.lifecycle(handle, "stop", signal));
          await evidence.step("workspace_wait", () => services.api.waitWorkspace(handle, "stopped", signal));
        } finally {
          // A scenario owns its throwaway. Keep cleanup independent of its
          // expired/SIGINT work signal, but still finite and product-verified.
          await evidence.step("cleanup", () => services.api.cleanup(handle, true, AbortSignal.timeout(30_000)));
        }
        result({ complete: true, deletionConfirmed: handle.run.deletionConfirmed });
      }
    }, ["computer build", "workspace create", "scenario run smoke"].includes(name));
    return 0;
  } catch (error) {
    result({ outcome: "failed", code: closedError(error) }); return 1;
  }
}

function scenarioPromptId(runId: string, stage: string): string {
  const bytes = createHash("sha256").update(`zeros-dev-scenario:${runId}:${stage}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 80; bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString("hex"); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function safeWorkspaceStatus(value: string): string {
  return ["requested", "provisioning", "setting_up", "starting", "ready", "busy", "stopping", "stopped", "archiving", "archived", "deleting", "deleted", "failed"].includes(value) ? value : "unknown";
}
function safeObservedState(value: string): string { return ["running", "stopped", "archived", "deleted", "absent", "starting", "stopping"].includes(value) ? value : "unknown"; }
