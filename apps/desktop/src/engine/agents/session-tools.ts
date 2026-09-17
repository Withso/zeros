import type { McpServerRegistration } from "./types";

export interface AgentSessionTools {
  readonly env: Readonly<Record<string, string>>;
  readonly mcpServers: readonly McpServerRegistration[];
  /** Revoke authority synchronously before awaiting transport teardown. */
  revoke(): void;
  dispose(): Promise<void>;
}
export interface AgentSessionToolInput {
  executionId: string;
  cwd: string;
  workspaceId?: string;
  conversationId?: string;
  signal: AbortSignal;
}
export type AgentSessionToolFactory = (
  input: AgentSessionToolInput,
) => Promise<AgentSessionTools | null>;

interface Entry {
  workspaceId?: string;
  controller: AbortController;
  ready: Promise<AgentSessionTools | null>;
  tools: AgentSessionTools | null;
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
      ready: Promise.resolve(null),
      tools: null,
      detach: () => input.signal?.removeEventListener("abort", cancel),
    };
    this.entries.set(input.executionId, entry);
    input.signal?.addEventListener("abort", cancel, { once: true });
    entry.ready = Promise.resolve()
      .then(() => this.factory!({ ...input, signal: controller.signal }))
      .then(async (tools) => {
        entry.tools = tools;
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
