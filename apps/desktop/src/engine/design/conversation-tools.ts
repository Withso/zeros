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
import { assertLegacyDesignDraftWritable, readDirectoryDesignManifest } from "./metadata";
import { initializeDesignDocumentUnlocked } from "./document-transactions";
import { withDesignDirectoryNameLease } from "./directory-registry";
import { openDesignVerification } from "./verification-service";
import { readDesignPageContext } from "./page-selection";
import { DesignTargetError } from "./target-error";
import type { AgentWorkspaceTools } from "../agents/session-tools";

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
    await withDesignDirectoryNameLease(target.workspacePath, target.directory, () =>
      initializeDesignDocumentUnlocked(target.workspacePath));
    target.assertCurrent();
  });
  const context = await readDesignPageContext(target);
  assertCurrent();
  target.assertCurrent();
  const active = context.pages.find(page => page.id === context.activePageId)!;
  const location = active.folder ? `${active.folder}/` : "the Design root (legacy layout)";
  const selection = context.hinted
    ? `The user is viewing page ${JSON.stringify(active.title)} (pageId ${JSON.stringify(active.id)}, folder ${JSON.stringify(location)}); add new frames there unless the user says otherwise.`
    : context.pages.length > 1
      ? `No current page hint is available; default to the first page ${JSON.stringify(active.title)} (pageId ${JSON.stringify(active.id)}, folder ${JSON.stringify(location)}) unless the user says otherwise.`
      : `Active page: ${JSON.stringify(active.title)} (pageId ${JSON.stringify(active.id)}, folder ${JSON.stringify(location)}).`;
  return `Active Design directory (relative to workspace ${JSON.stringify(target.workspacePath)}): ${JSON.stringify(target.directory)}. Its registration ID is ${JSON.stringify(target.directoryId)}.\nPages: ${JSON.stringify(context.pages.map(({ id, title, folder }) => ({ id, title, folder })))}. ${selection} API frame creation/duplication must supply pageId when several pages exist; the hint never selects a mutation target.`;
}

/** Design discovery is optional for local prompts, including conflict repair.
 * Ownership and cancellation must still be checked after a failed lookup. */
export async function designPromptContext(
  resolveTarget: () => Promise<DesignCodeToolTarget | null>,
  mode: "code" | "design",
  assertCurrent: () => void,
  authoringMethod: DesignAuthoringMethod = "native",
): Promise<string> {
  assertCurrent();
  let target: DesignCodeToolTarget | null = null;
  try {
    target = await resolveTarget();
    const context = await nativeDesignContext(target, mode, assertCurrent);
    if (authoringMethod !== "native" || !target || !readDirectoryDesignManifest(target.workspacePath, target.directory)) return context;
    const verification = await openDesignVerification(target);
    assertCurrent();
    return `${context}\nNative frame verification is available through ordinary shell commands: ${verification.command} <list|validate|capture|preview> --url '${verification.url}' --frame '<page.folder>/<name>.html'. Omit --frame for list. Capture requires --output '<png-output-path>'; use --revision to require a previously validated source revision. ${verification.captureAvailable ? "Capture uses the native PNG renderer; inspect its saved PNG with your normal image tool." : "PNG capture is unavailable on this host; validation and the HTTP preview remain available."} Preview returns an HTTP URL using the canvas's sanitized HTML/CSS and assets. Use the browser actually available through your provider's native browser tooling; do not assume an iab backend exists or navigate to file://. A successful lint or capture is not proof of visual inspection or application behavior. Verification URLs expire after 30 minutes; request fresh frame context if expired.`;
  } catch (error) {
    assertCurrent();
    target?.assertCurrent();
    if (error instanceof DesignTargetError) throw error;
    if (authoringMethod === "api" && mode === "design") throw error;
    return authoringMethod === "native"
      ? "The Design canvas or registration is currently unavailable. Normal tools remain available to inspect and repair the existing source and Git conflicts. Preserve directory/frame IDs; do not recreate registration to bypass a conflict. Refresh the canvas after resolving the source."
      : "Design inspection is currently unavailable. Resolve the Design directory configuration before using Design tools.";
  }
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
    "Change the conversation's default editing intent when requested. Local Code and Design use the same normal tools; switching is not required for an explicit source edit or Git operation. API-only workers retain their Design authoring policy. Use expectedRevision from the prompt or design_capabilities.",
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
      workspaceTools?: AgentWorkspaceTools;
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
    this.options.workspaceTools?.assertCurrent();
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
    const context = await designPromptContext(() => this.options.resolveTarget(), snapshot.mode, assertCurrent, this.options.authoringMethod);
    assertCurrent();
    return wrapSystemInstruction(`${composerModeInstruction(snapshot.mode, snapshot.revision, this.options.authoringMethod)} ${context}`);
  }

  listTools(): Tool[] {
    return [
      ...(this.options.workspaceTools?.listTools() ?? []),
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
            requireDesignMode: this.options.authoringMethod === "api",
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
    if (this.options.workspaceTools?.listTools().some((tool) => tool.name === name))
      return this.options.workspaceTools.callTool(name, raw, joined);
    const before = this.options.mode.get();
    if (name === "design_mode_set") {
      const input = switchSchema.parse(raw);
      if (input.expectedRevision !== before.revision) throw new Error("Composer mode changed.");
      const context = await designPromptContext(() => this.options.resolveTarget(), input.mode, () => {
        this.assertActive(this.token);
        joined.throwIfAborted();
        if (this.options.mode.get().revision !== before.revision) throw new Error("Composer mode changed.");
      }, this.options.authoringMethod);
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
    const modeRequired = this.options.authoringMethod === "api";
    if (writes && modeRequired && before.mode !== "design")
      throw new Error("Switch to Design mode before editing designs.");
    const handler = await this.target();
    joined.throwIfAborted();
    if (writes && modeRequired && this.options.mode.get().revision !== before.revision)
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
          (!modeRequired || this.options.mode.get().mode === "design") && !!handler,
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
