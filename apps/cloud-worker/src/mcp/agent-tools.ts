import { CodeReviewError, type CodeReviewAgentToolsCore } from "@zeros/protocol/code-review";

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

export interface WorkspaceAgentToolOptions {
  assertCurrent(): void;
  terminalOutput(input: { terminalId?: string; maxLines: number; source: TerminalSource }): Promise<{ terminalId: string; lines: string[]; truncated: boolean } | undefined>;
  diff(input: { stat?: boolean; file?: string }): Promise<{ text: string; truncated: boolean }>;
  review?: CodeReviewAgentToolsCore;
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
    return [...definitions, ...(this.review?.listTools() ?? [])];
  }

  async callTool(name: string, raw: unknown, signal: AbortSignal): Promise<ToolResult> {
    this.assertCurrent();
    signal.throwIfAborted();
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
}
