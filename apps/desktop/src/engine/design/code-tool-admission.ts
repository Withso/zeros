import { createDesignCaptureRenderer } from "./capture-client";
import path from "node:path";
import { realpath } from "node:fs/promises";
import type {
  AgentSessionToolFactory,
  AgentSessionToolInput,
  AgentSessionTools,
} from "../agents/session-tools";
import { getWorkspaceById, type Workspace } from "../git";
import { opSettingsResolve } from "../settings/ops";
import { DesignCodeTools, type DesignCodeToolTarget } from "./code-tools";
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
  designDirectoryFromSettings,
  readDirectoryDesignManifest,
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
  const entry = designDirectoryEntry(workspace.path, directory);
  if (!entry) return null;
  // Keep the legacy registry readable, but only admit tools after the Design
  // engine has migrated that document into a manifest with a durable ID.
  if (readDirectoryDesignManifest(workspace.path, directory)?.id !== entry.id)
    return null;
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
        readDirectoryDesignManifest(workspace.path, directory)?.id !== entry.id
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
      resolveTarget?: (
        input: AgentSessionToolInput,
      ) => Promise<DesignCodeToolTarget | null>;
    } & TargetOptions = {},
  ) {}

  readonly admit: AgentSessionToolFactory = async (
    input,
  ): Promise<AgentSessionTools | null> => {
    input.signal.throwIfAborted();
    if (this.count >= 16) return null;
    this.count += 1;
    let handler: DesignCodeTools | undefined;
    let server: DesignAgentMcpServer | undefined;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        this.count -= 1;
      }
    };
    try {
      const target = await (
        this.options.resolveTarget ??
        ((value) => resolveCodeDesignTarget(value, this.options))
      )(input);
      input.signal.throwIfAborted();
      if (!target) {
        release();
        return null;
      }
      handler = new DesignCodeTools(target, {
        renderer: createDesignCaptureRenderer(target.workspacePath),
        onChanged: () => this.options.onChanged?.(target.workspaceId),
      });
      server = new DesignAgentMcpServer({ handler, token: handler.token });
      await server.start();
      input.signal.throwIfAborted();
      const admittedHandler = handler;
      const admittedServer = server;
      let disposal: Promise<void> | undefined;
      return {
        env: { [DESIGN_AGENT_CAPABILITY_ENV]: `Bearer ${handler.token}` },
        mcpServers: [server.registration],
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
