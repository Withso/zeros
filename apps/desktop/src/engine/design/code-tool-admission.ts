import { createDesignCaptureRenderer } from "./capture-client";
import path from "node:path";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { composerModeInstruction } from "@zeros/protocol/composer-mode";
import { wrapSystemInstruction } from "@zeros/protocol/system-instructions";
import type {
  AgentSessionToolFactory,
  AgentSessionToolInput,
  AgentSessionTools,
} from "../agents/session-tools";
import { getWorkspaceById, type Workspace } from "../git";
import { opSettingsResolve } from "../settings/ops";
import type { DesignCodeToolTarget } from "./code-tools";
import { ConversationDesignTools, designPromptContext } from "./conversation-tools";
import type { ConversationModePort } from "./conversation-mode";
import {
  DESIGN_AGENT_CAPABILITY_ENV,
  DesignAgentMcpServer,
} from "./design-agent-mcp";
import {
  discoverDesignDirectories,
  resolveDesignDirectoryPointerState,
} from "./directory";
import {
  designDirectoryEntry,
  legacyDesignDirectoryId,
  designDirectoryFromSettings,
} from "./metadata";
import { hasInvalidDesignSettings } from "./directory-path";

/** Resolve once by registered owner. Tool arguments never choose a cwd or
 * workspace. A missing/ambiguous Design document leaves normal Code usable. */
interface TargetOptions {
  cloudWorker?: boolean;
  resolveWorkspace?: (id: string) => Workspace | null;
  workspaceIdForCwd?: (cwd: string) => string | null;
}
export async function resolveCodeDesignTarget(
  input: AgentSessionToolInput,
  options: TargetOptions = {},
): Promise<DesignCodeToolTarget | null> {
  if (!input.workspaceId) return null;
  const resolveWorkspace = options.resolveWorkspace ?? getWorkspaceById;
  const workspace = resolveWorkspace(input.workspaceId);
  if (
    !workspace ||
    workspace.archivedAt != null ||
    (!options.cloudWorker && workspace.placement === "cloud")
  )
    return null;
  if (
    options.workspaceIdForCwd &&
    options.workspaceIdForCwd(input.cwd) !== workspace.id
  )
    return null;
  const [cwd, root] = await Promise.all([
    realpath(input.cwd),
    realpath(workspace.path),
  ]);
  if (cwd !== root && !cwd.startsWith(`${root}${path.sep}`)) return null;
  const pointer = await resolveDesignDirectoryPointerState({
    repoRoot: workspace.repoRoot,
    workspacePath: workspace.path,
  });
  if (!pointer.valid) return null;
  const directories = await discoverDesignDirectories(workspace.path);
  const directory = pointer.configured
    ? pointer.directory
    : directories.length === 1
      ? directories[0]
      : undefined;
  if (!directory || !directories.includes(directory)) return null;
  const identity = () => designDirectoryEntry(workspace.path, directory) ??
    (existsSync(path.join(workspace.path, directory, ".zeros-canvas.json"))
      ? { id: legacyDesignDirectoryId(directory), path: directory } : undefined);
  const entry = identity();
  if (!entry) return null;
  return {
    workspaceId: workspace.id,
    workspacePath: workspace.path,
    directory,
    directoryId: entry.id,
    actorId: input.conversationId ?? input.executionId,
    assertCurrent: () => {
      input.signal.throwIfAborted();
      if (
        options.workspaceIdForCwd &&
        options.workspaceIdForCwd(input.cwd) !== workspace.id
      ) {
        throw new Error(
          "Design workspace authority changed; reopen the Code session.",
        );
      }
      const current = resolveWorkspace(workspace.id);
      if (
        !current ||
        current.archivedAt !== null ||
        current.path !== workspace.path ||
        current.repoRoot !== workspace.repoRoot ||
        current.placement !== workspace.placement ||
        current.organizationId !== workspace.organizationId
      )
        throw new Error(
          "Design workspace authority changed; reopen the Code session.",
        );
      if (
        identity()?.id !== entry.id
      )
        throw new Error(
          "Design directory was removed or replaced; reopen the Code session.",
        );
      const settings = opSettingsResolve(workspace.path, workspace.repoRoot);
      if (hasInvalidDesignSettings(settings.warnings))
        throw new Error("Design directory settings are invalid.");
      const selected = designDirectoryFromSettings(
        workspace.path,
        settings.effective,
      );
      if (
        (selected && selected !== directory) ||
        (pointer.configured && !selected)
      )
        throw new Error(
          "Design directory selection changed; reopen the Code session.",
        );
    },
  };
}

/** A fixed process-wide ceiling bounds sockets and retained document history.
 * Browsers/capture are deliberately not advertised without a qualified host. */
export class DesignCodeToolAdmissions {
  private count = 0;
  constructor(
    private readonly options: {
      cloudWorker?: boolean;
      onChanged?: (workspaceId: string) => void;
      mode?: (input: AgentSessionToolInput) => ConversationModePort;
      resolveTarget?: (
        input: AgentSessionToolInput,
      ) => Promise<DesignCodeToolTarget | null>;
    } & TargetOptions = {},
  ) {}

  private unavailable(input: AgentSessionToolInput, reason: string, nativeAllowed = false, assertOwner: () => void = () => {}): AgentSessionTools | null {
    const mode = this.options.mode?.(input);
    if (!mode) return null;
    nativeAllowed = nativeAllowed && !this.options.cloudWorker;
    let revoked = false;
    return {
      env: {},
      mcpServers: [],
      preparePrompt: async () => {
        input.signal.throwIfAborted();
        assertOwner();
        if (revoked) throw new Error("Session tools were retired.");
        const snapshot = mode.get();
        if (!nativeAllowed && snapshot.mode === "design")
          throw new Error(`Design tools are unavailable. ${reason}`);
        const assertCurrent = () => {
          input.signal.throwIfAborted();
          assertOwner();
          if (revoked || mode.get().revision !== snapshot.revision) throw new Error("Conversation changed before dispatch.");
        };
        const context = nativeAllowed ? await designPromptContext(() => (this.options.resolveTarget ?? ((value) => resolveCodeDesignTarget(value, this.options)))(input), snapshot.mode, assertCurrent) : reason;
        assertCurrent();
        return wrapSystemInstruction(`${composerModeInstruction(snapshot.mode, snapshot.revision, this.options.cloudWorker ? "api" : "native")} ${context} Design API tools are unavailable in this execution. Select modes with the composer. ${reason}`);
      },
      revoke: () => { revoked = true; },
      dispose: async () => { revoked = true; },
    };
  }

  readonly admit: AgentSessionToolFactory = async (
    input,
  ): Promise<AgentSessionTools | null> => {
    input.signal.throwIfAborted();
    if (this.count >= 16)
      return this.unavailable(input, "Close an unused agent execution and reopen this conversation to reconnect the Design API.", true);
    this.count += 1;
    let handler: ConversationDesignTools | undefined;
    let server: DesignAgentMcpServer | undefined;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        this.count -= 1;
      }
    };
    try {
      const resolveTarget = () => (this.options.resolveTarget ??
        ((value) => resolveCodeDesignTarget(value, this.options)))(input);
      // A broken Design registration must not prevent a Code session from
      // opening. Prompt/tool discovery retries it; owner checks remain below.
      const target = await resolveTarget().catch(() => null);
      input.signal.throwIfAborted();
      const resolveWorkspace = this.options.resolveWorkspace ?? getWorkspaceById;
      const workspace = input.workspaceId ? resolveWorkspace(input.workspaceId) : null;
      if (!target && (!workspace || workspace.archivedAt != null ||
          (!this.options.cloudWorker && workspace.placement === "cloud"))) {
        release();
        return this.unavailable(input, "Open this conversation in an active registered workspace.");
      }
      const workspacePath = workspace?.path ?? target!.workspacePath;
      const workspaceId = workspace?.id ?? target!.workspaceId;
      const [cwd, root] = await Promise.all([realpath(input.cwd), realpath(workspacePath)]);
      if (cwd !== root && !cwd.startsWith(`${root}${path.sep}`)) {
        release();
        return this.unavailable(input, "The conversation folder is outside its registered workspace.");
      }
      const assertOwner = () => {
        input.signal.throwIfAborted();
        const current = resolveWorkspace(workspaceId);
        if (workspace && (!current || current.archivedAt != null ||
            current.path !== workspace.path || current.repoRoot !== workspace.repoRoot ||
            current.placement !== workspace.placement || current.organizationId !== workspace.organizationId))
          throw new Error("The workspace owning these Design tools changed.");
        if (this.options.workspaceIdForCwd && this.options.workspaceIdForCwd(input.cwd) !== workspaceId)
          throw new Error("The workspace owning these Design tools changed.");
      };
      assertOwner();
      handler = new ConversationDesignTools({
        mode: this.options.mode?.(input) ?? {
          get: () => ({ mode: "code", revision: 0 }),
          set: () => { throw new Error("A conversation is required to switch Design mode."); },
        },
        assertOwner,
        resolveTarget,
        authoringMethod: this.options.cloudWorker ? "api" : "native",
        renderer: createDesignCaptureRenderer(workspacePath),
        onChanged: () => this.options.onChanged?.(workspaceId),
      });
      server = new DesignAgentMcpServer({ handler, token: handler.token });
      try {
        await server.start();
      } catch {
        handler.dispose();
        await server.stop();
        release();
        input.signal.throwIfAborted();
        assertOwner();
        return this.unavailable(input, "The Design API connection could not start. Reopen the conversation to reconnect helpers.", true, assertOwner);
      }
      input.signal.throwIfAborted();
      const admittedHandler = handler;
      const admittedServer = server;
      let disposal: Promise<void> | undefined;
      return {
        env: { [DESIGN_AGENT_CAPABILITY_ENV]: `Bearer ${handler.token}` },
        mcpServers: [server.registration],
        preparePrompt: () => admittedHandler.preparePrompt(),
        beginPrompt: () => admittedHandler.beginPrompt(),
        cancel: () => admittedHandler.cancel(),
        suspend: () => admittedHandler.suspend(),
        revoke: () => admittedHandler.dispose(),
        dispose: () => {
          admittedHandler.dispose();
          return (disposal ??= admittedServer.stop().finally(release));
        },
      };
    } catch (error) {
      handler?.dispose();
      await server?.stop();
      release();
      throw error;
    }
  };
}
