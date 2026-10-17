// The engine ports reuse the desktop's own handlers through a private
// receiver: session bind (new vs resume), synchronous acceptance, busy and
// expired routes, steer receipts, cancel, and workspace prepare → create.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { closeZerosDb, setZerosDbPathForTesting } from "../../db/index";
import { upsertChat, type ChatRow } from "../../db/chats";
import { recordHumanStop } from "../../db/local-orchestration";
import type { TransportClient } from "../../transport/types";
import { createMessage, type EngineMessage } from "../../types";
import { createLocalEnginePorts, isLocalOrchestrationReceiver, type LocalEngineHost } from "../engine-ports";

function chatRow(id: string, extra: Partial<ChatRow> = {}): ChatRow {
  return {
    id,
    folder: "/tmp/zeros-local-ports/ws",
    agentId: "claude",
    agentName: "Claude Code",
    model: null,
    effort: "high",
    permissionMode: "auto",
    lastModeId: "auto",
    prePlanModeId: null,
    fast: false,
    additionalDirectories: [],
    title: id,
    createdAt: 1,
    updatedAt: 1,
    sessionId: null,
    providerBinding: null,
    providerMetadata: null,
    pinned: false,
    archived: false,
    sourceChatId: null,
    kind: null,
    ...extra,
  };
}

class FakeEngine {
  executions = new Map<string, { executionId: string; agentId: string }>();
  prompts = new Map<string, { turnId: string; startedAt: number; cancelled: boolean; ended: boolean }>();
  dispatched: EngineMessage[] = [];
  clients: TransportClient[] = [];
  busy = false;
  expireOnce = false;
  sessionError: string | null = null;
  supersedeOnce = false;
  onSupersede: (() => void) | null = null;
  steerOutcome: "delivered" | "queued" | "interrupted" = "delivered";
  marked: Array<[string, boolean]> = [];
  workspaceReplies = new Map<string, unknown>();
  sessionFailureKind: string | null = null;
  /** Presentations staged, with how many messages had been dispatched then. */
  staged: Array<{ messageId: string; presentation: unknown; dispatchedBefore: number }> = [];
  removed: string[] = [];
  connected = true;

  host(): LocalEngineHost {
    return {
      linkScheme: () => "zeros-dev",
      isCloudWorker: () => false,
      featureOpen: () => true,
      executionForChat: (chatId) => this.executions.get(chatId) ?? null,
      activePrompt: (executionId) => this.prompts.get(executionId) ?? null,
      currentModeId: () => null,
      chatForExecution: () => null,
      pendingPermissions: () => [],
      pendingQuestions: () => [],
      answerPermission: () => false,
      answerQuestion: () => false,
      initializeSnapshot: () => null,
      currentInitialize: async () => null,
      warmInitialize: () => {},
      agentDisplayName: () => null,
      dispatchAgent: (message, client) => this.dispatchAgent(message, client),
      dispatchWorkspace: async (message, client) => {
        this.dispatched.push(message);
        this.clients.push(client);
        const result = this.workspaceReplies.get(message.op);
        client.send(
          result instanceof Error
            ? createMessage({ type: "WORKSPACE_ERROR", source: "engine", requestId: message.id, op: message.op, code: "X", message: result.message })
            : createMessage({ type: "WORKSPACE_RESPONSE", source: "engine", requestId: message.id, op: message.op, result }),
        );
      },
      chatsChanged: () => {},
      markOrchestrationWorkspace: (id, created) => {
        this.marked.push([id, created]);
      },
      stagePresentation: (messageId, presentation) => {
        this.staged.push({ messageId, presentation, dispatchedBefore: this.dispatched.length });
      },
      agentAccountConnected: () => this.connected,
      removeChat: (chatId) => {
        this.removed.push(chatId);
      },
    };
  }

  /** Mirrors the handler contract: replies to the caller before resolving,
   * and records an accepted prompt before its first await. */
  dispatchAgent(message: EngineMessage, client: TransportClient): Promise<void> {
    this.dispatched.push(message);
    this.clients.push(client);
    const chatId = (message as { chatId?: string }).chatId ?? "";
    switch (message.type) {
      case "AGENT_NEW_SESSION":
      case "AGENT_LOAD_SESSION": {
        if (this.supersedeOnce) {
          // The user's own tab bound the chat first.
          this.supersedeOnce = false;
          this.onSupersede?.();
          this.executions.set(chatId, { executionId: "exec-renderer", agentId: message.agentId });
          client.send(createMessage({ type: "AGENT_ERROR", source: "engine", requestId: message.id, agentId: message.agentId, code: "AGENT_LIFECYCLE_SUPERSEDED", message: "superseded", failure: { kind: "lifecycle-superseded", stage: "newSession", message: "superseded" } as never }));
          return Promise.resolve();
        }
        if (this.sessionError) {
          client.send(createMessage({
            type: "AGENT_ERROR",
            source: "engine",
            requestId: message.id,
            agentId: message.agentId,
            code: "X",
            message: this.sessionError,
            ...(this.sessionFailureKind ? { failure: { kind: this.sessionFailureKind, stage: "newSession", message: this.sessionError } as never } : {}),
          }));
          return Promise.resolve();
        }
        const executionId = `exec-${this.executions.size + 1}`;
        this.executions.set(chatId, { executionId, agentId: message.agentId });
        client.send(
          message.type === "AGENT_NEW_SESSION"
            ? createMessage({ type: "AGENT_SESSION_CREATED", source: "engine", requestId: message.id, agentId: message.agentId, session: { sessionId: executionId, executionId } as never, initialize: {} as never })
            : createMessage({ type: "AGENT_SESSION_LOADED", source: "engine", requestId: message.id, agentId: message.agentId, sessionId: executionId, executionId, response: {} }),
        );
        return Promise.resolve();
      }
      case "AGENT_PROMPT": {
        if (this.expireOnce) {
          this.expireOnce = false;
          for (const [id, live] of this.executions) if (live.executionId === message.sessionId) this.executions.delete(id);
          client.send(createMessage({ type: "AGENT_PROMPT_FAILED", source: "engine", requestId: message.id, agentId: message.agentId, sessionId: message.sessionId, error: "expired", failure: { kind: "session-expired", stage: "prompt", agentId: message.agentId, message: "expired" } as never }));
          return Promise.resolve();
        }
        if (this.busy) {
          client.send(createMessage({ type: "AGENT_PROMPT_FAILED", source: "engine", requestId: message.id, agentId: message.agentId, sessionId: message.sessionId, error: "The agent is already responding to this chat." }));
          return Promise.resolve();
        }
        this.prompts.set(message.sessionId, { turnId: message.userMessageId!, startedAt: 1, cancelled: false, ended: false });
        return new Promise(() => {});
      }
      case "AGENT_STEER":
        client.send(createMessage({ type: "AGENT_STEERED", source: "engine", requestId: message.id, agentId: message.agentId, sessionId: message.sessionId, outcome: this.steerOutcome }));
        return Promise.resolve();
      default:
        return Promise.resolve();
    }
  }
}

let engine: FakeEngine;

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-local-ports-db-"));
  setZerosDbPathForTesting(path.join(dir, "zeros.db"));
  engine = new FakeEngine();
});

afterEach(() => {
  closeZerosDb();
});

const turn = (chatId: string, extra: Partial<{ workspaceId: string }> = {}) => ({
  chatId,
  agentId: "claude",
  folder: "/tmp/zeros-local-ports/ws",
  env: { ZEROS_PERMISSION_MODE: "auto" },
  text: "hello",
  turnId: "user-1",
  ...extra,
});

describe("Local CLI engine ports", () => {
  it("starts a new provider conversation for a chat that has none, then prompts it", async () => {
    upsertChat(chatRow("c1"));
    const ports = createLocalEnginePorts(engine.host());
    const outcome = await ports.startTurn(turn("c1", { workspaceId: "ws_1" }));
    expect(outcome).toEqual({ kind: "accepted", executionId: "exec-1", turnId: "user-1" });
    const [bind, prompt] = engine.dispatched;
    expect(bind).toMatchObject({ type: "AGENT_NEW_SESSION", agentId: "claude", chatId: "c1", cwd: "/tmp/zeros-local-ports/ws", workspaceId: "ws_1", env: { ZEROS_PERMISSION_MODE: "auto" } });
    expect(prompt).toMatchObject({ type: "AGENT_PROMPT", sessionId: "exec-1", userMessageId: "user-1", prompt: [{ type: "text", text: "hello" }] });
    expect(engine.clients.every((client) => isLocalOrchestrationReceiver(client) && client.kind === "local")).toBe(true);
  });

  it("resumes a chat's provider conversation instead of starting a new one", async () => {
    const binding = { version: 1 as const, providerId: "claude", kind: "native" as const, resumeId: "native-1" };
    upsertChat(chatRow("c2", { providerBinding: binding }));
    const ports = createLocalEnginePorts(engine.host());
    await ports.startTurn(turn("c2"));
    expect(engine.dispatched[0]).toMatchObject({ type: "AGENT_LOAD_SESSION", chatId: "c2", providerBinding: binding });
  });

  it("prompts a live execution directly and reports a busy chat", async () => {
    upsertChat(chatRow("c3"));
    engine.executions.set("c3", { executionId: "exec-live", agentId: "claude" });
    engine.busy = true;
    engine.prompts.set("exec-live", { turnId: "user-0", startedAt: 1, cancelled: false, ended: false });
    const ports = createLocalEnginePorts(engine.host());
    expect(await ports.startTurn(turn("c3"))).toEqual({ kind: "busy", executionId: "exec-live", activeTurnId: "user-0" });
    expect(engine.dispatched.map((m) => m.type)).toEqual(["AGENT_PROMPT"]);
  });

  it("binds once more when the route expired between bind and prompt", async () => {
    upsertChat(chatRow("c4"));
    engine.executions.set("c4", { executionId: "exec-old", agentId: "claude" });
    engine.expireOnce = true;
    const ports = createLocalEnginePorts(engine.host());
    const outcome = await ports.startTurn(turn("c4"));
    expect(outcome.kind).toBe("accepted");
    expect(engine.dispatched.map((m) => m.type)).toEqual(["AGENT_PROMPT", "AGENT_NEW_SESSION", "AGENT_PROMPT"]);
  });

  it("uses the user's own bind when it wins the race", async () => {
    upsertChat(chatRow("c9"));
    engine.supersedeOnce = true;
    const ports = createLocalEnginePorts(engine.host());
    expect(await ports.startTurn(turn("c9"))).toEqual({ kind: "accepted", executionId: "exec-renderer", turnId: "user-1" });
    expect(engine.dispatched.map((m) => m.type)).toEqual(["AGENT_NEW_SESSION", "AGENT_PROMPT"]);
  });

  it("never restarts a chat the user stopped or closed while it was binding", async () => {
    upsertChat(chatRow("c10"));
    engine.supersedeOnce = true;
    engine.onSupersede = () => recordHumanStop("c10");
    const ports = createLocalEnginePorts(engine.host());
    expect(await ports.startTurn(turn("c10"))).toMatchObject({ kind: "failed", code: "STOPPED_BY_USER" });
    expect(engine.dispatched.map((m) => m.type)).toEqual(["AGENT_NEW_SESSION"]);
  });

  it("refuses even the first bind for a chat the user stopped or closed", async () => {
    upsertChat(chatRow("c11"));
    recordHumanStop("c11");
    const ports = createLocalEnginePorts(engine.host());
    expect(await ports.startTurn(turn("c11"))).toMatchObject({ kind: "failed", code: "STOPPED_BY_USER" });
    upsertChat(chatRow("c12", { archived: true }));
    expect(await ports.startTurn(turn("c12"))).toMatchObject({ kind: "failed", code: "STALE" });
    expect(await ports.startTurn(turn("missing"))).toMatchObject({ kind: "failed", code: "STALE" });
    expect(engine.dispatched).toHaveLength(0);
  });

  it("reports a provider that could not start", async () => {
    upsertChat(chatRow("c5"));
    engine.sessionError = "Claude Code is not signed in.";
    const ports = createLocalEnginePorts(engine.host());
    expect(await ports.startTurn(turn("c5"))).toEqual({ kind: "failed", message: "Claude Code is not signed in.", code: "UNAVAILABLE" });
  });

  it("names the provider failure behind a bind that could not start", async () => {
    upsertChat(chatRow("c13"));
    engine.sessionError = "Sign in to this account in Settings before continuing.";
    engine.sessionFailureKind = "auth-required";
    const ports = createLocalEnginePorts(engine.host());
    expect(await ports.startTurn(turn("c13"))).toEqual({
      kind: "failed",
      message: "Sign in to this account in Settings before continuing.",
      code: "UNAVAILABLE",
      failureKind: "auth-required",
    });
  });

  it("stages how the recipient shows an input before dispatching it", async () => {
    upsertChat(chatRow("c14"));
    const ports = createLocalEnginePorts(engine.host());
    const presentation = { displayText: "hello", localFrom: { chatId: "p", title: "Parent", agentId: "claude", link: "zeros-dev://chat/p" } };
    await ports.startTurn({ ...turn("c14"), presentation });
    // Staged after the bind and before the prompt it belongs to.
    expect(engine.staged).toEqual([{ messageId: "user-1", presentation, dispatchedBefore: 1 }]);
    expect(engine.dispatched[1]).toMatchObject({ type: "AGENT_PROMPT", userMessageId: "user-1" });
    await ports.steer({ chatId: "c14", executionId: "exec-1", agentId: "claude", text: "more", messageId: "m9", presentation });
    expect(engine.staged.at(-1)).toEqual({ messageId: "m9", presentation, dispatchedBefore: 2 });
  });

  it("checks the selected account and removes a never-connected tab with its bind", async () => {
    const ports = createLocalEnginePorts(engine.host());
    expect(ports.agentConnection("cursor")).toEqual({ connected: true });
    engine.connected = false;
    expect(ports.agentConnection("cursor")).toEqual({ connected: false, message: "Sign in to cursor in Zeros Settings before starting a chat with it." });
    engine.executions.set("c15", { executionId: "exec-15", agentId: "cursor" });
    await ports.removeChat("c15");
    expect(engine.dispatched.at(-1)).toMatchObject({ type: "AGENT_CLOSE_SESSION", agentId: "cursor", sessionId: "exec-15", chatId: "c15" });
    expect((engine.dispatched.at(-1) as { userStop?: unknown }).userStop).toBeUndefined();
    expect(engine.removed).toEqual(["c15"]);
  });

  it("refuses a live session of a different agent", async () => {
    upsertChat(chatRow("c6"));
    engine.executions.set("c6", { executionId: "exec-x", agentId: "codex" });
    const ports = createLocalEnginePorts(engine.host());
    expect((await ports.startTurn(turn("c6"))).kind).toBe("failed");
    expect(engine.dispatched).toHaveLength(0);
  });

  it("maps steer receipts", async () => {
    const ports = createLocalEnginePorts(engine.host());
    const steer = () => ports.steer({ chatId: "c", executionId: "exec-1", agentId: "claude", text: "more", messageId: "m1" });
    expect(await steer()).toEqual({ kind: "delivered" });
    expect(engine.dispatched[0]).toMatchObject({ type: "AGENT_STEER", attemptId: "m1", userMessageId: "m1" });
    engine.steerOutcome = "queued";
    expect((await steer()).kind).toBe("not_delivered");
    engine.steerOutcome = "interrupted";
    expect((await steer()).kind).toBe("unknown");
  });

  it("cancels only a running turn", async () => {
    const ports = createLocalEnginePorts(engine.host());
    expect(await ports.cancelTurn("c7")).toBe("not_running");
    engine.executions.set("c7", { executionId: "exec-7", agentId: "claude" });
    engine.prompts.set("exec-7", { turnId: "t", startedAt: 1, cancelled: false, ended: false });
    expect(await ports.cancelTurn("c7")).toBe("stopped");
    expect(engine.dispatched.at(-1)).toMatchObject({ type: "AGENT_CANCEL", sessionId: "exec-7" });
  });

  it("reports a live turn as ended once its terminal state was published", () => {
    engine.executions.set("c8", { executionId: "exec-8", agentId: "claude" });
    engine.prompts.set("exec-8", { turnId: "t", startedAt: 1, cancelled: false, ended: true });
    expect(createLocalEnginePorts(engine.host()).liveChat("c8").activeTurn).toBeNull();
  });

  describe("workspace creation", () => {
    let repo: string;
    beforeEach(() => {
      repo = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-local-ports-repo-"));
      const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" }).toString().trim();
      git("init", "-q", "-b", "main");
      git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base");
      git("branch", "feature/x");
      engine.workspaceReplies.set("workspace.prepareCreate", { workspaceId: "ws_prep", path: "/tmp/w", repoSlug: "r", branch: "zeros/prep" });
      engine.workspaceReplies.set("workspace.create", { workspaceId: "ws_prep", path: "/tmp/w", branch: "zeros/prep", status: "in-progress", setupCommand: null });
    });
    const head = () => execFileSync("git", ["-C", repo, "rev-parse", "HEAD"]).toString().trim();

    it("reserves, marks and creates with the prepared identity", async () => {
      const ports = createLocalEnginePorts(engine.host());
      const created = await ports.createWorkspace({ repoRoot: repo, name: "parser fix", agentId: "codex" });
      expect(created).toMatchObject({ workspaceId: "ws_prep", path: "/tmp/w", branch: "zeros/prep" });
      const ops = engine.dispatched as Array<{ op: string; params: Record<string, unknown> }>;
      expect(ops.map((m) => m.op)).toEqual(["workspace.prepareCreate", "workspace.create"]);
      expect(ops[1]!.params).toEqual({ repoRoot: repo, preparedId: "ws_prep", preparedBranch: "zeros/prep", prompt: "parser fix", agentId: "codex" });
      expect(engine.marked).toEqual([["ws_prep", true]]);
    });

    it("keeps a named branch as the base and pins anything else to its commit", async () => {
      const ports = createLocalEnginePorts(engine.host());
      await ports.createWorkspace({ repoRoot: repo, base: { ref: "HEAD", commit: head(), cwd: repo } });
      await ports.createWorkspace({ repoRoot: repo, base: { ref: "feature/x", commit: head(), cwd: repo } });
      execFileSync("git", ["-C", repo, "checkout", "-q", "--detach"]);
      await ports.createWorkspace({ repoRoot: repo, base: { ref: "HEAD", commit: head(), cwd: repo } });
      const creates = (engine.dispatched as Array<{ op: string; params: Record<string, unknown> }>).filter((m) => m.op === "workspace.create");
      expect(creates.map((m) => m.params.baseBranch)).toEqual(["refs/heads/main", "refs/heads/feature/x", head()]);
    });

    it("unmarks a workspace whose create failed", async () => {
      engine.workspaceReplies.set("workspace.create", new Error("disk full"));
      const ports = createLocalEnginePorts(engine.host());
      await expect(ports.createWorkspace({ repoRoot: repo })).rejects.toThrow("disk full");
      expect(engine.marked).toEqual([["ws_prep", true], ["ws_prep", false]]);
    });

    it("resolves only safe refs", async () => {
      const ports = createLocalEnginePorts(engine.host());
      expect(await ports.resolveCommit(repo, "HEAD")).toBe(head());
      expect(await ports.resolveCommit(repo, "--output=/tmp/x")).toBeNull();
      expect(await ports.resolveCommit(repo, "main..HEAD")).toBeNull();
      expect(await ports.resolveCommit(repo, "nope")).toBeNull();
    });

    it("reports a workspace that no longer exists as missing", async () => {
      const ports = createLocalEnginePorts(engine.host());
      expect(await ports.workspaceReadiness("ws_gone")).toBe("missing");
    });
  });
});
