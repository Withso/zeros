import type { McpServerRegistration } from "./types";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

/** A trusted product handler bound once to a registered workspace owner. */
export interface AgentWorkspaceTools {
  readonly workspaceId: string;
  readonly workspacePath: string;
  assertCurrent(): void;
  listTools(): Tool[];
  callTool(name: string, raw: unknown, signal: AbortSignal): Promise<CallToolResult>;
}

export interface AgentSessionTools {
  readonly env: Readonly<Record<string, string>>;
  readonly mcpServers: readonly McpServerRegistration[];
  /** Revoke authority synchronously before awaiting transport teardown. */
  revoke(): void;
  dispose(): Promise<void>;
  /** Current product instructions before every native send/continuation. */
  preparePrompt?(): string | Promise<string>;
  beginPrompt?(): void;
  /** The provider turn settled (success, failure or Stop). Hand shared
   * surfaces back to the user; the provider conversation stays alive. */
  endPrompt?(): void | Promise<void>;
  /** Cancel pending tool work without destroying the provider conversation. */
  cancel?(): void;
  /** Retire document grants during an engine-owned directory transition while
   * preserving the stable provider MCP registration. */
  suspend?(): () => void;
}
export interface AgentSessionToolInput {
  /** Registered provider chosen by gateway admission, not a tool caller. */
  agentId?: string;
  executionId: string;
  cwd: string;
  workspaceId?: string;
  conversationId?: string;
  signal: AbortSignal;
}
export type AgentSessionToolFactory = (
  input: AgentSessionToolInput,
) => Promise<AgentSessionTools | null>;

/** Run independent product owners (Design, agent control, …) for the same
 * execution. Each owner keeps its own authority; a failure or a collision
 * retires every owner that already admitted tools. */
export function composeAgentSessionToolFactories(
  factories: readonly AgentSessionToolFactory[],
): AgentSessionToolFactory {
  return async (input) => {
    const settled = await Promise.allSettled(factories.map((factory) => factory(input)));
    const admitted = settled.flatMap((result) =>
      result.status === "fulfilled" && result.value ? [result.value] : [],
    );
    const retire = async () => {
      for (const tools of admitted) tools.revoke();
      await Promise.allSettled(admitted.map((tools) => tools.dispose()));
    };
    const failure = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) {
      await retire();
      throw failure.reason;
    }
    if (admitted.length === 0) return null;
    if (admitted.length === 1) return admitted[0]!;
    const env: Record<string, string> = {};
    const names = new Set<string>();
    try {
      for (const tools of admitted) {
        for (const [key, value] of Object.entries(tools.env)) {
          if (key in env) throw new Error("Two session tool owners use the same credential name.");
          env[key] = value;
        }
        for (const server of tools.mcpServers) {
          if (names.has(server.name)) throw new Error("Two session tool owners use the same MCP server name.");
          names.add(server.name);
        }
      }
    } catch (error) {
      await retire();
      throw error;
    }
    return {
      env,
      mcpServers: admitted.flatMap((tools) => tools.mcpServers),
      preparePrompt: async () => {
        const parts = await Promise.all(admitted.map((tools) => tools.preparePrompt?.()));
        return parts.filter((part): part is string => typeof part === "string" && part.length > 0).join("\n\n");
      },
      beginPrompt: () => admitted.forEach((tools) => tools.beginPrompt?.()),
      endPrompt: async () => {
        await Promise.allSettled(admitted.map((tools) => tools.endPrompt?.()));
      },
      cancel: () => admitted.forEach((tools) => tools.cancel?.()),
      suspend: () => {
        const resume = admitted.flatMap((tools) => (tools.suspend ? [tools.suspend()] : []));
        return () => resume.forEach((release) => release());
      },
      revoke: () => admitted.forEach((tools) => tools.revoke()),
      dispose: async () => {
        const results = await Promise.allSettled(admitted.map((tools) => tools.dispose()));
        const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failed) throw failed.reason;
      },
    };
  };
}

interface Entry {
  workspaceId?: string;
  controller: AbortController;
  preparation: AbortController;
  ready: Promise<AgentSessionTools | null>;
  tools: AgentSessionTools | null;
  cancelled: boolean;
  /** Prompts begun but not yet ended. A rejected double-send overlaps the
   * running turn and must not settle that turn's shared surfaces early. */
  activePrompts: number;
  stop?: Promise<void>;
  detach(): void;
}

/** Own tool grants alongside provider executions, including pre-start flights.
 * Ordinary user MCP configuration remains independent and is merged by name. */
export class AgentSessionToolRegistry {
  private readonly entries = new Map<string, Entry>();
  private closed = false;
  constructor(private readonly factory?: AgentSessionToolFactory) {}

  async admit(
    input: Omit<AgentSessionToolInput, "signal"> & { signal?: AbortSignal },
    servers: McpServerRegistration[],
    env: Record<string, string>,
  ): Promise<McpServerRegistration[]> {
    if (!this.factory) return servers;
    if (this.closed || input.signal?.aborted)
      throw new Error("Session tool admission was cancelled.");
    if (this.entries.has(input.executionId))
      throw new Error("Session tools are already admitted for this execution.");
    const controller = new AbortController();
    const cancel = () => {
      void this.stop(input.executionId).catch(() => {});
    };
    const entry: Entry = {
      workspaceId: input.workspaceId,
      controller,
      preparation: new AbortController(),
      ready: Promise.resolve(null),
      tools: null,
      cancelled: false,
      activePrompts: 0,
      detach: () => input.signal?.removeEventListener("abort", cancel),
    };
    this.entries.set(input.executionId, entry);
    input.signal?.addEventListener("abort", cancel, { once: true });
    entry.ready = Promise.resolve()
      .then(() => this.factory!({ ...input, signal: controller.signal }))
      .then(async (tools) => {
        entry.tools = tools;
        if (entry.cancelled) tools?.cancel?.();
        if (controller.signal.aborted || this.closed) {
          tools?.revoke();
          throw new Error("Session tool admission was cancelled.");
        }
        return tools;
      });
    try {
      const tools = await entry.ready;
      if (!tools) {
        entry.detach();
        this.entries.delete(input.executionId);
        return servers;
      }
      Object.assign(env, tools.env);
      const reserved = new Set(tools.mcpServers.map((server) => server.name));
      return [
        ...tools.mcpServers,
        ...servers.filter((server) => !reserved.has(server.name)),
      ];
    } catch (error) {
      await this.stop(input.executionId);
      throw error;
    }
  }

  stop(executionId: string): Promise<void> {
    const entry = this.entries.get(executionId);
    if (!entry) return Promise.resolve();
    if (entry.stop) return entry.stop;
    entry.controller.abort();
    entry.tools?.revoke();
    entry.stop = (async () => {
      await entry.ready.catch(() => null);
      entry.tools?.revoke();
      await entry.tools?.dispose();
    })().finally(() => {
      entry.detach();
      this.entries.delete(executionId);
    });
    return entry.stop;
  }

  async preparePrompt(executionId: string): Promise<string | undefined> {
    const entry = this.entries.get(executionId);
    if (!entry) return undefined;
    const signal = AbortSignal.any([entry.controller.signal, entry.preparation.signal]);
    signal.throwIfAborted();
    let abort!: () => void;
    try {
      // Discovery can outlive Stop or execution disposal. Retire its waiter
      // immediately; a late result must never continue into a native send.
      return await Promise.race([
        Promise.resolve().then(() => {
          signal.throwIfAborted();
          return entry.tools?.preparePrompt?.();
        }),
        new Promise<never>((_, reject) => {
          abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
        }),
      ]);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  cancel(executionId: string): void {
    const entry = this.entries.get(executionId);
    if (entry) {
      entry.cancelled = true;
      entry.preparation.abort();
      entry.tools?.cancel?.();
    }
  }

  beginPrompt(executionId: string): void {
    const entry = this.entries.get(executionId);
    if (entry) {
      entry.cancelled = false;
      entry.activePrompts += 1;
      if (entry.preparation.signal.aborted) entry.preparation = new AbortController();
      entry.tools?.beginPrompt?.();
    }
  }

  async endPrompt(executionId: string): Promise<void> {
    const entry = this.entries.get(executionId);
    if (!entry) return;
    entry.activePrompts = Math.max(0, entry.activePrompts - 1);
    if (entry.activePrompts > 0) return;
    try {
      await entry.tools?.endPrompt?.();
    } catch {
      // Turn settlement is best-effort cleanup and must not replace the
      // provider's own result or error for this prompt.
    }
  }

  suspend(workspaceId?: string): () => void {
    const resume = [...this.entries.values()]
      .filter((entry) => workspaceId === undefined || entry.workspaceId === workspaceId)
      .flatMap((entry) => entry.tools?.suspend ? [entry.tools.suspend()] : []);
    return () => resume.forEach((release) => release());
  }

  async dispose(): Promise<void> {
    this.closed = true;
    await this.revoke();
  }

  async revoke(workspaceId?: string): Promise<void> {
    const results = await Promise.allSettled(
      [...this.entries]
        .filter(
          ([, entry]) =>
            workspaceId === undefined || entry.workspaceId === workspaceId,
        )
        .map(([id]) => this.stop(id)),
    );
    const failures = results.filter(
      (value): value is PromiseRejectedResult => value.status === "rejected",
    );
    if (failures.length)
      throw new AggregateError(
        failures.map((value) => value.reason),
        "Failed to retire session tools.",
      );
  }
}
