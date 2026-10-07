import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cloudCommandFailureFromCode,
  cloudCommandFailureCode,
  type CloudCommandClaim,
  type CloudCommandEngineRequest,
  type CloudCommandResult,
  type CloudCommandSnapshot,
} from "@zeros/protocol/cloud-commands";
import { isCloudAgentAdmissionCode } from "@zeros/protocol/cloud-agent-execution";
import { createMessage, type BridgeMessage } from "@zeros/protocol/messages";
import { redactLogSecrets } from "@zeros/protocol/scrub";
import { CloudCommandRuntime } from "../../../../engine/cloud-command-runtime";
import { AgentFailureError } from "../../../../engine/agents/types";
import {
  normalizeProviderError,
  providerErrorFailure,
} from "../../../../engine/agents/adapters/shared/provider-error";
import { CloudAgentConnection } from "../../../platform/bridge/cloud-agent-connection";
import { CloudEventReader } from "../../../platform/bridge/cloud-event-reader";
import { isCloudWorkspace, parseCloudWorkspaceKey } from "../../../platform/bridge/cloud-workspace-key";
import { classifyRpcError } from "../../../platform/bridge/failure";
import type { RuntimeClient } from "../../../platform/bridge/ws-client";
import type { WireRecord } from "../../../platform/bridge/cloud-runtime-wire";
import type { SessionNotification } from "../../../platform/bridge/agent-events";
import {
  fromPersistedMessage,
  persistAuthenticationPrompt,
  type PersistedMessageWire,
} from "../agent-history-client";
import { AuthPromptRecovery, lastUserPrompt } from "../auth-prompt-recovery";
import {
  classifyCloudAdmissionFailure,
  cloudAdmissionFailureCode,
} from "../cloud-admission-failure";
import { recoverCloudAdmissionFailure } from "../cloud-runtime-upgrade";
import { getLiveChatDraft, setLiveChatDraft } from "../composer-live-drafts";
import { reconcileHistoryMessages } from "../history-message-identity";
import {
  requestLocalPrompt,
  LocalPromptRecoveryError,
} from "../local-prompt-recovery";
import { SendQueue } from "../send-queue";
import * as lifecycle from "../session-reload-lifecycle";
import { BLANK, mergeWindowedTail, useSessionsStore } from "../sessions-store";
import { turnFailureForCard } from "../turn-failure";
import { notifyAgentSendFailure } from "../agent-send-failure-toast";
import {
  reportCloudAgentRuntimeUpgrade,
  invalidateCloudAgentRegistry,
} from "../workspace-agent-registry";
import type { AgentMessage, AgentTextMessage } from "../use-agent-session";
import { applyUpdate } from "../use-agent-session";

const CHAT = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const WORKSPACE = "33333333-3333-4333-8333-333333333333";
const GRANT = "44444444-4444-4444-8444-444444444444";
const STREAM = "55555555-5555-4555-8555-555555555555";
const TURN = "accepted-turn";
const CLOUD = `cloud://${ORG}/${WORKSPACE}`;
const ROUTE = `conversation:${CHAT}`;
const PROMPT = "Explain the saved fixture";
const ANSWER = "The complete saved answer.";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  toast: vi.fn(),
  workspace: {
    chats: [] as Array<{
      id: string;
      model: string;
      additionalDirectories: string[];
    }>,
    chatComposerDrafts: {},
    dispatch: vi.fn(),
  },
}));
vi.mock("../../../shared/ui/primitives/elements/toast", () => ({
  toast: { error: mocks.toast },
}));
vi.mock("../workspace-agent-registry", () => ({
  reportCloudAgentRuntimeUpgrade: mocks.refresh,
  invalidateCloudAgentRegistry: mocks.refresh,
}));
vi.mock("../../../state/store", () => ({
  useWorkspaceStore: { getState: () => mocks.workspace },
}));
vi.mock("../../../state/workspace-store", () => ({
  useWorkspaceStore: { getState: () => mocks.workspace },
}));

// Execute the real send/finally and engine failure publication without mounting
// unrelated React/provider services. Only I/O, provider execution, and telemetry
// are ports; classification, ordering, recovery, serialization, and cards are real.
function extract(file: URL, names: string[], callbacks: string[] = []) {
  const ast = ts.createSourceFile(
    file.pathname,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const found = new Map<string, string>();
  function visit(node: ts.Node) {
    if (
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
      node.name &&
      names.includes(node.name.getText(ast))
    )
      found.set(node.name.getText(ast), node.getText(ast));
    if (
      ts.isVariableDeclaration(node) &&
      callbacks.includes(node.name.getText(ast)) &&
      node.initializer &&
      ts.isCallExpression(node.initializer)
    )
      found.set(
        node.name.getText(ast),
        node.initializer.arguments[0].getText(ast),
      );
    ts.forEachChild(node, visit);
  }
  visit(ast);
  for (const name of [...names, ...callbacks])
    expect(found.has(name), `production function ${name}`).toBe(true);
  return found;
}
const rendererSource = extract(
  new URL("../sessions-provider.tsx", import.meta.url),
  ["promoteToEnd", "failureFromAgentError", "promptInactivityError"],
  ["sendPrompt", "persistAuthPrompt"],
);
const rendererCode = ts.transpileModule(
  [
    ...["promoteToEnd", "failureFromAgentError", "promptInactivityError"].map(
      (name) => rendererSource.get(name),
    ),
    `const persistAuthPrompt = ${rendererSource.get("persistAuthPrompt")};`,
    `globalThis.send = ${rendererSource.get("sendPrompt")};`,
  ].join("\n"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;
const engineSource = extract(
  new URL("../../../../engine/zeros-engine.ts", import.meta.url),
  ["publishCloudCommandFailure", "dispatchCloudCommand"],
);
const engineAst = ts.createSourceFile(
  "engine.ts",
  readFileSync(
    new URL("../../../../engine/zeros-engine.ts", import.meta.url),
    "utf8",
  ),
  ts.ScriptTarget.Latest,
  true,
);
let promptFailureBody = "";
function findPromptFailure(node: ts.Node) {
  if (
    ts.isCatchClause(node) &&
    node.block
      .getText(engineAst)
      .includes("turn-failure-${activePrompt.turnId}-${msg.id}")
  )
    promptFailureBody = node.block.getText(engineAst);
  ts.forEachChild(node, findPromptFailure);
}
findPromptFailure(engineAst);
expect(promptFailureBody).not.toBe("");
const publisherCode = ts.transpileModule(
  `class Publisher { ${[...engineSource.values()].join("\n")} }\nglobalThis.publisher = new Publisher();
   globalThis.nativePromptFailure = async function(err, msg, client, activePrompt, turnCtx, fromCloudCommand) ${promptFailureBody};`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
type Scenario = {
  agent?: "claude" | "codex";
  denial?: string;
  nativeError?: unknown;
  loseTerminal?: boolean;
  partial?: boolean;
  folder?: string;
  historyGate?: ReturnType<typeof deferred<void>>;
  snapshotGate?: ReturnType<typeof deferred<void>>;
  emptyHistory?: boolean;
  delayedChunk?: boolean;
  successContent?: "empty" | "tool";
};
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  setLiveChatDraft(CHAT, null);
  vi.restoreAllMocks();
});

async function harness(options: Scenario = {}) {
  vi.clearAllMocks();
  const agentId = options.agent ?? "codex",
    folder = options.folder ?? CLOUD;
  const cloud = isCloudWorkspace(folder),
    sessionId = cloud ? ROUTE : "local-execution";
  mocks.workspace.chats = [
    { id: CHAT, model: "test-model", additionalDirectories: [] },
  ];
  const draft = { text: PROMPT, json: { type: "doc" }, attachments: [] };
  setLiveChatDraft(CHAT, draft);
  useSessionsStore.setState({
    sessions: {
      [CHAT]: {
        ...BLANK,
        cwd: folder,
        agentId,
        sessionId,
        status: "ready",
        messages: [],
      },
    },
    executionToChatId: { [sessionId]: CHAT },
    pendingLocalTurns: {},
    cancellingChats: new Set(),
  });

  // The synthetic CP port has a durable command ledger, not a canned response.
  // Claims and receipts traverse the production schemas/pump. Stored transcripts
  // round-trip JSON through the actual history parser and recovery upsert client.
  const rows = new Map<string, PersistedMessageWire>();
  function save(messages: AgentMessage[]) {
    for (const row of messages)
      rows.set(row.id, {
        msgId: row.id,
        kind: row.kind,
        payload: JSON.stringify(row),
        createdAt: row.createdAt,
      });
  }
  function history() {
    return reconcileHistoryMessages(
      [...rows.values()]
        .sort((left, right) => left.createdAt - right.createdAt)
        .map(fromPersistedMessage)
        .filter((row): row is AgentMessage => row !== null),
    );
  }
  const handlers = new Map<string, Set<(frame: BridgeMessage) => void>>();
  const statusListeners = new Set<(status: RuntimeClient["status"]) => void>();
  const on = (type: string, listener: (frame: BridgeMessage) => void) => {
    const listeners = handlers.get(type) ?? new Set();
    listeners.add(listener);
    handlers.set(type, listeners);
    return () => {
      listeners.delete(listener);
    };
  };
  let sequence = 0,
    execution: string | null = null,
    revision = 0;
  let entry: CloudCommandSnapshot["pending"][number] | undefined;
  const settled = deferred<void>(),
    captured: BridgeMessage[] = [];
  function emit(message: BridgeMessage, deliver = true) {
    const frame = {
      ...message,
      chatId: CHAT,
      cloudStream: { streamId: STREAM, sequence: ++sequence },
    } as BridgeMessage;
    captured.push(frame);
    // Successful native terminals are withheld so success exercises receipt
    // recovery. The lost-failure cases withhold the native notice and terminal.
    const nativeNotice =
      frame.type === "AGENT_SESSION_UPDATE" &&
      frame.notification.update.sessionUpdate === "error_notice";
    if (
      !deliver ||
      frame.type === "AGENT_PROMPT_COMPLETE" ||
      (options.loseTerminal &&
        (frame.type === "AGENT_PROMPT_FAILED" || nativeNotice))
    )
      return frame;
    for (const listener of handlers.get(frame.type) ?? []) listener(frame);
    return frame;
  }
  function chunk(text: string, deliver = true) {
    return emit(
      createMessage({
        type: "AGENT_SESSION_UPDATE",
        source: "engine",
        agentId,
        executionId: execution!,
        notification: {
          sessionId: execution!,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text },
          },
        },
      }),
      deliver,
    );
  }
  const publisherContext: Record<string, unknown> = {
    AgentFailureError,
    Error,
    redactLogSecrets,
    cloudCommandFailureFromCode,
    cloudCommandFailureCode,
    isCloudAgentAdmissionCode,
    createMessage,
    getChat: () => ({ id: CHAT, agentId }),
    openZerosDb: () => ({
      prepare: () => ({
        all: (_chat: string, ...ids: string[]) =>
          ids.flatMap((id) => (rows.has(id) ? [rows.get(id)!] : [])),
      }),
    }),
    windowChatMessages: () => [...rows.values()],
    upsertChatMessagesBulk: (
      _chat: string,
      messages: PersistedMessageWire[],
    ) => {
      for (const message of messages) rows.set(message.msgId, { ...message });
    },
  };
  vm.runInNewContext(publisherCode, publisherContext);
  const publisher = publisherContext.publisher as {
    broadcast: typeof emit;
    publishCloudCommandFailure: (
      claim: CloudCommandClaim,
      code: string,
      error?: unknown,
    ) => void;
    dispatchCloudCommand: (
      claim: CloudCommandClaim,
    ) => Promise<Pick<CloudCommandResult, "state" | "resultCode" | "result">>;
  };
  publisher.broadcast = emit;
  const snapshot = (): CloudCommandSnapshot =>
    structuredClone({
      version: 1,
      conversationId: CHAT,
      revision,
      paused: false,
      pending:
        entry && ["queued", "dispatching"].includes(entry.state) ? [entry] : [],
      receipts:
        entry && !["queued", "dispatching"].includes(entry.state)
          ? [entry]
          : [],
    });
  const service = vi.fn(
    async (input: CloudCommandEngineRequest): Promise<unknown> => {
      switch (input.kind) {
        case "snapshot":
          return snapshot();
        case "mutate": {
          const action = input.mutation.action;
          if (action.kind !== "enqueue" || entry)
            throw new Error("Unexpected second queue mutation");
          entry = {
            commandId: action.commandId,
            position: 1,
            state: "queued",
            payload: action.payload,
            executionId: null,
            generation: 1,
            resultCode: null,
            createdAt: new Date(1).toISOString(),
            updatedAt: new Date(1).toISOString(),
          };
          revision++;
          return snapshot();
        }
        case "claim": {
          if (!entry || entry.state !== "queued") return null;
          entry.state = "dispatching";
          entry.executionId = input.executionId;
          return {
            commandId: entry.commandId,
            claimId: input.claimId,
            conversationId: CHAT,
            executionId: input.executionId,
            payload: entry.payload,
          };
        }
        case "read":
          await settled.promise;
          return { ...structuredClone(entry), conversationId: CHAT };
        case "settle": {
          if (!entry || entry.commandId !== input.result.commandId)
            throw new Error("Wrong command settlement");
          entry.state = input.result.state;
          entry.resultCode = input.result.resultCode;
          entry.updatedAt = new Date(2).toISOString();
          revision++;
          settled.resolve();
          return snapshot();
        }
        default:
          throw new Error(`Unexpected service request ${input.kind}`);
      }
    },
  );
  const provider = vi.fn(async (claim: CloudCommandClaim) => {
    const user = lastUserPrompt(
      useSessionsStore.getState().sessions[CHAT].messages,
    )!;
    expect(user.id).toBe(claim.payload.userMessageId);
    save([user]);
    if (options.partial) {
      save([
        {
          id: "saved-partial",
          kind: "text",
          role: "agent",
          text: "Partial answer.",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ]);
      chunk("Partial answer.");
    }
    if (options.nativeError)
      throw providerErrorFailure(
        agentId,
        normalizeProviderError(agentId, options.nativeError),
        "prompt",
      );
    if (options.delayedChunk) chunk(ANSWER, false);
    if (options.successContent === "tool")
      save([
        {
          id: "saved-tool",
          kind: "tool",
          title: "Read",
          toolKind: "read",
          status: "completed",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          toolCallId: "saved-tool",
        },
      ]);
    else if (!options.successContent && !options.historyGate)
      save([
        {
          id: "saved-answer",
          kind: "text",
          role: "agent",
          text: ANSWER,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ]);
    return { state: "succeeded" as const, resultCode: null };
  });
  const admitted = new Map<
    string,
    { claim: CloudCommandClaim; controller: AbortController }
  >();
  const activePrompts = new Map<
    string,
    { turnId: string; chatId: string; terminalPublished: boolean }
  >();
  const nativePromptFailure = publisherContext.nativePromptFailure as (
    ...args: unknown[]
  ) => Promise<void>;
  Object.assign(publisher, {
    cloudCommandSessions: admitted,
    activePromptContexts: activePrompts,
    cancelRequested: new Set<string>(),
    agents: { cloudNativeCapabilities: () => undefined },
    cloudGoals: { flush: async () => null },
    persistSessionUpdate: (
      _execution: string,
      notification: SessionNotification,
    ) => save(applyUpdate(history(), notification)),
    routeSessionScoped: (_execution: string, message: BridgeMessage) =>
      emit(message),
    emitTurnState: (active: { terminalPublished: boolean }) => {
      active.terminalPublished = true;
    },
    handleAgentMessage: async (
      message: BridgeMessage,
      receiver: { send: (frame: BridgeMessage) => void },
    ) => {
      if (message.type !== "AGENT_PROMPT")
        throw new Error("Unexpected native dispatch");
      const claim = admitted.get(message.id)!.claim;
      const active = {
        turnId: message.userMessageId!,
        chatId: CHAT,
        terminalPublished: false,
      };
      activePrompts.set(message.sessionId, active);
      try {
        await provider(claim);
        receiver.send(
          createMessage({
            type: "AGENT_PROMPT_COMPLETE",
            source: "engine",
            requestId: message.id,
            agentId,
            sessionId: message.sessionId,
            executionId: message.sessionId,
            stopReason: "end_turn",
            response: { stopReason: "end_turn" },
          }),
        );
      } catch (error) {
        await nativePromptFailure.call(
          publisher,
          error,
          message,
          receiver,
          active,
          null,
          true,
        );
      } finally {
        activePrompts.delete(message.sessionId);
      }
    },
  });
  const prepare = vi.fn(async (claim: CloudCommandClaim) => {
    execution = claim.executionId;
    admitted.set(claim.commandId, { claim, controller: new AbortController() });
    if (options.denial)
      throw Object.assign(new Error(options.denial), { code: options.denial });
  });
  const retire = vi.fn(async () => {});
  const engine = new CloudCommandRuntime({
    request: service,
    validate: () => {},
    execution: () => execution,
    prepare,
    retire,
    dispatch: (claim) => publisher.dispatchCloudCommand(claim),
    cancel: async () => {},
    changed: () => {},
    failed: (claim, code, error) =>
      publisher.publishCloudCommandFailure(claim, code, error),
  });
  const transportRequest = vi.fn(async (message: WireRecord) => {
    const input = (message.params as WireRecord)?.request as WireRecord;
    let result: unknown;
    switch (message.op) {
      case "cloudCommands.createConversation":
      case "cloudCommands.conversation":
        result = {
          conversationId: CHAT,
          modeRevision: 0,
          permissionModeVersion: 1,
          nativeCommandsVersion: 1,
        };
        break;
      case "cloudCommands.request":
        result = await engine.handle(input, "synthetic-actor-session");
        break;
      case "cloudEvents.request":
        if (input.kind === "snapshot") {
          await options.snapshotGate?.promise;
          result = {
            cursor: { streamId: STREAM, sequence },
            snapshot: {
              conversationId: CHAT,
              executionId: execution,
              activeTurn: null,
            },
          };
        } else
          result = {
            streamId: STREAM,
            firstRetained: 1,
            head: sequence,
            cursor: sequence,
            events: [],
          };
        break;
      default:
        throw new Error(`Unexpected transport operation ${message.op}`);
    }
    return { type: "WORKSPACE_RESPONSE", op: message.op, result };
  });
  const client = {
    request: transportRequest,
    status: "connected",
    on,
    onStatusChange: (listener: (status: RuntimeClient["status"]) => void) => {
      statusListeners.add(listener);
      return () => {
        statusListeners.delete(listener);
      };
    },
  } as unknown as RuntimeClient;
  const reader = new CloudEventReader(client),
    authorize = vi.fn(async () => GRANT);
  const connection = new CloudAgentConnection(
    client,
    WORKSPACE,
    authorize,
    reader,
  );
  reader.on("AGENT_PROMPT_FAILED", (frame) =>
    connection.observePromptResult(frame as unknown as WireRecord),
  );
  reader.on("AGENT_PROMPT_COMPLETE", (frame) =>
    connection.observePromptResult(frame as unknown as WireRecord),
  );
  const output = new Map<string, boolean>();
  const updates = vi.fn((frame: BridgeMessage) => {
    if (useSessionsStore.getState().sessions[CHAT]?.cwd !== CLOUD) return;
    const mapped = connection.incoming(frame as unknown as WireRecord);
    useSessionsStore
      .getState()
      .applyBridgeUpdate(mapped.notification as SessionNotification);
    if (
      frame.type === "AGENT_SESSION_UPDATE" &&
      frame.notification.update.sessionUpdate === "agent_message_chunk"
    )
      output.set(CHAT, true);
  });
  reader.on("AGENT_SESSION_UPDATE", updates);
  const changed = vi.fn();
  connection.on("DB_CHANGED", changed);
  if (cloud)
    await connection.request({
      type: "AGENT_NEW_SESSION",
      chatId: CHAT,
      agentId,
      env:
        agentId === "claude"
          ? { ANTHROPIC_MODEL: "test-model" }
          : { OPENAI_MODEL: "test-model" },
    });
  const request = vi.fn(
    async (
      message: WireRecord,
      requestOptions?: Parameters<RuntimeClient["request"]>[1],
    ) => {
      if (
        message.type === "WORKSPACE_REQUEST" &&
        message.op === "messages.import"
      ) {
        const params = message.params as {
          chatId: string;
          messages: PersistedMessageWire[];
        };
        expect(params.chatId).toBe(CHAT);
        for (const row of params.messages) rows.set(row.msgId, { ...row });
        return {
          type: "WORKSPACE_RESPONSE",
          op: message.op,
          result: { imported: params.messages.length },
        };
      }
      if (!cloud) {
        expect(message.type).toBe("AGENT_PROMPT");
        const user = lastUserPrompt(
          useSessionsStore.getState().sessions[CHAT].messages,
        )!;
        save([
          user,
          {
            id: "local-answer",
            kind: "text",
            role: "agent",
            text: ANSWER,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ]);
        useSessionsStore.getState().patchSession(CHAT, { messages: history() });
        return {
          type: "AGENT_PROMPT_COMPLETE",
          agentId,
          sessionId,
          executionId: sessionId,
          stopReason: "end_turn",
          response: { stopReason: "end_turn" },
        };
      }
      return connection.request(
        message,
        typeof requestOptions === "object" ? requestOptions : undefined,
      );
    },
  );
  const bridge = {
    request,
    status: "connected",
    on,
    onStatusChange: client.onStatusChange,
  } as unknown as RuntimeClient;
  const historyRead = vi.fn(async () => {
    await options.historyGate?.promise;
    if (options.emptyHistory) return [];
    if (options.historyGate)
      save([
        {
          id: "saved-answer",
          kind: "text",
          role: "agent",
          text: ANSWER,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ]);
    return history();
  });
  const entryForSend = {
    cloud: true,
    bubbleId: TURN,
    queueEntryId: TURN,
    args: [CHAT, PROMPT, PROMPT],
    waitStartedAt: 1,
  };
  const authPersistence = new Map<string, Promise<void>>(),
    queue = new SendQueue<typeof entryForSend>();
  const finished = vi.fn(),
    completed = vi.fn(),
    pauseQueue = vi.fn(),
    sending = new Set<string>();
  let accountGeneration = 1;
  const context: Record<string, unknown> = {
    ...lifecycle,
    Error,
    DOMException,
    AbortController,
    setTimeout,
    clearTimeout,
    crypto: { randomUUID },
    bridge,
    parseCloudWorkspaceKey, hasCloudWorkspaceAccountAccess: () => true,
    cloudComputerV2: true,
    prepareForSend: () => null,
    getStore: useSessionsStore.getState,
    flushBubbleRef: { current: new Map(cloud ? [[CHAT, TURN]] : []) },
    cloudFlushRef: { current: new Map(cloud ? [[CHAT, entryForSend]] : []) },
    cloudCatalogGeneration: () => accountGeneration,
    beginCloudSendWaitRef: { current: vi.fn() },
    classifyCloudAdmissionFailure,
    cloudAdmissionFailureCode,
    reportCloudAgentRuntimeUpgrade,
    invalidateCloudAgentRegistry,
    notifyAgentSendFailure,
    getAgentsSnapshot: () => [],
    isCloudWorkspace,
    resumeQueue: () => false,
    sendingChatsRef: { current: sending },
    sendQueueRef: { current: queue },
    queueHeldRef: { current: new Set() },
    ensureSessionRef: { current: null },
    chatComposerEnv: () => null,
    startCloudSubmitSpan: () => undefined,
    cancelGenerationsRef: { current: new Map() },
    capUserAppend: (messages: AgentMessage[], message: AgentMessage) => [
      ...messages,
      message,
    ],
    useWorkspaceStore: { getState: () => mocks.workspace },
    announcedDirsRef: { current: new Map() },
    pendingAuthenticationPrompts: () => [],
    prependSystemInstruction: (_notice: string, text: string) => text,
    turnProducedOutputRef: { current: output },
    getLiveChatDraft,
    recoverCloudAdmissionFailure,
    pauseQueue,
    newPromptDiagnosticId: () => "synthetic-prompt-diagnostic",
    promptActivityRef: { current: new Map() },
    PROMPT_INACTIVITY_TIMEOUT_MS: 10_000,
    PROMPT_ABSOLUTE_TIMEOUT_MS: 10_000,
    awaitComposerMode: () => null,
    requestLocalPrompt,
    LocalPromptRecoveryError,
    countPromptAttachments: () => ({ image: 0, text: 0 }),
    trackAgentPromptStarted: vi.fn(),
    trackAgentTurnStarted: vi.fn(),
    trackAgentPromptFinished: finished,
    trackAgentPromptCompleted: completed,
    trackAiGeneration: vi.fn(),
    classifyRpcError,
    lastUserPrompt,
    redactLogSecrets,
    authPromptsRef: { current: new AuthPromptRecovery() },
    authPersistenceRef: { current: authPersistence },
    persistAuthenticationPrompt,
    toast: { error: mocks.toast },
    persistWindowMessages: historyRead,
    HYDRATE_WINDOW: 100,
    reconcileHistoryMessages,
    mergeWindowedTail,
    drainNextQueued: vi.fn(),
    drainOrDropQueue: vi.fn(),
    evictUnretainedTranscripts: vi.fn(),
  };
  vm.runInNewContext(rendererCode, context);
  cleanups.push(() => {
    options.historyGate?.resolve();
    options.snapshotGate?.resolve();
    engine.close();
    connection.dispose();
    reader.dispose();
  });
  return {
    send: () =>
      (context.send as (...args: unknown[]) => Promise<void>)(
        CHAT,
        PROMPT,
        PROMPT,
        undefined,
        undefined,
        undefined,
        undefined,
        () => setLiveChatDraft(CHAT, null),
      ),
    finished,
    completed,
    request,
    historyRead,
    history,
    rows,
    provider,
    prepare,
    retire,
    service,
    engine,
    connection,
    reader,
    authorize,
    captured,
    updates,
    changed,
    queue,
    pauseQueue,
    sending,
    transportRequest,
    receipt: () => snapshot().receipts[0],
    flushPersistence: async () => {
      await Promise.all([...authPersistence.values()]);
    },
    replaceAccount: () => {
      accountGeneration++;
    },
    reopen: async () => {
      const attachments = connection.snapshotAttachments();
      connection.dispose();
      reader.dispose();
      const nextReader = new CloudEventReader(client),
        next = new CloudAgentConnection(
          client,
          WORKSPACE,
          authorize,
          nextReader,
        );
      next.restoreAttachments(attachments);
      await next.refreshAttachments();
      useSessionsStore.getState().patchSession(CHAT, {
        ...BLANK,
        cwd: folder,
        agentId,
        sessionId,
        status: "ready",
        messages: history(),
      });
      cleanups.push(() => {
        next.dispose();
        nextReader.dispose();
      });
    },
    replayDelayedChunk: (frame: BridgeMessage) => {
      for (const listener of handlers.get(frame.type) ?? []) listener(frame);
    },
  };
}

function slot() {
  return useSessionsStore.getState().sessions[CHAT];
}
function card(messages: AgentMessage[], turnId = TURN) {
  const user = messages.find(
    (row): row is AgentTextMessage =>
      row.id === turnId && row.kind === "text" && row.role === "user",
  );
  return turnFailureForCard({
    turnId,
    events: messages,
    recoveryFailure: user?.recoveryFailure,
  });
}
function expectSingleDispatch(
  h: Awaited<ReturnType<typeof harness>>,
  count = 1,
) {
  expect(
    h.request.mock.calls.filter(([message]) => message.type === "AGENT_PROMPT"),
  ).toHaveLength(1);
  expect(
    h.service.mock.calls.filter(([input]) => input.kind === "mutate"),
  ).toHaveLength(count);
  expect(h.provider).toHaveBeenCalledTimes(count);
  expect(h.prepare).toHaveBeenCalledOnce();
  expect(h.retire).toHaveBeenCalledOnce();
  expect(
    h.service.mock.calls.filter(([input]) => input.kind === "settle"),
  ).toHaveLength(1);
  expect(
    h.request.mock.calls.filter(([message]) =>
      ["AGENT_NEW_SESSION", "AGENT_LOAD_SESSION"].includes(
        String(message.type),
      ),
    ),
  ).toHaveLength(0);
}

describe("cloud turn failure visibility across renderer, command runtime, and durable history", () => {
  it.each([
    "cloud_agent_credential_expired",
    "cloud_agent_model_not_authorized",
    "cloud_runtime_upgrade_required",
  ])(
    "retains CP admission refusal %s on its exact accepted turn, without provider execution",
    async (denial) => {
      const h = await harness({ denial });
      await h.send();
      await h.flushPersistence();
      expect(h.receipt()).toMatchObject({
        state: "failed",
        resultCode: denial,
      });
      expect(slot()).toMatchObject({
        status: "ready",
        failure: null,
        cloudAdmissionFailure: {
          code: denial,
          turnId: TURN,
          agentId: "codex",
          model: "test-model",
        },
        cloudSendWait: { state: "failed" },
        messages: [
          expect.objectContaining({
            id: TURN,
            queued: true,
            queuedEditable: true,
          }),
        ],
      });
      expect(h.finished).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ outcome: "failed", retryCount: 0 }),
      );
      expect(h.completed).not.toHaveBeenCalled();
      expect(h.prepare).toHaveBeenCalledOnce();
      expect(h.provider).not.toHaveBeenCalled();
      expect(
        h.request.mock.calls.filter(
          ([message]) => message.type === "AGENT_PROMPT",
        ),
      ).toHaveLength(1);
      expect(
        h.service.mock.calls.filter(([input]) => input.kind === "mutate"),
      ).toHaveLength(1);
      expect(h.history()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: TURN,
            recoveryFailure: { kind: "cloud-admission", message: denial },
          }),
          expect.objectContaining({
            kind: "error_notice",
            code: denial,
            turnFailure: { turnId: TURN, kind: "protocol-error" },
          }),
        ]),
      );
      await h.reopen();
      expect(card(slot().messages)).toMatchObject({
        kind: "protocol-error",
        message: expect.stringContaining("cloud"),
      });
      expect(card(slot().messages, "another-turn")).toBeNull();
      expect(h.provider).not.toHaveBeenCalled();
      expect(h.authorize).toHaveBeenCalledOnce();
    },
  );

  it.each([
    {
      agent: "claude" as const,
      nativeError: {
        type: "authentication_error",
        message: "Claude subscription sign-in expired.",
      },
      kind: "auth-required",
      code: "cloud_provider_prompt_auth_required",
      detail: "Claude subscription sign-in expired.",
    },
    {
      agent: "claude" as const,
      nativeError: {
        type: "verification_required",
        message:
          "Verify your organization at https://console.anthropic.com/settings/organization before continuing.",
      },
      kind: "verification-required",
      code: "cloud_provider_prompt_verification_required",
      detail: "https://console.anthropic.com/settings/organization",
    },
    {
      agent: "codex" as const,
      nativeError: {
        codexErrorInfo: "unauthorized",
        message: "Codex subscription credentials expired.",
      },
      kind: "auth-required",
      code: "cloud_provider_prompt_auth_required",
      detail: "Codex subscription credentials expired.",
    },
    {
      agent: "claude" as const,
      nativeError: {
        type: "cloud_credential_error",
        message:
          "The configured cloud provider could not load its credential material.",
      },
      kind: "cloud-credentials-unavailable",
      code: "cloud_provider_prompt_cloud_credential_error",
      detail:
        "The configured cloud provider could not load its credential material.",
    },
  ])(
    "keeps $agent native $kind structured, visible, and attributable after reopening",
    async (scenario) => {
      const h = await harness(scenario);
      await h.send();
      await h.flushPersistence();
      expect(h.captured).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "AGENT_PROMPT_FAILED",
            failure: expect.objectContaining({
              kind: scenario.kind,
              agentId: scenario.agent,
              stage: "prompt",
            }),
          }),
        ]),
      );
      expect(slot()).toMatchObject({
        status: scenario.kind === "auth-required" ? "auth-required" : "failed",
        failure: {
          kind: scenario.kind,
          message: expect.stringContaining(scenario.detail),
        },
      });
      expect(
        turnFailureForCard({
          turnId: TURN,
          events: slot().messages,
          fallback: slot().failure,
        }),
      ).toMatchObject({
        kind: scenario.kind,
        message: expect.stringContaining(scenario.detail),
        newChatAllowed: false,
      });
      expect(h.receipt()).toMatchObject({
        state: "failed",
        resultCode: scenario.code,
      });
      expect(h.finished).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          outcome: "failed",
          retryCount: 0,
          failure: expect.objectContaining({ kind: scenario.kind }),
        }),
      );
      expect(h.completed).not.toHaveBeenCalled();
      expectSingleDispatch(h);
      expect(mocks.refresh).not.toHaveBeenCalled();
      await h.reopen();
      expect(card(slot().messages)).toMatchObject({
        kind: scenario.kind,
        message: expect.stringContaining(scenario.detail),
        newChatAllowed: false,
      });
      expect(card(slot().messages, "another-turn")).toBeNull();
      expect(
        slot().messages.filter((row) => row.kind === "error_notice"),
      ).toHaveLength(1);
      expectSingleDispatch(h);
      expect(h.authorize).toHaveBeenCalledOnce();
    },
  );

  it.each([
    "cloud_admission_authority_http_4xx",
    "cloud_containment_canary_failed",
  ])(
    "preserves closed pre-dispatch cause %s through a lost terminal and reopen",
    async (denial) => {
      const h = await harness({ denial, loseTerminal: true });
      await h.send();
      await h.flushPersistence();
      expect(slot()).toMatchObject({
        status: "failed",
        failure: { kind: "protocol-error", stage: "initialize" },
      });
      expect(h.receipt()).toMatchObject({
        state: "failed",
        resultCode: denial,
      });
      expect(h.finished).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ outcome: "failed", retryCount: 0 }),
      );
      expect(h.completed).not.toHaveBeenCalled();
      expect(h.provider).not.toHaveBeenCalled();
      expect(h.prepare).toHaveBeenCalledOnce();
      expect(h.retire).toHaveBeenCalledOnce();
      expect(
        h.service.mock.calls.filter(([input]) => input.kind === "mutate"),
      ).toHaveLength(1);
      await h.reopen();
      expect(card(slot().messages)).toMatchObject({
        kind: "protocol-error",
        message: expect.stringContaining(
          denial.includes("canary")
            ? "runtime safety check"
            : "Cloud agent execution admission",
        ),
      });
      expect(slot().messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "error_notice",
            code: denial,
            turnFailure: { turnId: TURN, kind: "protocol-error" },
          }),
        ]),
      );
      expect(h.provider).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "recovers a lost provider terminal from its failed receipt (partial=%s), without replay",
    async (partial) => {
      const h = await harness({
        agent: "claude",
        nativeError: {
          type: "api_error",
          message: "The synthetic provider rejected this request.",
        },
        loseTerminal: true,
        partial,
      });
      await h.send();
      await h.flushPersistence();
      expect(slot()).toMatchObject({
        status: "failed",
        failure: {
          kind: "protocol-error",
          stage: "prompt",
          message: expect.stringContaining("Cloud provider prompt"),
        },
      });
      expect(h.receipt()).toMatchObject({
        state: "failed",
        resultCode: "cloud_provider_prompt_protocol_error",
      });
      expect(h.finished).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          outcome: partial ? "interrupted" : "failed",
          retryCount: 0,
        }),
      );
      expect(h.completed).not.toHaveBeenCalled();
      expectSingleDispatch(h);
      await h.reopen();
      expect(card(slot().messages)).toMatchObject({
        kind: "protocol-error",
        message: expect.stringContaining(
          "The synthetic provider rejected this request.",
        ),
      });
      if (partial)
        expect(slot().messages).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: "saved-partial",
              text: "Partial answer.",
            }),
          ]),
        );
      expect(slot().messages.filter((row) => row.id === TURN)).toHaveLength(1);
      expectSingleDispatch(h);
    },
  );

  it("holds a succeeded receipt through snapshot and transcript catch-up, then installs the full answer once", async () => {
    const snapshotGate = deferred<void>(),
      historyGate = deferred<void>();
    const h = await harness({ snapshotGate, historyGate, delayedChunk: true });
    const flight = h.send();
    await vi.waitFor(() =>
      expect(h.receipt()).toMatchObject({ state: "succeeded" }),
    );
    expect(slot().status).toBe("streaming");
    expect(h.finished).not.toHaveBeenCalled();
    expect(h.historyRead).not.toHaveBeenCalled();
    expect(useSessionsStore.getState().pendingLocalTurns[CHAT]).toBe(TURN);
    await vi.waitFor(() =>
      expect(
        h.transportRequest.mock.calls.some(
          ([message]) =>
            message.op === "cloudEvents.request" &&
            ((message.params as WireRecord).request as WireRecord).kind ===
              "snapshot",
        ),
      ).toBe(true),
    );
    const delayed = h.captured.find(
      (frame) => frame.type === "AGENT_SESSION_UPDATE",
    )!;
    expect(delayed.cloudStream?.sequence).toBe(1);
    h.replayDelayedChunk(delayed);
    expect(h.updates).not.toHaveBeenCalled();
    snapshotGate.resolve();
    await vi.waitFor(() => expect(h.historyRead).toHaveBeenCalledOnce());
    expect(h.changed).toHaveBeenCalledOnce();
    expect(h.finished).not.toHaveBeenCalled();
    expect(slot().status).toBe("streaming");
    historyGate.resolve();
    await flight;
    expect(slot()).toMatchObject({
      status: "ready",
      failure: null,
      messages: [
        expect.objectContaining({ id: TURN }),
        expect.objectContaining({ id: "saved-answer", text: ANSWER }),
      ],
    });
    expect(h.finished).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ outcome: "completed", retryCount: 0 }),
    );
    expect(useSessionsStore.getState().pendingLocalTurns[CHAT]).toBeUndefined();
    expectSingleDispatch(h);
    // This chunk belongs to the installed snapshot floor. It must not duplicate
    // the persisted answer when it finally arrives from the old stream.
    h.replayDelayedChunk(delayed);
    expect(h.updates).not.toHaveBeenCalled();
    expect(
      slot().messages.filter(
        (row) => row.kind === "text" && row.role === "agent",
      ),
    ).toHaveLength(1);
    await h.reopen();
    expect(card(slot().messages)).toBeNull();
    expect(slot().messages.at(-1)).toMatchObject({
      id: "saved-answer",
      text: ANSWER,
    });
    expectSingleDispatch(h);
  });

  it.each(["empty", "tool"] as const)(
    "accepts native %s success without requiring assistant text",
    async (successContent) => {
      const h = await harness({ successContent });
      await h.send();
      expect(slot()).toMatchObject({ status: "ready", failure: null });
      expect(
        slot().messages.filter(
          (row) => row.kind === "text" && row.role === "agent",
        ),
      ).toHaveLength(0);
      if (successContent === "tool")
        expect(slot().messages).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: "saved-tool", status: "completed" }),
          ]),
        );
      expect(h.finished).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ outcome: "completed", retryCount: 0 }),
      );
      expect(h.historyRead).toHaveBeenCalledOnce();
      expectSingleDispatch(h);
      await h.reopen();
      expect(card(slot().messages)).toBeNull();
      expectSingleDispatch(h);
    },
  );

  it("reports transcript recovery failure durably instead of completing an empty succeeded receipt", async () => {
    const h = await harness({ emptyHistory: true });
    await h.send();
    await h.flushPersistence();
    expect(slot()).toMatchObject({
      status: "failed",
      failure: { kind: "protocol-error" },
    });
    expect(h.finished).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ outcome: "failed", retryCount: 0 }),
    );
    expect(h.completed).not.toHaveBeenCalled();
    expectSingleDispatch(h);
    await h.reopen();
    expect(card(slot().messages)).toMatchObject({
      kind: "protocol-error",
      message: expect.stringContaining("transcript"),
    });
    expectSingleDispatch(h);
  });

  it.each(["/personal/local", "/organization/local"])(
    "preserves normal Local sends for %s",
    async (folder) => {
      const h = await harness({ folder });
      await h.send();
      expect(slot()).toMatchObject({
        cwd: folder,
        status: "ready",
        failure: null,
        messages: [
          expect.objectContaining({ text: PROMPT }),
          expect.objectContaining({ id: "local-answer", text: ANSWER }),
        ],
      });
      expect(slot().cloudAdmissionFailure).toBeUndefined();
      expect(h.request).toHaveBeenCalledOnce();
      expect(h.finished).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ outcome: "completed", retryCount: 0 }),
      );
      expect(h.authorize).not.toHaveBeenCalled();
      expect(h.service).not.toHaveBeenCalled();
      expect(h.provider).not.toHaveBeenCalled();
      expect(h.historyRead).not.toHaveBeenCalled();
    },
  );

  it.each(["owner", "placement", "account"])(
    "fences late transcript recovery after a %s switch",
    async (switchKind) => {
      const historyGate = deferred<void>(),
        h = await harness({ historyGate });
      const flight = h.send();
      await vi.waitFor(() => expect(h.historyRead).toHaveBeenCalledOnce());
      const replacement = {
        ...BLANK,
        cwd:
          switchKind === "placement"
            ? "/organization/local"
            : switchKind === "account"
              ? CLOUD
              : `cloud://66666666-6666-4666-8666-666666666666/${WORKSPACE}`,
        agentId: "codex",
        sessionId: ROUTE,
        executionId: ROUTE,
        status: "ready" as const,
        hasTranscript: true,
        messages: [
          {
            id: "replacement-turn",
            kind: "text" as const,
            role: "user" as const,
            text: "Replacement prompt",
            createdAt: 10,
          },
        ],
      };
      if (switchKind === "account") h.replaceAccount();
      useSessionsStore.getState().patchSession(CHAT, replacement);
      useSessionsStore.getState().setPendingLocalTurn(CHAT, "replacement-turn");
      historyGate.resolve();
      await flight;
      expect(slot()).toMatchObject(replacement);
      expect(useSessionsStore.getState().pendingLocalTurns[CHAT]).toBe(
        "replacement-turn",
      );
      expect(
        h.request.mock.calls.filter(
          ([message]) => message.op === "messages.import",
        ),
      ).toHaveLength(0);
      expect(h.completed).not.toHaveBeenCalled();
      expectSingleDispatch(h);
    },
  );
});
