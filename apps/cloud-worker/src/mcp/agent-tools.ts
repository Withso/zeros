import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CodeReviewError, type CodeReviewAgentToolsCore } from "@zeros/protocol/code-review";
import { LOCAL_COMMAND_LIMITS, LocalCommandInputSchema, type LocalCommandInput, type LocalCommandResult } from "@zeros/protocol/local-commands";
import { NOTIFY_USER_KINDS, NOTIFY_USER_LIMITS, NotifyUserInputSchema, type NotifyUserInput } from "@zeros/protocol/notify-user";
import type { NotifyUserOutcome } from "../notify-user/service";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
type ToolDefinition = { name: string; description: string; inputSchema: { type: "object"; [key: string]: unknown } };
/** What one per-execution grant serves. Review tools are one optional part. */
export interface AgentToolSet {
  /** False when the set was admitted without review tools. */
  readonly includesReview?: boolean;
  /** Present on sets whose review part can be withdrawn without retiring the rest. */
  withdrawReview?(): void;
  readonly instructions?: string;
  assertCurrent(): void;
  listTools(): ToolDefinition[];
  callTool(name: string, raw: unknown, signal: AbortSignal): Promise<ToolResult>;
}

export const WORKSPACE_TOOL_INSTRUCTIONS = [
  "Zeros cloud workspace tools. GetTerminalOutput reads the newest lines of this workspace's terminals (the most recently active one unless terminalId is given; source selects a shell, a run script or the setup output).",
  "GetWorkspaceDiff shows this branch's changes against its merge base, including uncommitted and untracked work, the comparison the Changes view calls All; pass stat for a file list or file for one path.",
  "The `zeros cloud` command line (run `zeros cloud --help`) reads and drives Zeros cloud workspaces, sessions and messages through the Zeros API when API access is enabled for this workspace.",
].join(" ");

const DEFAULT_LINES = 1000, MAX_LINES = 2000, MAX_ID = 256, MAX_PATH = 4096;
/** Only what a cloud worker has: shared shells, run-script terminals and the setup log. */
const SOURCES = ["auto", "terminal", "run_script", "setup"] as const;
export type TerminalSource = typeof SOURCES[number];
const definitions: ToolDefinition[] = [
  { name: "GetTerminalOutput", description: "Read the newest lines of a terminal in this workspace, read-only. Without terminalId, the most recently active one of the chosen source.",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      maxLines: { type: "integer", minimum: 1, maximum: MAX_LINES, default: DEFAULT_LINES, description: "Newest lines to return." },
      terminalId: { type: "string", minLength: 1, maxLength: MAX_ID, description: "A terminal's id; omit for the most recently active one." },
      source: { type: "string", enum: [...SOURCES], default: "auto",
        description: "auto: any terminal; terminal: a shell; run_script: a run script; setup: the workspace's setup output." },
    } } },
  { name: "GetWorkspaceDiff", description: "Read this branch's changes against its merge base, including uncommitted and untracked work (the Changes view's All). Read-only and size-bounded.",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      stat: { type: "boolean", description: "Only list changed files with line counts." },
      file: { type: "string", minLength: 1, maxLength: MAX_PATH, description: "Limit the diff to one workspace path." },
    } } },
];

class ToolInputError extends Error { constructor(readonly code: string, message: string) { super(message); } }
function object(raw: unknown, allowed: readonly string[]): Record<string, unknown> {
  const value = raw ?? {};
  if (typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key)))
    throw new ToolInputError("INVALID_INPUT", `Accepted fields: ${allowed.join(", ")}.`);
  return value as Record<string, unknown>;
}
const failure = (code: string, message: string): ToolResult => ({ isError: true, content: [{ type: "text", text: JSON.stringify({ code, message }) }] });
const truncatedNote = "\n[Output truncated to the tool's size limit.]";

const notifyUserDefinition: ToolDefinition = { name: "NotifyUser",
  description: "Tell the person who sent this chat's latest message that you need them: something is ready to review, or you are blocked on them. " +
    "Call it at most once per turn, at the end of the turn, never for progress updates. They get a notification on their Mac that opens this chat. " +
    "The title can show on a lock screen: keep secrets, tokens and private data out of it.",
  inputSchema: { type: "object", additionalProperties: false, required: ["title", "message", "kind"], properties: {
    title: { type: "string", minLength: 1, maxLength: NOTIFY_USER_LIMITS.titleChars, description: "What you need, in a few words; shown in the notification." },
    message: { type: "string", minLength: 1, maxLength: NOTIFY_USER_LIMITS.messageChars, description: "One or two sentences shown in the app." },
    kind: { type: "string", enum: [...NOTIFY_USER_KINDS], description: "review: something is ready for them; blocked: you cannot continue without them." },
  } } };
const NOTIFY_USER_TEXT: Record<NotifyUserOutcome, (title: string) => string> = {
  sent: title => `Notified the person: ${title}. Do not call NotifyUser again this turn.`,
  unreachable: title => `Shown in any open Zeros app: ${title}. The control plane could not be reached, so their Mac may not get a notification.`,
  already_notified: () => "Already notified this turn; not sent again.",
  rate_limited: () => "Not sent: this workspace reached its notification limit for the hour.",
  no_turn: () => "NotifyUser works only while a turn is running.",
};

const localCommandDefinition: ToolDefinition = { name: "RunLocalCommand",
  description: "Run one shell command on the Mac of the person who sent this chat's latest message, in their login shell, after they approve it there. " +
    "Use it for things only their Mac can do (local apps, simulators, files outside this workspace). It never runs in this workspace's VM. " +
    "It is one-shot: when the shell exits its whole process group is ended, so a process started with & does not survive, " +
    "and one that keeps stdout or stderr open holds the command until its timeout (redirect it to /dev/null).",
  inputSchema: { type: "object", additionalProperties: false, required: ["command"], properties: {
    command: { type: "string", minLength: 1, maxLength: LOCAL_COMMAND_LIMITS.commandChars, description: "The command line, run by the Mac's login shell." },
    cwd: { type: "string", maxLength: LOCAL_COMMAND_LIMITS.cwdChars, description: "Directory on the Mac; defaults to the home directory, relative paths resolve from it." },
    description: { type: "string", maxLength: LOCAL_COMMAND_LIMITS.textChars, description: "What the command does, shown in the approval." },
    reason: { type: "string", maxLength: LOCAL_COMMAND_LIMITS.textChars, description: "Why it is needed, shown in the approval." },
    timeoutMs: { type: "integer", minimum: 1, maximum: LOCAL_COMMAND_LIMITS.extendedTimeoutMs, default: LOCAL_COMMAND_LIMITS.defaultTimeoutMs,
      description: "Up to 120000; up to 1800000 only with extendedTimeoutReason." },
    extendedTimeoutReason: { type: "string", maxLength: LOCAL_COMMAND_LIMITS.textChars, description: "Required for a timeout above 120 s; shown in the approval." },
    mac: { type: "string", maxLength: LOCAL_COMMAND_LIMITS.macChars, description: "Another connected Mac of the same person, by name. Omit to use the Mac the latest message came from." },
  } } };

/** One line per outcome; an approval timeout is never described as a denial. */
const OUTCOME_TEXT: Record<Exclude<LocalCommandResult["outcome"], "completed">, (mac: string, error?: string) => string> = {
  failed: (mac, error) => error === "cwd_not_found" ? `That directory does not exist on ${mac}; the command did not run.`
    : `The login shell on ${mac} could not start the command; it did not run.`,
  denied: mac => `The person declined this command on ${mac}; it did not run.`,
  approval_timed_out: mac => `No one answered the approval on ${mac} within 120 s, so the command did not run. Ask the person before trying again.`,
  command_timed_out: mac => `The command ran past its timeout on ${mac} and was stopped.`,
  mac_not_connected: () => "That Mac is not connected to this workspace, so the command did not run.",
  no_target: () => "This chat's latest message did not come from a Zeros Mac app, so there is no Mac to run on.",
  disabled: () => "Local commands are turned off for this organization.",
  cancelled: () => "The command was cancelled (Stop).",
  interrupted: mac => `The Zeros app on ${mac} restarted before the command finished; it was not run again.`,
};

function formatLocalCommand(result: LocalCommandResult): string {
  const mac = result.mac ?? "the Mac";
  const lines = [`outcome: ${result.outcome}`, ...(result.mac ? [`mac: ${result.mac}`] : [])];
  if (result.outcome !== "completed") lines.push(OUTCOME_TEXT[result.outcome](mac, result.error));
  if (result.error) lines.push(`error: ${result.error}`);
  if (result.cwd) lines.push(`cwd: ${result.cwd}`);
  if (result.code !== undefined && result.code !== null) lines.push(`exit code: ${result.code}`);
  let text = lines.join("\n") + "\n";
  if (result.stdout) text += `--- stdout ---\n${result.stdout}${result.stdout.endsWith("\n") ? "" : "\n"}`;
  if (result.stdoutTruncated) text += "[stdout truncated on the Mac at 1 MiB]\n";
  if (result.stderr) text += `--- stderr ---\n${result.stderr}${result.stderr.endsWith("\n") ? "" : "\n"}`;
  if (result.stderrTruncated) text += "[stderr truncated on the Mac at 1 MiB]\n";
  return text;
}

export interface WorkspaceAgentToolOptions {
  assertCurrent(): void;
  terminalOutput(input: { terminalId?: string; maxLines: number; source: TerminalSource }): Promise<{ terminalId: string; lines: string[]; truncated: boolean } | undefined>;
  diff(input: { stat?: boolean; file?: string }): Promise<{ text: string; truncated: boolean }>;
  review?: CodeReviewAgentToolsCore;
  /** Present only while this worker and its organization allow local commands. */
  localCommands?: { run(input: LocalCommandInput, signal: AbortSignal): Promise<{ result: LocalCommandResult; acknowledge(): Promise<void> }>; checkout: string };
  /** notify-user-v1: present only when the configuration carries notifyUser: 1. */
  notifyUser?: { notify(input: NotifyUserInput, signal: AbortSignal): Promise<NotifyUserOutcome> };
}

/** The product tools every native execution receives over `zeros_workspace`.
 * Review tools join only while review is enabled for that execution. */
export class WorkspaceAgentTools implements AgentToolSet {
  readonly instructions = WORKSPACE_TOOL_INSTRUCTIONS;
  readonly includesReview: boolean;
  private review?: CodeReviewAgentToolsCore;
  constructor(private readonly options: WorkspaceAgentToolOptions) { this.review = options.review; this.includesReview = !!options.review; }

  /** While review tools are part of the grant, the whole grant keeps their
   * fence (Stop, review configuration), exactly as a review-only grant did. */
  assertCurrent(): void { this.options.assertCurrent(); this.review?.assertCurrent(); }
  withdrawReview(): void { this.review = undefined; }

  listTools(): ToolDefinition[] {
    this.assertCurrent();
    return [...definitions, ...(this.options.localCommands ? [localCommandDefinition] : []), ...(this.options.notifyUser ? [notifyUserDefinition] : []),
      ...(this.review?.listTools() ?? [])];
  }

  async callTool(name: string, raw: unknown, signal: AbortSignal): Promise<ToolResult> {
    this.assertCurrent();
    signal.throwIfAborted();
    if (name === "RunLocalCommand" && this.options.localCommands) return this.runLocalCommand(this.options.localCommands, raw, signal);
    if (name === "NotifyUser" && this.options.notifyUser) return this.notifyUser(this.options.notifyUser, raw, signal);
    if (name !== "GetTerminalOutput" && name !== "GetWorkspaceDiff") {
      if (!this.review) throw new CodeReviewError("CODE_REVIEW_INVALID", "Unknown workspace tool.");
      return this.review.callTool(name, raw, signal);
    }
    try {
      if (name === "GetTerminalOutput") {
        const input = object(raw, ["maxLines", "terminalId", "source"]);
        const maxLines = input.maxLines ?? DEFAULT_LINES;
        if (typeof maxLines !== "number" || !Number.isInteger(maxLines) || maxLines < 1 || maxLines > MAX_LINES)
          throw new ToolInputError("INVALID_INPUT", `maxLines must be a whole number from 1 to ${MAX_LINES}.`);
        if (input.terminalId !== undefined && (typeof input.terminalId !== "string" || !input.terminalId || input.terminalId.length > MAX_ID))
          throw new ToolInputError("INVALID_INPUT", "terminalId must be a terminal's id.");
        const source = input.source ?? "auto";
        if (typeof source !== "string" || !(SOURCES as readonly string[]).includes(source))
          throw new ToolInputError("INVALID_INPUT", `source must be one of ${SOURCES.join(", ")}.`);
        if (source === "setup" && input.terminalId !== undefined) throw new ToolInputError("INVALID_INPUT", "The setup output has no terminalId.");
        const output = await this.options.terminalOutput({ ...(input.terminalId === undefined ? {} : { terminalId: input.terminalId as string }), maxLines, source: source as TerminalSource });
        this.assertCurrent();
        if (!output) return failure("TERMINAL_NOT_FOUND", source === "setup" ? "This workspace has no setup output."
          : input.terminalId === undefined ? "This workspace has no open terminal of that kind." : "No open terminal of that kind has that id.");
        return { content: [{ type: "text", text: output.lines.join("\n") + (output.truncated ? truncatedNote : "") }] };
      }
      const input = object(raw, ["stat", "file"]);
      if (input.stat !== undefined && typeof input.stat !== "boolean") throw new ToolInputError("INVALID_INPUT", "stat must be true or false.");
      if (input.file !== undefined && (typeof input.file !== "string" || !input.file || input.file.length > MAX_PATH))
        throw new ToolInputError("INVALID_INPUT", "file must be a workspace path.");
      const diff = await this.options.diff({ ...(input.stat === undefined ? {} : { stat: input.stat as boolean }), ...(input.file === undefined ? {} : { file: input.file as string }) });
      this.assertCurrent();
      return { content: [{ type: "text", text: (diff.text || "No changes.") + (diff.truncated ? truncatedNote : "") }] };
    } catch (error) {
      if (error instanceof ToolInputError) return failure(error.code, error.message);
      const code = (error as { code?: unknown })?.code;
      if (code === "VALIDATION_FAILED") return failure("INVALID_INPUT", "That path is outside this workspace.");
      this.assertCurrent();
      return failure("WORKSPACE_TOOL_UNAVAILABLE", "The workspace tool request could not complete.");
    }
  }

  private async notifyUser(notify: NonNullable<WorkspaceAgentToolOptions["notifyUser"]>, raw: unknown, signal: AbortSignal): Promise<ToolResult> {
    const parsed = NotifyUserInputSchema.safeParse(raw ?? {});
    if (!parsed.success) return failure("INVALID_INPUT", parsed.error.issues[0]?.message ?? "Invalid NotifyUser input.");
    const outcome = await notify.notify(parsed.data, signal);
    this.assertCurrent();
    const text = NOTIFY_USER_TEXT[outcome](parsed.data.title);
    return { content: [{ type: "text", text }], ...(outcome === "rate_limited" || outcome === "no_turn" ? { isError: true } : {}) };
  }

  private async runLocalCommand(local: NonNullable<WorkspaceAgentToolOptions["localCommands"]>, raw: unknown, signal: AbortSignal): Promise<ToolResult> {
    const parsed = LocalCommandInputSchema.safeParse(raw ?? {});
    if (!parsed.success) return failure("INVALID_INPUT", parsed.error.issues[0]?.message ?? "Invalid RunLocalCommand input.");
    let outcome: { result: LocalCommandResult; acknowledge(): Promise<void> };
    try { outcome = await local.run(parsed.data, signal); }
    catch (error) {
      this.assertCurrent();
      // Unknown is not an outcome: the command may still have run.
      return failure("LOCAL_COMMAND_UNKNOWN", error instanceof Error && error.message ? error.message : "The local command's outcome is unknown.");
    }
    const { result } = outcome;
    this.assertCurrent();
    let text = formatLocalCommand(result);
    if (text.length > LOCAL_COMMAND_LIMITS.inlineChars) {
      const directory = join(local.checkout, ".context", "local-commands");
      const path = join(directory, `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.txt`);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(path, text, { mode: 0o600, flag: "wx" });
      const head = text.slice(0, text.indexOf("--- ") >= 0 ? text.indexOf("--- ") : 600).slice(0, 600);
      text = `${head}Output is ${text.length} characters, saved to ${path}\n`;
    }
    // Retained here (inline or saved), so the control plane may erase its copy.
    await outcome.acknowledge();
    return { content: [{ type: "text", text }], ...(result.outcome === "completed" ? {} : { isError: true }) };
  }
}
