import {
  CloudCommandSnapshotSchema,
  CloudCommandEntrySchema,
} from "@zeros/protocol/cloud-commands";
import type { RuntimeClient } from "./ws-client";
import type { BridgeMessage } from "./messages";
import { record, type WireRecord } from "./cloud-runtime-wire";

type Options = Exclude<
  Parameters<RuntimeClient["request"]>[1],
  number | undefined
>;
type Conversation = {
  id: string;
  agentId: string;
  model: string;
  effort?: string;
  fast: boolean;
  execution?: string;
  modeRevision: number;
  localDirectories?: boolean;
};
const routeId = (id: string) => `conversation:${id}`;

/** Adapts a durable cloud conversation to the existing session UI contract.
 * The route is a conversation attachment, never a provider resume identity.
 * Commands own real executions; closing the UI does not cancel their work. */
export class CloudAgentConnection {
  private readonly conversations = new Map<string, Conversation>();
  private readonly executionOwners = new Map<string, string>();
  private readonly commandOwners = new Map<string, string>();
  private readonly pending = new Map<string, Promise<WireRecord>>();
  private closed = false;
  private listeners = new Map<string, Set<(message: BridgeMessage) => void>>();

  constructor(
    private readonly client: RuntimeClient,
    private readonly workspaceId: string,
    private readonly grant: (agentId: string, model: string) => Promise<string>,
  ) {}

  on(type: string, listener: (message: BridgeMessage) => void): () => void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
    return () => {
      listeners.delete(listener);
    };
  }

  private publishControls(snapshot: WireRecord): void {
    // Let the caller bind the returned session before delivering its restored
    // controls. This is one event-loop task, not a delayed readiness heuristic.
    setTimeout(() => {
      if (this.closed) return;
      if (snapshot.executionId && snapshot.initialize && snapshot.session) {
        const frame = {
          type: "AGENT_SESSION_CREATED",
          chatId: snapshot.conversationId,
          agentId:
            snapshot.agentId ??
            this.conversations.get(String(snapshot.conversationId))?.agentId,
          session: {
            ...record(snapshot.session),
            executionId: snapshot.executionId,
            sessionId: snapshot.executionId,
          },
          initialize: snapshot.initialize,
        };
        for (const listener of this.listeners.get(frame.type) ?? [])
          listener(frame as unknown as BridgeMessage);
      }
      for (const [field, type] of [
        ["permissions", "AGENT_PERMISSION_REQUEST"],
        ["questions", "AGENT_QUESTION_REQUEST"],
      ]) {
        for (const item of Array.isArray(snapshot[field])
          ? (snapshot[field] as unknown[])
          : []) {
          const frame = {
            ...record(item),
            type,
            chatId: snapshot.conversationId,
          };
          for (const listener of this.listeners.get(type) ?? [])
            listener(frame as unknown as BridgeMessage);
        }
      }
    }, 0);
  }

  async refreshAttachments(): Promise<void> {
    await Promise.allSettled(
      [...this.conversations.values()].map(async (owner) => {
        const snapshot = record(
          (
            await this.op("cloudEvents.request", {
              request: { kind: "snapshot", conversationId: owner.id },
            })
          ).snapshot,
        );
        if (typeof snapshot.executionId === "string") {
          owner.execution = snapshot.executionId;
          this.executionOwners.set(snapshot.executionId, owner.id);
        }
        this.publishControls(snapshot);
      }),
    );
  }

  private async op(op: string, params: WireRecord): Promise<WireRecord> {
    if (this.closed) throw new Error("Cloud workspace connection closed");
    const response = await this.client.request(
      { type: "WORKSPACE_REQUEST", op, params },
      30_000,
    );
    if (this.closed) throw new Error("Cloud workspace connection closed");
    if (response.type === "WORKSPACE_ERROR")
      throw new Error(response.message || "Cloud request failed");
    return record((response as unknown as WireRecord).result);
  }

  private owner(message: WireRecord): Conversation | undefined {
    if (typeof message.chatId === "string")
      return this.conversations.get(message.chatId);
    const id =
      message.executionId ??
      message.sessionId ??
      record(message.request).sessionId ??
      record(message.notification).sessionId;
    if (typeof id !== "string") return undefined;
    return this.conversations.get(
      id.startsWith("conversation:")
        ? id.slice(13)
        : (this.executionOwners.get(id) ?? ""),
    );
  }

  /** Called before the normal namespacing boundary. Only protocol identities
   * are rewritten; tool records and provider bindings remain opaque. */
  incoming(message: WireRecord): WireRecord {
    const chatId =
      typeof message.chatId === "string"
        ? message.chatId
        : this.commandOwners.get(String(message.requestId));
    const session = record(message.session);
    const execution =
      message.executionId ??
      message.sessionId ??
      session.executionId ??
      session.sessionId ??
      record(message.notification).sessionId ??
      record(message.request).sessionId;
    const owner = chatId
      ? this.conversations.get(chatId)
      : this.conversations.get(
          this.executionOwners.get(String(execution)) ?? "",
        );
    if (!owner) return message;
    if (
      typeof execution === "string" &&
      !execution.startsWith("conversation:")
    ) {
      owner.execution = execution;
      this.executionOwners.set(execution, owner.id);
      // Each conversation retains only its current execution route.
      for (const [id, chat] of this.executionOwners)
        if (chat === owner.id && id !== execution)
          this.executionOwners.delete(id);
    }
    const map = (value: WireRecord) => ({
      ...value,
      ...(typeof value.sessionId === "string"
        ? { sessionId: routeId(owner.id) }
        : {}),
      ...(typeof value.executionId === "string"
        ? { executionId: routeId(owner.id) }
        : {}),
    });
    return {
      ...map(message),
      chatId: owner.id,
      ...(message.notification
        ? { notification: map(record(message.notification)) }
        : {}),
      ...(message.request ? { request: map(record(message.request)) } : {}),
      ...(message.session ? { session: map(session) } : {}),
      ...(message.response ? { response: map(record(message.response)) } : {}),
    };
  }

  private configure(owner: Conversation, message: WireRecord): void {
    const env = record(message.env);
    if (message.env)
      owner.localDirectories =
        typeof env.ZEROS_ADDITIONAL_DIRS === "string" &&
        env.ZEROS_ADDITIONAL_DIRS !== "[]";
    const model =
      message.model ??
      env.ANTHROPIC_MODEL ??
      env.OPENAI_MODEL ??
      env.CODEX_MODEL ??
      env.CURSOR_MODEL;
    if (typeof model === "string" && model) owner.model = model;
    if (message.env)
      owner.effort =
        typeof env.ZEROS_THINKING_EFFORT === "string"
          ? env.ZEROS_THINKING_EFFORT
          : undefined;
    if (message.env) owner.fast = env.ZEROS_FAST_MODE === "1";
  }

  async request(
    message: WireRecord,
    options?: number | Options,
  ): Promise<WireRecord | null> {
    if (
      message.type === "AGENT_NEW_SESSION" ||
      message.type === "AGENT_LOAD_SESSION"
    ) {
      if (
        typeof message.chatId !== "string" ||
        typeof message.agentId !== "string"
      )
        throw new Error("Cloud conversations require their saved identity");
      if (
        !this.conversations.has(message.chatId) &&
        this.conversations.size >= 256
      )
        throw new Error("Cloud conversation attachment limit reached");
      const previous = this.conversations.get(message.chatId);
      const owner = (previous?.agentId === message.agentId
        ? previous
        : undefined) ?? {
        id: message.chatId,
        agentId: message.agentId,
        model: "",
        fast: false,
        modeRevision: 0,
      };
      this.configure(owner, message);
      const conversation =
        message.type === "AGENT_LOAD_SESSION"
          ? await this.op("cloudCommands.conversation", {
              conversationId: owner.id,
            })
          : await this.op("cloudCommands.createConversation", {
              conversationId: owner.id,
              workspaceId: this.workspaceId,
              agentId: owner.agentId,
              ...(owner.model ? { model: owner.model } : {}),
            });
      owner.modeRevision = Number(conversation.modeRevision);
      this.conversations.set(owner.id, owner);
      const response = {
        executionId: routeId(owner.id),
        sessionId: routeId(owner.id),
      };
      if (message.type === "AGENT_NEW_SESSION")
        return {
          type: "AGENT_SESSION_CREATED",
          agentId: owner.agentId,
          session: response,
          initialize: { protocolVersion: 1 },
        };
      // Normalized messages are read by the same history path as local chats.
      // Snapshot the active execution to recover its pending controls as well.
      const snapshot = record(
        (
          await this.op("cloudEvents.request", {
            request: { kind: "snapshot", conversationId: owner.id },
          })
        ).snapshot,
      );
      if (typeof snapshot.executionId === "string") {
        owner.execution = snapshot.executionId;
        this.executionOwners.set(snapshot.executionId, owner.id);
      }
      this.publishControls(snapshot);
      return {
        type: "AGENT_SESSION_LOADED",
        agentId: owner.agentId,
        ...response,
        response: {
          ...response,
          ...(message.providerBinding
            ? { providerBinding: message.providerBinding }
            : {}),
        },
        promptActive: !!snapshot.activeTurn,
        ...(snapshot.activeTurn
          ? { activeTurnStartedAt: record(snapshot.activeTurn).startedAt }
          : {}),
      };
    }
    const owner = this.owner(message);
    if (!owner) return null;
    if (message.type === "AGENT_PROMPT") {
      const key = `${owner.id}:${String(message.userMessageId)}`;
      const existing = this.pending.get(key);
      if (existing) return existing;
      const flight = this.prompt(
        owner,
        message,
        typeof options === "object" ? options.signal : undefined,
      ).finally(() => {
        if (this.pending.get(key) === flight) this.pending.delete(key);
      });
      this.pending.set(key, flight);
      return flight;
    }
    if (message.type === "AGENT_SET_MODE") {
      // Permissions on cloud executions are engine-owned. Do not manufacture
      // an acknowledgement for a permission posture the engine cannot apply.
      if (owner.execution) return null;
      throw new Error(
        "Cloud execution permissions are managed by the workspace policy",
      );
    }
    if (message.type === "AGENT_CLOSE_SESSION")
      return {
        type: "AGENT_SESSION_CLOSED",
        agentId: owner.agentId,
        sessionId: routeId(owner.id),
        executionId: routeId(owner.id),
      };
    return null;
  }

  private async prompt(
    owner: Conversation,
    message: WireRecord,
    signal?: AbortSignal,
  ): Promise<WireRecord> {
    // Composer changes apply to the next send. This command must retain the
    // model/effort that its credential lookup authorizes across every await.
    const { agentId, model, effort, fast, localDirectories } = owner;
    if (!model)
      throw new Error("Choose a model before sending to the cloud workspace");
    if (localDirectories)
      throw new Error(
        "Additional local folders cannot be used in a cloud workspace",
      );
    if (
      effort &&
      !["low", "medium", "high", "xhigh", "max", "ultracode"].includes(effort)
    )
      throw new Error(
        "Choose a supported effort level before sending to the cloud workspace.",
      );
    const grant = await this.grant(agentId, model);
    const conversation = await this.op("cloudCommands.conversation", {
      conversationId: owner.id,
    });
    owner.modeRevision = Number(conversation.modeRevision);
    let queue = CloudCommandSnapshotSchema.parse(
      await this.op("cloudCommands.request", {
        request: { kind: "snapshot", conversationId: owner.id },
      }),
    );
    if (signal?.aborted)
      throw new Error("Cloud prompt was cancelled before submission");
    // The optimistic user-message identity survives retry/reload. Hash it into
    // a stable UUID so an unknown acknowledgement cannot send the prompt twice.
    const bytes = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(
          `zeros-cloud-command:${owner.id}:${String(message.userMessageId)}`,
        ),
      ),
    ).slice(0, 16);
    bytes[6] = (bytes[6]! & 15) | 80;
    bytes[8] = (bytes[8]! & 63) | 128;
    const hex = Array.from(bytes, (value) =>
      value.toString(16).padStart(2, "0"),
    ).join("");
    const commandId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    this.commandOwners.set(commandId, owner.id);
    try {
      const prior = [...queue.pending, ...queue.receipts].find(
        (row) => row.commandId === commandId,
      );
      if (!prior) {
        if (queue.paused)
          queue = CloudCommandSnapshotSchema.parse(
            await this.op("cloudCommands.request", {
              request: {
                kind: "mutate",
                mutation: {
                  conversationId: owner.id,
                  operationId: crypto.randomUUID(),
                  expectedRevision: queue.revision,
                  action: { kind: "resume" },
                },
              },
            }),
          );
        await this.op("cloudCommands.request", {
          request: {
            kind: "mutate",
            mutation: {
              conversationId: owner.id,
              operationId: commandId,
              expectedRevision: queue.revision,
              action: {
                kind: "enqueue",
                commandId,
                payload: {
                  agentId,
                  userMessageId: message.userMessageId,
                  prompt: message.prompt,
                  ...(message.bubble ? { bubble: message.bubble } : {}),
                  modeRevision: owner.modeRevision,
                  agentCredentialGrantId: grant,
                  model,
                  ...(["low", "medium", "high", "xhigh", "max", "ultracode"].includes(
                    effort ?? "",
                  )
                    ? { effort }
                    : {}),
                  fast,
                },
              },
            },
          },
        });
      }
      // Streaming uses the ordinary event subscriptions. Receipts, independently
      // of the socket, determine completion after reconnect or lost terminal frames.
      for (;;) {
        if (signal?.aborted || this.closed)
          throw new Error(
            "Cloud prompt observation ended; reconnect to view its result",
          );
        let entry;
        try {
          entry = CloudCommandEntrySchema.parse(
            await this.op("cloudCommands.request", {
              request: { kind: "read", commandId },
            }),
          );
        } catch (error) {
          if (this.client.status === "connected") throw error;
        }
        if (entry?.executionId) {
          owner.execution = entry.executionId;
          this.executionOwners.set(entry.executionId, owner.id);
        }
        if (entry && ["succeeded", "cancelled"].includes(entry.state))
          return {
            type: "AGENT_PROMPT_COMPLETE",
            agentId: owner.agentId,
            sessionId: routeId(owner.id),
            executionId: routeId(owner.id),
            stopReason: entry.state === "cancelled" ? "cancelled" : "end_turn",
            response: {},
          };
        if (entry && ["failed", "uncertain"].includes(entry.state))
          return {
            type: "AGENT_PROMPT_FAILED",
            agentId: owner.agentId,
            sessionId: routeId(owner.id),
            executionId: routeId(owner.id),
            error:
              entry.state === "uncertain"
                ? "The cloud command outcome is unknown. Review the transcript before retrying."
                : `Cloud command failed (${entry.resultCode ?? "unknown"})`,
          };
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } finally {
      this.commandOwners.delete(commandId);
    }
  }

  send(message: WireRecord): boolean {
    const owner = this.owner(message);
    if (!owner) return false;
    if (
      message.type === "AGENT_SET_MODEL" ||
      message.type === "AGENT_UPDATE_CONFIG"
    ) {
      this.configure(owner, message);
      return true;
    }
    if (message.type === "AGENT_CLOSE_SESSION") return true;
    return false;
  }

  outgoing(message: WireRecord): WireRecord {
    const owner = this.owner(message);
    if (!owner) return message;
    // Stop names the durable conversation even before an execution is admitted.
    if (message.type === "AGENT_CANCEL")
      return {
        type: "WORKSPACE_REQUEST",
        op: "cloudCommands.request",
        params: {
          request: {
            kind: "stop",
            conversationId: owner.id,
            operationId: crypto.randomUUID(),
          },
        },
      };
    if (!owner.execution)
      throw new Error("This cloud conversation has no active execution");
    return {
      ...message,
      ...(message.sessionId ? { sessionId: owner.execution } : {}),
      ...(message.executionId ? { executionId: owner.execution } : {}),
    };
  }

  dispose(): void {
    this.closed = true;
    this.conversations.clear();
    this.executionOwners.clear();
    this.commandOwners.clear();
    this.listeners.clear();
  }
}
