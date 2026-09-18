import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { DesignHeadlessRenderer } from "@zeros/design-web";
import {
  composerModeInstruction,
  composerModeSchema,
  type DesignAuthoringMethod,
} from "@zeros/protocol/composer-mode";
import { wrapSystemInstruction } from "@zeros/protocol/system-instructions";
import {
  DesignCodeTools,
  designCodeToolDefinitions,
  isDesignWriteTool,
  type DesignCodeToolTarget,
} from "./code-tools";
import type { DesignMcpToolHandler } from "./design-agent-mcp";
import type { ConversationModePort } from "./conversation-mode";
import { withDesignWorkspaceMutation } from "./document-write-lock";
import { assertLegacyDesignDraftWritable, ensureDesignMetadataLayout, readDirectoryDesignManifest } from "./metadata";
import { initializeDesignDocumentUnlocked } from "./document-transactions";
import { withDesignDirectoryNameLease } from "./directory-registry";

/** Registration migration is an explicit Design authoring action. Merely
 * inspecting a legacy branch never rewrites its checked-out metadata. */
export async function nativeDesignContext(target: DesignCodeToolTarget | null, mode: "code" | "design", assertCurrent: () => void = () => {}): Promise<string> {
  assertCurrent();
  if (!target) return "No unique active Design directory is selected. Use Create design directory or select one in the Design tab before authoring; do not guess or create registration files yourself.";
  target.assertCurrent();
  if (mode === "design") await withDesignWorkspaceMutation(target.workspacePath, async () => {
    assertCurrent();
    target.assertCurrent();
    assertLegacyDesignDraftWritable(target.workspacePath);
    if (readDirectoryDesignManifest(target.workspacePath, target.directory)?.canvas)
      ensureDesignMetadataLayout(target.workspacePath, target.directory);
    else await withDesignDirectoryNameLease(target.workspacePath, target.directory, () =>
      initializeDesignDocumentUnlocked(target.workspacePath));
    target.assertCurrent();
  });
  return `Active Design directory (relative to workspace ${JSON.stringify(target.workspacePath)}): ${JSON.stringify(target.directory)}. Its registration ID is ${JSON.stringify(target.directoryId)}.`;
}

/** Design discovery is optional for Code prompts, including conflict repair.
 * Ownership and cancellation must still be checked after a failed lookup. */
export async function designPromptContext(
  resolveTarget: () => Promise<DesignCodeToolTarget | null>,
  mode: "code" | "design",
  assertCurrent: () => void,
): Promise<string> {
  assertCurrent();
  let target: DesignCodeToolTarget | null;
  try {
    target = await resolveTarget();
  } catch (error) {
    assertCurrent();
    if (mode === "design") throw error;
    return "Design inspection is currently unavailable. Resolve the Design directory configuration before using Design tools.";
  }
  return nativeDesignContext(target, mode, assertCurrent);
}

const switchSchema = z
  .object({
    mode: composerModeSchema,
    expectedRevision: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
const switchTool: Tool = {
  name: "design_mode_set",
  description:
    "Change this conversation's composer mode only when the user's request authorizes the work. Use expectedRevision from the current prompt or design_capabilities. The response supplies instructions for continuing in the same conversation; provider permissions are unchanged.",
  inputSchema: z.toJSONSchema(switchSchema) as Tool["inputSchema"],
};
const deferred = new Set([
  "design_proposal_create",
  "design_proposal_resolve",
  "design_result_create",
  "design_result_list",
  "design_result_read",
]);
const textResult = (value: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
});

/** Stable MCP schemas allow native providers to switch within a running turn.
 * Schema discovery is not mutation authority: every write checks the current
 * mode and generation again at journal admission. No executor/catalog reload. */
export class ConversationDesignTools implements DesignMcpToolHandler {
  readonly token = randomBytes(32).toString("hex");
  private readonly abort = new AbortController();
  private turn = new AbortController();
  private handler?: DesignCodeTools;
  private ready?: Promise<DesignCodeTools | null>;
  private document = new AbortController();
  private paused = 0;
  private directoryAcknowledged = false;

  constructor(
    private readonly options: {
      mode: ConversationModePort;
      assertOwner(): void;
      resolveTarget(): Promise<DesignCodeToolTarget | null>;
      authoringMethod?: DesignAuthoringMethod;
      renderer?: DesignHeadlessRenderer;
      onChanged?: () => void;
    },
  ) {}

  assertActive(token: string): void {
    const supplied = Buffer.from(token);
    const expected = Buffer.from(this.token);
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      throw new Error("Invalid Design authority.");
    this.abort.signal.throwIfAborted();
    this.options.assertOwner();
  }

  dispose(): void {
    this.abort.abort();
    this.handler?.dispose();
  }

  cancel(): void {
    this.turn.abort();
  }

  beginPrompt(): void {
    if (this.turn.signal.aborted) this.turn = new AbortController();
  }

  suspend(): () => void {
    this.paused += 1;
    this.document.abort();
    this.handler?.dispose();
    this.handler = undefined;
    this.directoryAcknowledged = false;
    this.ready = undefined;
    let resumed = false;
    return () => {
      if (resumed) return;
      resumed = true;
      if (--this.paused === 0) this.document = new AbortController();
    };
  }

  async preparePrompt(): Promise<string> {
    this.assertActive(this.token);
    this.turn.signal.throwIfAborted();
    const snapshot = this.options.mode.get();
    const generation = AbortSignal.any([this.turn.signal, this.document.signal]);
    const assertCurrent = () => {
      this.assertActive(this.token);
      generation.throwIfAborted();
      if (this.paused || this.options.mode.get().revision !== snapshot.revision)
        throw new Error("Composer mode or Design directory changed before dispatch; retry the prompt.");
    };
    const context = await designPromptContext(() => this.options.resolveTarget(), snapshot.mode, assertCurrent);
    assertCurrent();
    return wrapSystemInstruction(`${composerModeInstruction(snapshot.mode, snapshot.revision, this.options.authoringMethod)} ${context}`);
  }

  listTools(): Tool[] {
    return [
      switchTool,
      ...designCodeToolDefinitions(!!this.options.renderer).filter(
        (tool) => !deferred.has(tool.name),
      ),
    ];
  }

  private async target(): Promise<DesignCodeTools | null> {
    if (this.handler) return this.handler;
    // Share a single first-document lookup. An absent directory is not cached:
    // Create design directory must work without rebuilding the conversation.
    if (!this.ready) {
      const generation = this.document.signal;
      const ready = this.options
        .resolveTarget()
        .then((target) => {
          generation.throwIfAborted();
          this.assertActive(this.token);
          if (!target) return null;
          this.handler = new DesignCodeTools(target, {
            mode: () => this.options.mode.get(),
            renderer: this.options.renderer,
            onChanged: this.options.onChanged,
          });
          return this.handler;
        })
        .finally(() => {
          if (this.ready === ready) this.ready = undefined;
        });
      this.ready = ready;
    }
    return this.ready;
  }

  async callTool(
    name: string,
    raw: unknown,
    signal: AbortSignal,
  ): Promise<CallToolResult> {
    this.assertActive(this.token);
    if (this.paused)
      throw new Error(
        "The Design directory is changing. Retry after the directory operation finishes.",
      );
    const joined = AbortSignal.any([
      signal,
      this.abort.signal,
      this.turn.signal,
      this.document.signal,
    ]);
    joined.throwIfAborted();
    if (!this.listTools().some((tool) => tool.name === name))
      throw new Error("This Design tool is unavailable.");
    const before = this.options.mode.get();
    if (name === "design_mode_set") {
      const input = switchSchema.parse(raw);
      if (input.expectedRevision !== before.revision) throw new Error("Composer mode changed.");
      const context = await designPromptContext(() => this.options.resolveTarget(), input.mode, () => {
        this.assertActive(this.token);
        joined.throwIfAborted();
        if (this.options.mode.get().revision !== before.revision) throw new Error("Composer mode changed.");
      });
      joined.throwIfAborted();
      const composerMode = this.options.mode.set(
        input.mode,
        input.expectedRevision,
      );
      return textResult({
        composerMode,
        systemInstruction: `${composerModeInstruction(composerMode.mode, composerMode.revision, this.options.authoringMethod)} ${context}`,
      });
    }
    const writes = isDesignWriteTool(name, raw);
    if (writes && before.mode !== "design")
      throw new Error("Switch to Design mode before editing designs.");
    const handler = await this.target();
    joined.throwIfAborted();
    if (writes && this.options.mode.get().revision !== before.revision)
      throw new Error(
        "Composer mode changed before this Design edit was admitted.",
      );
    if (name === "design_capabilities") {
      z.object({}).strict().parse(raw);
      const result = handler ? await handler.callTool(name, raw, joined) : null;
      const first = result?.content[0];
      const capabilities =
        first?.type === "text"
          ? JSON.parse(first.text)
          : { version: 1, directoryId: null };
      joined.throwIfAborted();
      this.directoryAcknowledged = !!handler;
      return textResult({
        ...capabilities,
        composerMode: this.options.mode.get(),
        tools: this.listTools().map((tool) => tool.name),
        designWritesEnabled:
          this.options.mode.get().mode === "design" && !!handler,
        ...(!handler
          ? {
              instruction:
                "Open the Design tab and use Create design directory, then call design_capabilities again in this conversation.",
            }
          : {}),
      });
    }
    if (!handler)
      throw new Error(
        "Create or select a design directory in the Design tab, then retry in this conversation.",
      );
    if (writes && !this.directoryAcknowledged)
      throw new Error(
        "Read design_capabilities for the active directory before editing designs.",
      );
    const result = await handler.callTool(name, raw, joined);
    if (name === "design_capture" && result.content[0]?.type === "text") {
      const { data, ...metadata } = JSON.parse(result.content[0].text);
      // Native MCP image content reaches the model and the existing bounded
      // tool-output renderer. Never syntax-highlight a megabyte of base64.
      return {
        content: [
          { type: "text", text: JSON.stringify(metadata) },
          { type: "image", data, mimeType: "image/png" },
        ],
      };
    }
    return result;
  }
}
