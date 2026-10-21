// Policy tests for the Zeros Local CLI service over fake engine ports and a
// real temporary database: visibility, Local-only ownership, inheritance,
// the caller's-turn rule, receipts, delivery, the user's Stop, waits, follows
// and the card guard.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { RequestPermissionRequest, RequestPermissionResponse, QuestionResponse } from "@zeros/protocol/agent-events";
import type { LocalEnvelope } from "@zeros/protocol/local-orchestration";
import { closeZerosDb, setZerosDbPathForTesting } from "../../db/index";
import type { ChatRow } from "../../db/chats";
import type { EngineProject } from "../../db/projects";
import { localRootOf } from "../../db/local-orchestration";
import type { Workspace } from "../../git/types";
import { LocalOrchestrationService } from "../service";
import type {
  LocalCallerScope,
  LocalCreateWorkspaceInput,
  LocalLiveChat,
  LocalMessagePresentation,
  LocalOrchestrationPorts,
  LocalPendingCardRecord,
  LocalStartTurnInput,
  LocalStartTurnOutcome,
  LocalSteerOutcome,
} from "../types";

const REPO = "/tmp/zeros-local-svc/app";
const OTHER_REPO = "/tmp/zeros-local-svc/other";
const WS_A = "/tmp/zeros-local-svc/worktrees/a";
const WS_B = "/tmp/zeros-local-svc/worktrees/b";
const WS_ORG = "/tmp/zeros-local-svc/worktrees/org";

function workspace(id: string, wsPath: string, extra: Partial<Workspace> = {}): Workspace {
  return {
    id,
    repoSlug: "app",
    repoRoot: REPO,
    branch: `zeros/${id}`,
    baseBranch: "main",
    path: wsPath,
    status: "in-progress" as Workspace["status"],
    createdAt: 1,
    archivedAt: null,
    stashRef: null,
    prNumber: null,
    prState: null,
    prUrl: null,
    agentId: null,
    lastActiveAt: null,
    organizationId: null,
    placement: "local",
    present: true,
    ...extra,
  };
}

function project(id: string, root: string, name: string): EngineProject {
  return { id, canonicalId: `${id}-uuid`, name, repoRoot: root, repoSlug: name, originUrl: null, addedAt: 1 };
}

function chat(id: string, folder: string, extra: Partial<ChatRow> = {}): ChatRow {
  return {
    id,
    folder,
    agentId: "claude",
    agentName: "Claude Code",
    model: "claude-opus-5-5",
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

class FakePorts implements LocalOrchestrationPorts {
  open = true;
  scheme: "zeros-dev" | "zeros" = "zeros-dev";
  managed: Workspace[] = [workspace("ws_a", WS_A), workspace("ws_b", WS_B), workspace("ws_org", WS_ORG, { organizationId: "org_1" })];
  projects: EngineProject[] = [project("proj_app", REPO, "app"), project("proj_other", OTHER_REPO, "other")];
  chats = new Map<string, ChatRow>();
  live = new Map<string, LocalLiveChat>();
  cards: LocalPendingCardRecord[] = [];
  started: LocalStartTurnInput[] = [];
  steered: Array<{ chatId: string; text: string; presentation?: LocalMessagePresentation }> = [];
  removed: string[] = [];
  disconnected = new Set<string>();
  cancelled: string[] = [];
  modes: Array<{ chatId: string; modeId: string }> = [];
  modeUpdates: Array<{ chatId: string; lastModeId: string | null }> = [];
  answers: Array<{ id: string; response: unknown }> = [];
  createdWorkspaces: LocalCreateWorkspaceInput[] = [];
  startOutcome: (input: LocalStartTurnInput) => LocalStartTurnOutcome = (input) => {
    this.setLive(input.chatId, input.turnId);
    return { kind: "accepted", executionId: `exec-${input.chatId}`, turnId: input.turnId };
  };

  setLive(chatId: string, turnId: string | null, modeId: string | null = null): void {
    this.live.set(chatId, {
      executionId: `exec-${chatId}`,
      agentId: this.chats.get(chatId)?.agentId ?? "claude",
      activeTurn: turnId ? { turnId, cancelled: false, startedAt: Date.now() } : null,
      modeId,
    });
  }

  engineId = () => "engine-test";
  linkScheme = () => this.scheme;
  featureOpen = () => this.open;
  listManagedWorkspaces = () => this.managed;
  getManagedWorkspace = (id: string) => this.managed.find((w) => w.id === id) ?? null;
  listProjects = () => this.projects;
  getChat = (id: string) => this.chats.get(id) ?? null;
  listChats = () => [...this.chats.values()];
  wasChatDeleted = () => false;
  upsertChat = (row: ChatRow) => {
    this.chats.set(row.id, row);
  };
  updateChatMode = (chatId: string, mode: { permissionMode: string; lastModeId: string | null; prePlanModeId: string | null }) => {
    const row = this.chats.get(chatId);
    if (row) this.chats.set(chatId, { ...row, ...mode });
    this.modeUpdates.push({ chatId, lastModeId: mode.lastModeId });
  };
  agentDisplayName = (agentId: string) => (agentId === "codex" ? "Codex" : "Claude Code");
  liveChat = (chatId: string): LocalLiveChat =>
    this.live.get(chatId) ?? { executionId: null, agentId: null, activeTurn: null, modeId: null };
  pendingCards = () => this.cards;
  initializeSnapshot = (_agentId?: string): import("@zeros/protocol/agent-events").InitializeResponse | null => null;
  currentInitialize = async (agentId: string) => this.initializeSnapshot(agentId);
  userSettings = () => ({});
  startTurn = async (input: LocalStartTurnInput) => {
    this.started.push(input);
    return this.startOutcome(input);
  };
  steer = async (input: { chatId: string; text: string; presentation?: LocalMessagePresentation }) => {
    this.steered.push({ chatId: input.chatId, text: input.text, ...(input.presentation ? { presentation: input.presentation } : {}) });
    return { kind: "delivered" as const };
  };
  cancelTurn = async (chatId: string) => {
    this.cancelled.push(chatId);
    return "stopped" as const;
  };
  answeredBy: unknown[] = [];
  answerPermission = (card: LocalPendingCardRecord, response: RequestPermissionResponse, answeredBy?: unknown) => {
    this.answers.push({ id: card.id, response });
    this.answeredBy.push(answeredBy);
    this.cards = this.cards.filter((c) => c.id !== card.id);
    return true;
  };
  answerQuestion = (card: LocalPendingCardRecord, response: QuestionResponse) => {
    this.answers.push({ id: card.id, response });
    this.cards = this.cards.filter((c) => c.id !== card.id);
    return true;
  };
  setMode = async (chatId: string, modeId: string) => {
    this.modes.push({ chatId, modeId });
  };
  createWorkspace = async (input: LocalCreateWorkspaceInput) => {
    this.createdWorkspaces.push(input);
    const id = `ws_new${this.createdWorkspaces.length}`;
    const wsPath = `/tmp/zeros-local-svc/worktrees/new${this.createdWorkspaces.length}`;
    this.managed = [...this.managed, workspace(id, wsPath, { repoRoot: input.repoRoot })];
    return { workspaceId: id, path: wsPath, branch: `zeros/${id}`, repoRoot: input.repoRoot, baseBranch: "main" };
  };
  workspaceReadiness = async () => "ready" as const;
  resolveCommit = async (_cwd: string, ref: string) => (ref === "missing" ? null : "a".repeat(40));
  announced: string[] = [];
  chatsChanged = (chatIds: string[]) => {
    this.announced.push(...chatIds);
  };
  agentConnection = (agentId: string) =>
    this.disconnected.has(agentId)
      ? { connected: false as const, message: `Sign in to ${agentId} in Zeros Settings before starting a chat with it.` }
      : { connected: true as const };
  removeChat = async (chatId: string) => {
    this.removed.push(chatId);
    this.chats.delete(chatId);
  };
}

let ports: FakePorts;
let service: LocalOrchestrationService;
const parent: LocalCallerScope = { executionId: "exec-p", chatId: "p", agentId: "claude", surface: "cli" };

async function call(scope: LocalCallerScope, command: string, args: Record<string, unknown> = {}, requestId?: string) {
  return service.call(scope, { protocol: 1, command, args, ...(requestId ? { requestId } : {}) });
}

function ok<T = Record<string, unknown>>(envelope: LocalEnvelope): T {
  if (!envelope.ok) throw new Error(`${envelope.error.code}: ${envelope.error.message}`);
  return envelope.result as T;
}

function code(envelope: LocalEnvelope): string | null {
  return envelope.ok ? null : envelope.error.code;
}

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-local-svc-db-"));
  setZerosDbPathForTesting(path.join(dir, "zeros.db"));
  ports = new FakePorts();
  service = new LocalOrchestrationService(ports, { isKnownAgent: (id) => ["claude", "codex", "cursor"].includes(id) });
  ports.upsertChat(chat("p", WS_A, { title: "Parent" }));
  ports.upsertChat(chat("s", WS_A, { title: "Sibling tab" }));
  ports.upsertChat(chat("x", WS_B, { title: "Other workspace" }));
  ports.upsertChat(chat("o", WS_ORG, { title: "Organization" }));
  ports.upsertChat(chat("r", REPO, { title: "Main checkout" }));
  ports.setLive("p", "turn-p");
});

afterEach(() => {
  closeZerosDb();
});

describe("Local CLI visibility", () => {
  it("lists the caller's workspace and nothing else until something is shared", async () => {
    const { chats } = ok<{ chats: Array<{ chatId: string; visibleAs: string }> }>(await call(parent, "chat.list"));
    expect(chats.map((c) => c.chatId).sort()).toEqual(["p", "s"]);
    expect(code(await call(parent, "chat.status", { chat: "x" }))).toBe("NOT_FOUND");
    expect(code(await call(parent, "chat.messages", { chat: "o" }))).toBe("NOT_FOUND");
  });

  it("shares a link the user pastes with the whole family, children included", async () => {
    service.onUserMessagePersisted({ chatId: "p", messageId: "m1", text: "Read zeros-dev://chat/x.", human: true });
    expect(ok(await call(parent, "chat.status", { chat: "zeros-dev://chat/x" }))).toBeTruthy();
    const created = ok<{ chatId: string }>(await call(parent, "chat.create", { message: "Coordinate with x" }));
    const child: LocalCallerScope = { executionId: `exec-${created.chatId}`, chatId: created.chatId, agentId: "claude", surface: "cli" };
    expect(ok(await call(child, "chat.status", { chat: "x" }))).toBeTruthy();
    // …and the parent sees everything the child's workspace holds.
    expect(localRootOf(created.chatId)).toBe("p");
  });

  it("ignores a link from another channel and links an agent cannot see", async () => {
    service.onUserMessagePersisted({ chatId: "p", messageId: "m1", text: "zeros-beta://chat/x", human: true });
    expect(code(await call(parent, "chat.status", { chat: "x" }))).toBe("NOT_FOUND");
    expect(code(await call(parent, "chat.status", { chat: "zeros-beta://chat/s" }))).toBe("NOT_FOUND");
    // p cannot see x, so mentioning it to the sibling shares nothing.
    ok(await call(parent, "message.send", { chat: "s", message: "see zeros-dev://chat/x" }));
    const sibling: LocalCallerScope = { executionId: "exec-s", chatId: "s", agentId: "claude", surface: "cli" };
    ports.setLive("s", "turn-s");
    expect(code(await call(sibling, "chat.status", { chat: "x" }))).toBe("NOT_FOUND");
  });

  it("lets a chat an agent messaged reply to that agent", async () => {
    service.onUserMessagePersisted({ chatId: "p", messageId: "m1", text: "zeros-dev://chat/x", human: true });
    ok(await call(parent, "message.send", { chat: "x", message: "please review" }));
    const other: LocalCallerScope = { executionId: "exec-x", chatId: "x", agentId: "claude", surface: "cli" };
    ports.setLive("x", "turn-x");
    expect(ok(await call(other, "chat.status", { chat: "p" }))).toBeTruthy();
    // …but not the rest of the sender's workspace.
    expect(code(await call(other, "chat.status", { chat: "s" }))).toBe("NOT_FOUND");
  });

  it("leaves terminal tabs out: they have no conversation to drive", async () => {
    ports.upsertChat(chat("term", WS_A, { kind: "terminal" }));
    const { chats } = ok<{ chats: Array<{ chatId: string }> }>(await call(parent, "chat.list"));
    expect(chats.map((c) => c.chatId)).not.toContain("term");
    expect(code(await call(parent, "message.send", { chat: "term", message: "hi" }))).toBe("USAGE");
    expect(ports.started).toHaveLength(0);
  });

  it("refuses organization callers and closed copies", async () => {
    const org: LocalCallerScope = { executionId: "exec-o", chatId: "o", agentId: "claude", surface: "cli" };
    expect(code(await call(org, "whoami"))).toBe("NOT_LOCAL");
    ports.open = false;
    expect(code(await call(parent, "whoami"))).toBe("UNAVAILABLE");
  });

  it("lists every repository added to Zeros", async () => {
    const result = ok<{ repos: Array<{ repoRoot: string }> }>(await call(parent, "repo.list"));
    expect(result.repos.map((r) => r.repoRoot).sort()).toEqual([REPO, OTHER_REPO].sort());
  });

  it("formats links for this channel", async () => {
    const result = ok<{ link: string }>(await call(parent, "link", { target: "s" }));
    expect(result.link).toBe("zeros-dev://chat/s");
    const ws = ok<{ link: string }>(await call(parent, "link", { target: "current" }));
    expect(ws.link).toBe("zeros-dev://workspace/ws_a");
  });
});

describe("Local CLI chat creation", () => {
  it("copies the creator's agent, model, effort and exact mode", async () => {
    const created = ok<{ chatId: string; state: string }>(await call(parent, "chat.create", { message: "Write the docs", title: "Docs" }));
    expect(created.state).toBe("working");
    const row = ports.chats.get(created.chatId)!;
    expect(row).toMatchObject({ agentId: "claude", model: "claude-opus-5-5", effort: "high", lastModeId: "auto", folder: WS_A, title: "Docs" });
    expect(ports.started[0]).toMatchObject({ chatId: created.chatId, agentId: "claude", folder: WS_A, workspaceId: "ws_a" });
    // The child reads who sent its brief.
    expect(ports.started[0]!.text).toBe('[Zeros] From agent "Parent" (zeros-dev://chat/p):\n\nWrite the docs');
    expect(ports.started[0]!.presentation).toEqual({
      displayText: "Write the docs",
      localFrom: { chatId: "p", title: "Parent", agentId: "claude", link: "zeros-dev://chat/p" },
    });
    expect(ports.started[0]!.env.ZEROS_PERMISSION_MODE).toBe("auto");
  });

  it("reads each agent's current catalog, not a snapshot from before a model was refused", async () => {
    const live = (selectable: boolean) => ({ _meta: { modelsAccountScoped: true, models: [{ value: "grok-4.7", label: "Grok 4.7", selectable }, { value: "composer-2", label: "Composer 2" }] } }) as never;
    ports.initializeSnapshot = (agentId) => (agentId === "cursor" ? live(true) : null);
    ports.currentInitialize = async (agentId) => (agentId === "cursor" ? live(false) : null);
    const { models } = ok<{ models: Array<{ agent: string; model: string; availability: string }> }>(await call(parent, "models", { agent: "cursor" }));
    expect(models.find((m) => m.model === "grok-4.7")?.availability).toBe("unavailable");
  });

  it("says which agents are signed out before anyone tries them", async () => {
    ports.disconnected.add("cursor");
    const { models } = ok<{ models: Array<{ agent: string; signedIn: boolean }> }>(await call(parent, "models"));
    expect(new Set(models.filter((m) => m.agent === "cursor").map((m) => m.signedIn))).toEqual(new Set([false]));
    expect(new Set(models.filter((m) => m.agent === "codex").map((m) => m.signedIn))).toEqual(new Set([true]));
  });

  it("lets Zeros name a chat created without a title, like one the user starts", async () => {
    const created = ok<{ chatId: string; title: string }>(await call(parent, "chat.create", { message: "You are research agent 1 of 2 for a deep audit" }));
    expect(created.title).toBe("New chat");
    expect(ports.chats.get(created.chatId)!.title).toBe("New chat");
  });

  it("never opens a tab for an agent whose account is signed out", async () => {
    ports.disconnected.add("cursor");
    const before = ports.chats.size;
    const refused = await call(parent, "chat.create", { message: "audit", agent: "cursor", model: "grok-4.7" }, "req-auth");
    expect(code(refused)).toBe("AUTH_REQUIRED");
    expect(refused.ok ? null : refused.error.details).toBeUndefined();
    expect(ports.chats.size).toBe(before);
    expect(ports.started).toHaveLength(0);
    // Nor a worktree for a first chat that could not run.
    expect(code(await call(parent, "workspace.create", { repo: "current", chat: { agent: "cursor", message: "audit" } }))).toBe("AUTH_REQUIRED");
    expect(ports.createdWorkspaces).toHaveLength(0);
  });

  it("removes a new tab whose agent never connected, and keeps one that hit a rate limit", async () => {
    ports.startOutcome = () => ({ kind: "failed", message: "Cursor is not signed in.", code: "UNAVAILABLE", failureKind: "auth-required" });
    const refused = await call(parent, "chat.create", { message: "audit", agent: "cursor" }, "req-gone");
    expect(code(refused)).toBe("AUTH_REQUIRED");
    expect(refused.ok ? null : refused.error.details).toBeUndefined();
    const removedId = ports.started[0]!.chatId;
    expect(ports.removed).toEqual([removedId]);
    // Never announced to renderers: the tab is not shown even briefly.
    expect(ports.announced).not.toContain(removedId);
    expect(ports.chats.has(removedId)).toBe(false);
    expect(ok<{ chats: Array<{ chatId: string }> }>(await call(parent, "chat.list", { tree: true })).chats.some((c) => c.chatId === removedId)).toBe(false);
    // A retry reports the same failure without a link to a tab that is gone.
    expect(code(await call(parent, "chat.create", { message: "audit", agent: "cursor" }, "req-gone"))).toBe("AUTH_REQUIRED");

    ports.startOutcome = () => ({ kind: "failed", message: "Rate limited.", code: "UNAVAILABLE", failureKind: "rate-limited" });
    const limited = await call(parent, "chat.create", { message: "audit", agent: "cursor" });
    expect(code(limited)).toBe("UNAVAILABLE");
    const kept = ports.started.at(-1)!.chatId;
    expect(ports.chats.has(kept)).toBe(true);
    expect(ports.announced).toContain(kept);
    expect(limited.ok ? null : limited.error.details).toMatchObject({ chatId: kept });
    expect(ports.removed).toHaveLength(1);
  });

  it("never gives a new chat more permission than its creator", async () => {
    expect(code(await call(parent, "chat.create", { message: "x", mode: "bypass" }))).toBe("MODE_FORBIDS");
    ports.upsertChat({ ...ports.chats.get("p")!, lastModeId: "plan", permissionMode: "plan" });
    expect(code(await call(parent, "chat.create", { message: "x" }))).toBe("MODE_FORBIDS");
  });

  it("acts only from the caller's own running turn", async () => {
    ports.setLive("p", null);
    expect(code(await call(parent, "chat.create", { message: "x" }))).toBe("NO_CAPABILITY");
    ports.setLive("p", "turn-p");
    expect(code(await call({ ...parent, executionId: "exec-old" }, "chat.create", { message: "x" }))).toBe("NO_CAPABILITY");
    // Reads stay available.
    expect(ok(await call({ ...parent, executionId: "exec-old" }, "chat.list"))).toBeTruthy();
  });

  it("replays a request id and refuses it for different content", async () => {
    const first = ok<{ chatId: string }>(await call(parent, "chat.create", { message: "one" }, "req-1"));
    const again = ok<{ chatId: string; replayed: boolean }>(await call(parent, "chat.create", { message: "one" }, "req-1"));
    expect(again.chatId).toBe(first.chatId);
    expect(again.replayed).toBe(true);
    expect(ports.started).toHaveLength(1);
    expect(code(await call(parent, "chat.create", { message: "two" }, "req-1"))).toBe("REQUEST_CONFLICT");
  });

  it("answers a retried refused request with its original failure", async () => {
    expect(code(await call(parent, "chat.create", { message: "x", mode: "bypass" }, "req-refused"))).toBe("MODE_FORBIDS");
    const again = await call(parent, "chat.create", { message: "x", mode: "bypass" }, "req-refused");
    expect(code(again)).toBe("MODE_FORBIDS");
    expect(ports.started).toHaveLength(0);
  });

  it.each(["STOPPED_BY_USER", "OUTCOME_UNKNOWN", "UNAVAILABLE"] as const)(
    "replays a failed chat creation as %s even when its tab metadata is retained",
    async (failureCode) => {
      ports.startOutcome = () => ({ kind: "failed", code: failureCode, message: "The first turn did not start.", failureKind: "rate-limited" });
      const args = { message: "Review the changes" };
      const first = await call(parent, "chat.create", args, "failed-create");
      expect(code(first)).toBe(failureCode);
      const replay = await call(parent, "chat.create", args, "failed-create");
      expect(replay).toMatchObject({ ok: false, error: { code: failureCode } });
      expect(ports.started).toHaveLength(1);
      expect(ports.removed).toHaveLength(0);
    },
  );

  it.each(["chat.create", "message.send"] as const)("replays a late %s failure after returning starting", async (command) => {
    let settle!: (outcome: LocalStartTurnOutcome) => void;
    ports.startTurn = (input) => {
      ports.started.push(input);
      return new Promise<LocalStartTurnOutcome>((resolve) => { settle = resolve; });
    };
    const args = command === "chat.create" ? { message: "slow start" } : { chat: "s", message: "slow start" };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const first = call(parent, command, args, "late-failure");
      await vi.advanceTimersByTimeAsync(6_000);
      expect(ok(await first)).toMatchObject(command === "chat.create" ? { state: "starting" } : { delivery: "starting" });
      settle({ kind: "failed", code: "STOPPED_BY_USER", message: "Stopped during admission." });
      await vi.advanceTimersByTimeAsync(0);
      expect(await call(parent, command, args, "late-failure"))
        .toMatchObject({ ok: false, error: { code: "STOPPED_BY_USER", message: "Stopped during admission." } });
      expect(ports.started).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it("keeps a busy creation's retry policy when replaying its failure", async () => {
    ports.startOutcome = () => ({ kind: "busy", executionId: "exec-new", activeTurnId: "existing-turn" });
    const args = { message: "Review the changes" };
    const first = await call(parent, "chat.create", args, "busy-create");
    expect(first).toMatchObject({ ok: false, error: { code: "BUSY", retryable: false } });
    const replay = await call(parent, "chat.create", args, "busy-create");
    expect(replay).toMatchObject({ ok: false, error: { code: "BUSY", retryable: false } });
    expect(ports.started).toHaveLength(1);
  });

  it("answers `starting` when the provider is slow and records the outcome later", async () => {
    let resolveStart!: (outcome: LocalStartTurnOutcome) => void;
    ports.startTurn = (input) => {
      ports.started.push(input);
      return new Promise<LocalStartTurnOutcome>((resolve) => {
        resolveStart = resolve;
      });
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = call(parent, "chat.create", { message: "slow" }, "req-slow");
      await vi.advanceTimersByTimeAsync(6_000);
      const created = ok<{ chatId: string; state: string }>(await pending);
      expect(created.state).toBe("starting");
      resolveStart({ kind: "accepted", executionId: "exec", turnId: ports.started[0]!.turnId });
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.useRealTimers();
    }
    const replay = ok<{ requestState: string }>(await call(parent, "chat.create", { message: "slow" }, "req-slow"));
    expect(replay.requestState).toBe("dispatched");
  });
});

describe("Local CLI messages", () => {
  it.each(["STOPPED_BY_USER", "OUTCOME_UNKNOWN", "UNAVAILABLE"] as const)(
    "replays a failed message send with its original %s code",
    async (failureCode) => {
      ports.startOutcome = () => ({ kind: "failed", code: failureCode, message: "The message did not start." });
      const args = { chat: "s", message: "Review the changes" };
      expect(code(await call(parent, "message.send", args, "failed-send"))).toBe(failureCode);
      const replay = await call(parent, "message.send", args, "failed-send");
      expect(replay).toMatchObject({ ok: false, error: { code: failureCode } });
      expect(ports.started).toHaveLength(1);
    },
  );

  it("replays a busy message send with the original retryable failure", async () => {
    ports.startOutcome = () => ({ kind: "busy", executionId: "exec-s", activeTurnId: "raced-turn" });
    const args = { chat: "s", message: "Review the changes" };
    const first = await call(parent, "message.send", args, "busy-send");
    expect(first).toMatchObject({ ok: false, error: { code: "BUSY", retryable: true, details: { turnId: "raced-turn" } } });
    const replay = await call(parent, "message.send", args, "busy-send");
    expect(replay).toMatchObject({ ok: false, error: { code: "BUSY", retryable: true, details: { turnId: "raced-turn" } } });
    expect(ports.started).toHaveLength(1);
  });

  it("steers a working chat and starts a turn in an idle one", async () => {
    ports.setLive("s", "turn-s");
    const steered = ok<{ steered: boolean }>(await call(parent, "message.send", { chat: "s", message: "use option B" }));
    expect(steered.steered).toBe(true);
    expect(ports.steered).toEqual([
      {
        chatId: "s",
        text: '[Zeros] From agent "Parent" (zeros-dev://chat/p):\n\nuse option B',
        // The recipient's transcript shows the sender's own words under a header.
        presentation: { displayText: "use option B", localFrom: { chatId: "p", title: "Parent", agentId: "claude", link: "zeros-dev://chat/p" } },
      },
    ]);
    expect(code(await call(parent, "message.send", { chat: "s", message: "later", delivery: "new-turn" }))).toBe("BUSY");
    ports.setLive("s", null);
    const started = ok<{ delivery: string }>(await call(parent, "message.send", { chat: "s", message: "next task" }));
    expect(started.delivery).toBe("new_turn");
    expect(ports.started.at(-1)).toMatchObject({ chatId: "s" });
    expect(ports.started.at(-1)!.text).toMatch(/^\[Zeros\] From agent "Parent" .*\n\nnext task$/s);
    expect(code(await call(parent, "message.send", { chat: "p", message: "me" }))).toBe("USAGE");
  });

  it("answers `pending` when a working chat has not consumed the steer yet, and never steers twice", async () => {
    ports.setLive("s", "turn-s");
    let confirm!: () => void;
    ports.steer = async (input: { chatId: string; text: string }) => {
      ports.steered.push({ chatId: input.chatId, text: input.text });
      await new Promise<void>((resolve) => (confirm = resolve));
      return { kind: "delivered" as const };
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = call(parent, "message.send", { chat: "s", message: "hold on" }, "steer-1");
      await vi.advanceTimersByTimeAsync(6_000);
      expect(ok<{ delivery: string }>(await pending).delivery).toBe("pending");
      // A retry before confirmation neither steers again nor claims delivery.
      expect(code(await call(parent, "message.send", { chat: "s", message: "hold on" }, "steer-1"))).toBe("STALE");
      confirm();
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.useRealTimers();
    }
    const replay = ok<{ delivery: string; replayed: boolean }>(await call(parent, "message.send", { chat: "s", message: "hold on" }, "steer-1"));
    expect(replay).toMatchObject({ delivery: "delivered", replayed: true });
    expect(ports.steered).toHaveLength(1);
  });

  it("holds agents back after the user's Stop until the user writes again", async () => {
    service.onHumanStop("s");
    expect(code(await call(parent, "message.send", { chat: "s", message: "go on" }))).toBe("STOPPED_BY_USER");
    service.onUserMessagePersisted({ chatId: "s", messageId: "m2", text: "continue", human: true });
    expect(ok(await call(parent, "message.send", { chat: "s", message: "go on" }))).toBeTruthy();
  });

  it("cancels another chat but never itself", async () => {
    ports.setLive("s", "turn-s");
    expect(ok<{ outcome: string }>(await call(parent, "chat.cancel", { chat: "s" })).outcome).toBe("stopped");
    expect(code(await call(parent, "chat.cancel", { chat: "p" }))).toBe("USAGE");
  });
});

describe("Local CLI waiting and following", () => {
  it("returns when the awaited turn ends", async () => {
    const created = ok<{ chatId: string; turnId: string }>(await call(parent, "chat.create", { message: "work" }));
    const waiting = call(parent, "chat.wait", { targets: [{ chat: created.chatId }], until: "done", timeoutMs: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    ports.setLive(created.chatId, null);
    service.onTurnTerminal({ chatId: created.chatId, turnId: created.turnId, status: "completed" });
    const result = ok<{ timedOut: boolean; results: Array<{ met: boolean }> }>(await waiting);
    expect(result.timedOut).toBe(false);
    expect(result.results[0]!.met).toBe(true);
  });

  it("stops waiting for attention when a card opens", async () => {
    const created = ok<{ chatId: string }>(await call(parent, "chat.create", { message: "work" }));
    const waiting = call(parent, "chat.wait", { targets: [{ chat: created.chatId }], timeoutMs: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const card: LocalPendingCardRecord = {
      id: "perm-1",
      type: "permission",
      chatId: created.chatId,
      executionId: `exec-${created.chatId}`,
      agentId: "claude",
      permission: permissionRequest(`exec-${created.chatId}`),
    };
    ports.cards.push(card);
    service.onCardOpened(card);
    const result = ok<{ reason: string }>(await waiting);
    expect(result.reason).toBe("attention");
  });

  it("refuses to wait for itself", async () => {
    expect(code(await call(parent, "chat.wait", { targets: [{ chat: "p" }], timeoutMs: 10 }))).toBe("USAGE");
  });

  it("notifies a follower once when a followed turn ends, steering it while it works", async () => {
    const created = ok<{ chatId: string; turnId: string }>(await call(parent, "chat.create", { message: "work", notify: true }));
    ports.setLive(created.chatId, null);
    service.onTurnTerminal({ chatId: created.chatId, turnId: created.turnId, status: "completed" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const notes = ports.steered.filter((s) => s.chatId === "p");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.text).toContain("[Zeros]");
    // The follower's transcript shows a note row, not a user message.
    expect(notes[0]!.presentation).toEqual({
      displayText: `Chat "New chat" finished its turn: completed.`,
      localNote: { chatId: created.chatId, title: "New chat", agentId: "claude", link: `zeros-dev://chat/${created.chatId}`, event: "done", status: "completed" },
    });
    service.onTurnTerminal({ chatId: created.chatId, turnId: created.turnId, status: "completed" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ports.steered.filter((s) => s.chatId === "p")).toHaveLength(1);
  });
});

describe("Local CLI standing reads recheck authority", () => {
  it("does not notify a follower after its source moves out of view", async () => {
    ok(await call(parent, "chat.follow", { chat: "s" }));
    ports.upsertChat({ ...ports.chats.get("s")!, folder: WS_B });
    expect(code(await call(parent, "chat.status", { chat: "s" }))).toBe("NOT_FOUND");
    service.onCardOpened({ id: "private-card", type: "permission", chatId: "s", executionId: "exec-s", agentId: "claude", permission: permissionRequest("exec-s") });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ports.steered).toEqual([]);
  });

  it("does not notify after the rollout gate closes", async () => {
    ok(await call(parent, "chat.follow", { chat: "s" }));
    ports.open = false;
    service.onTurnTerminal({ chatId: "s", turnId: "turn-s", status: "completed" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ports.steered).toEqual([]);
    expect(ports.started).toEqual([]);
  });

  it("ends a wait whose target became private instead of returning its cards", async () => {
    ports.setLive("s", "turn-s");
    const waiting = call(parent, "chat.wait", { targets: [{ chat: "s" }], timeoutMs: 1_000 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    ports.upsertChat({ ...ports.chats.get("s")!, folder: WS_B });
    const card: LocalPendingCardRecord = { id: "private-card", type: "permission", chatId: "s", executionId: "exec-s", agentId: "claude", permission: permissionRequest("exec-s") };
    ports.cards.push(card);
    service.onCardOpened(card);
    expect(code(await waiting)).toBe("NOT_FOUND");
  });

  it("ends a wait when the caller moves to an organization workspace", async () => {
    ports.setLive("s", "turn-s");
    const waiting = call(parent, "chat.wait", { targets: [{ chat: "s" }], timeoutMs: 1_000 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    ports.upsertChat({ ...ports.chats.get("p")!, folder: WS_ORG });
    service.onChatChanged("s");
    expect(code(await waiting)).toBe("NOT_LOCAL");
  });
});

describe("Local CLI note delivery", () => {
  it("delivers a note once even when the follower flushes while it is on its way", async () => {
    const created = ok<{ chatId: string; turnId: string }>(await call(parent, "chat.create", { message: "work", notify: true }));
    ports.setLive("p", null);
    ports.setLive(created.chatId, null);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    ports.startTurn = async (input) => {
      ports.started.push(input);
      await gate;
      return { kind: "accepted", executionId: "exec-p", turnId: input.turnId };
    };
    service.onTurnTerminal({ chatId: created.chatId, turnId: created.turnId, status: "completed" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The follower's own turn ends while the note is still being started.
    service.onTurnTerminal({ chatId: "p", turnId: "turn-p", status: "completed" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ports.started.filter((s) => s.chatId === "p")).toHaveLength(1);
  });
});

describe("Local CLI note delivery after a restart", () => {
  it("never sends a note again when the engine stopped mid-delivery", async () => {
    const created = ok<{ chatId: string; turnId: string }>(await call(parent, "chat.create", { message: "work", notify: true }));
    ports.setLive("p", null);
    ports.setLive(created.chatId, null);
    ports.startTurn = async (input) => {
      ports.started.push(input);
      return new Promise<LocalStartTurnOutcome>(() => {});
    };
    service.onTurnTerminal({ chatId: created.chatId, turnId: created.turnId, status: "completed" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ports.started.filter((s) => s.chatId === "p")).toHaveLength(1);
    // A new engine, same database: the follower goes idle and flushes.
    const restarted = new LocalOrchestrationService(ports, { isKnownAgent: () => true });
    ports.startTurn = async (input) => {
      ports.started.push(input);
      return { kind: "accepted", executionId: "exec-p", turnId: input.turnId };
    };
    restarted.onTurnTerminal({ chatId: "p", turnId: "turn-p", status: "completed" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ports.started.filter((s) => s.chatId === "p")).toHaveLength(1);
  });

  it("retries a note that was known not to be delivered", async () => {
    const created = ok<{ chatId: string; turnId: string }>(await call(parent, "chat.create", { message: "work", notify: true }));
    ports.setLive("p", null);
    ports.setLive(created.chatId, null);
    let busy = true;
    ports.startTurn = async (input) => {
      ports.started.push(input);
      return busy ? { kind: "busy", executionId: "exec-p", activeTurnId: "x" } : { kind: "accepted", executionId: "exec-p", turnId: input.turnId };
    };
    service.onTurnTerminal({ chatId: created.chatId, turnId: created.turnId, status: "completed" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    busy = false;
    service.onTurnTerminal({ chatId: "p", turnId: "turn-p", status: "completed" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ports.started.filter((s) => s.chatId === "p")).toHaveLength(2);
  });
});

describe("Local CLI and the user's Stop", () => {
  it("never revives a note the user's Stop retired while its delivery was in flight", async () => {
    ok(await call(parent, "chat.follow", { chat: "s" }));
    let settle!: (outcome: LocalSteerOutcome) => void;
    ports.steer = (async (input: { chatId: string; text: string }) => {
      ports.steered.push({ chatId: input.chatId, text: input.text });
      return new Promise<LocalSteerOutcome>((resolve) => (settle = resolve));
    }) as unknown as typeof ports.steer;
    service.onTurnTerminal({ chatId: "s", turnId: "before-stop", status: "completed" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ports.steered).toHaveLength(1);
    service.onHumanStop("p");
    service.onUserMessagePersisted({ chatId: "p", messageId: "new-human-send", text: "A new task", human: true });
    settle({ kind: "not_delivered", reason: "the turn changed" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    ports.setLive("p", null);
    service.onTurnTerminal({ chatId: "p", turnId: "new-human-send", status: "completed" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ports.started).toEqual([]);
  });

  it("does not send a new workspace's first message after the user stopped the tab", async () => {
    let ready!: () => void;
    ports.workspaceReadiness = () => new Promise((resolve) => (ready = () => resolve("ready")));
    const created = ok<{ chat: { chatId: string } }>(await call(parent, "workspace.create", { repo: "current", chat: { message: "work" } }, "ws-stop"));
    service.onHumanStop(created.chat.chatId);
    ready();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ports.started).toEqual([]);
    const status = ok<{ chat: { state: string } }>(await call(parent, "chat.status", { chat: created.chat.chatId }));
    expect(status.chat.state).not.toBe("provisioning");
  });

  it("returns the outer request id from workspace creation, usable for a retry", async () => {
    const created = ok<{ requestId: string; chat: { requestId: string } }>(
      await call(parent, "workspace.create", { repo: "current", chat: { message: "work" } }, "public-ws"),
    );
    expect(created.requestId).toBe("public-ws");
    expect(created.chat.requestId).toBe("public-ws");
    const replay = await call(parent, "workspace.create", { repo: "current", chat: { message: "work" } }, created.chat.requestId);
    expect(ok<{ replayed: boolean }>(replay).replayed).toBe(true);
  });
});

describe("Local CLI cards", () => {
  function childWithCard(level: { lastModeId: string; prePlanModeId?: string | null }, request = permissionRequest("exec-c")) {
    ports.upsertChat(chat("c", WS_A, { lastModeId: level.lastModeId, prePlanModeId: level.prePlanModeId ?? null, permissionMode: level.lastModeId === "plan" ? "plan" : "auto" }));
    ports.setLive("c", "turn-c");
    ports.cards.push({ id: "perm-1", type: "permission", chatId: "c", executionId: "exec-c", agentId: "claude", permission: request });
  }

  it("lets an Auto caller approve a card of a chat at its level, and records who did", async () => {
    childWithCard({ lastModeId: "auto" });
    const answered = ok<{ answered: string }>(await call(parent, "card.answer", { card: "perm:perm-1", option: "allow" }));
    expect(answered.answered).toBe("allow");
    expect(ports.answers).toHaveLength(1);
    expect(ports.answeredBy).toEqual([{ kind: "agent", chatId: "p", title: "Parent", link: "zeros-dev://chat/p" }]);
    const status = ok<{ answeredCards: Array<{ cardId: string; answer: string; answeredBy: string }> }>(await call(parent, "chat.status", { chat: "c" }));
    expect(status.answeredCards).toEqual([expect.objectContaining({ cardId: "perm:perm-1", answer: "allow", answeredBy: "zeros-dev://chat/p" })]);
  });

  it("lets an Ask caller deny but not approve", async () => {
    childWithCard({ lastModeId: "auto" });
    ports.upsertChat({ ...ports.chats.get("p")!, lastModeId: "default", permissionMode: "tool-approval" });
    expect(code(await call(parent, "card.answer", { card: "perm:perm-1", option: "allow" }))).toBe("APPROVAL_GUARD");
    expect(ok<{ answered: string }>(await call(parent, "card.answer", { card: "perm:perm-1", deny: true })).answered).toBe("denied");
  });

  it("refuses approval above the caller's level", async () => {
    childWithCard({ lastModeId: "bypass" });
    expect(code(await call(parent, "card.answer", { card: "perm:perm-1", option: "allow" }))).toBe("APPROVAL_GUARD");
  });

  it("returns an approved plan to the mode it left", async () => {
    childWithCard({ lastModeId: "plan", prePlanModeId: "accept-edits" }, planRequest("exec-c"));
    ok(await call(parent, "card.answer", { card: "perm:perm-1", option: "allow" }));
    expect(ports.modes).toEqual([{ chatId: "c", modeId: "accept-edits" }]);
    expect(ports.modeUpdates).toEqual([{ chatId: "c", lastModeId: "accept-edits" }]);
  });

  it("guards approvals that a provider sends as questions", async () => {
    ports.upsertChat(chat("c", WS_A));
    ports.setLive("c", "turn-c");
    ports.cards.push({
      id: "q-1",
      type: "question",
      chatId: "c",
      executionId: "exec-c",
      agentId: "codex",
      question: {
        sessionId: "exec-c",
        questionId: "q-1",
        nativeRequestId: "n-1",
        source: "native_rpc",
        blocking: true,
        questions: [
          {
            id: "approve",
            prompt: "Allow the tool to run?",
            presentation: "one_click_approval",
            allowOther: true,
            options: [
              { id: "accept", label: "Allow" },
              { id: "decline", label: "Decline" },
            ],
          },
        ],
      } as never,
    });
    ports.upsertChat({ ...ports.chats.get("p")!, lastModeId: "default", permissionMode: "tool-approval" });
    expect(code(await call(parent, "card.answer", { card: "q:q-1", option: "accept" }))).toBe("APPROVAL_GUARD");
    expect(code(await call(parent, "card.answer", { card: "q:q-1", text: "yes, go ahead" }))).toBe("USAGE");
    expect(ok<{ answered: string }>(await call(parent, "card.answer", { card: "q:q-1", deny: true })).answered).toBe("declined");
  });

  it("reports an already answered card", async () => {
    expect(code(await call(parent, "card.answer", { card: "perm:gone", deny: true }))).toBe("ALREADY_SETTLED");
  });
});

describe("Local CLI workspaces", () => {
  it("stacks a new workspace in the caller's repo on the caller's work", async () => {
    const result = ok<{ workspace: { workspaceId: string } }>(await call(parent, "workspace.create", { repo: "current" }));
    expect(ports.createdWorkspaces[0]).toMatchObject({ repoRoot: REPO, base: { ref: "HEAD", cwd: WS_A } });
    // The family can see the workspace it created.
    expect(ok(await call(parent, "workspace.status", { workspace: result.workspace.workspaceId }))).toBeTruthy();
  });

  it("starts another repository from its default base and honours --base", async () => {
    ok(await call(parent, "workspace.create", { repo: OTHER_REPO }));
    expect(ports.createdWorkspaces[0]!.base).toBeUndefined();
    ok(await call(parent, "workspace.create", { repo: "proj_other", base: "release" }));
    expect(ports.createdWorkspaces[1]).toMatchObject({ repoRoot: OTHER_REPO, base: { ref: "release", cwd: OTHER_REPO } });
    expect(code(await call(parent, "workspace.create", { repo: "current", base: "missing" }))).toBe("USAGE");
  });

  it("keeps a workspace's first-chat step apart from the caller's own request ids", async () => {
    const sent = ok<{ chatId: string }>(await call(parent, "message.send", { chat: "s", message: "hello" }, "job.chat"));
    ok(await call(parent, "workspace.create", { repo: "current", chat: { message: "work" } }, "job"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const replay = ok<{ chatId: string; replayed: boolean }>(await call(parent, "message.send", { chat: "s", message: "hello" }, "job.chat"));
    expect(replay).toMatchObject({ chatId: sent.chatId, replayed: true });
    expect(sent.chatId).toBe("s");
  });

  it("creates the first chat in a new workspace once it is ready", async () => {
    const result = ok<{ chat: { chatId: string; state: string } }>(
      await call(parent, "workspace.create", { repo: "current", chat: { message: "Fix the parser", agent: "codex", mode: "auto-edit" } }),
    );
    expect(result.chat.state).toBe("provisioning");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ports.started.at(-1)).toMatchObject({ chatId: result.chat.chatId, agentId: "codex" });
    expect(ports.started.at(-1)!.text).toMatch(/\n\nFix the parser$/);
    expect(ports.chats.get(result.chat.chatId)).toMatchObject({ agentId: "codex", lastModeId: "auto-edit" });
  });
});

function permissionRequest(sessionId: string): RequestPermissionRequest {
  return {
    sessionId,
    toolCall: { toolCallId: "t1", title: "Run tests", kind: "execute" },
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ],
  } as unknown as RequestPermissionRequest;
}

function planRequest(sessionId: string): RequestPermissionRequest {
  return {
    sessionId,
    toolCall: { toolCallId: "t2", title: "ExitPlanMode", kind: "switch_mode", rawInput: { plan: "1. Do it" } },
    options: [
      { optionId: "allow", name: "Yes", kind: "allow_once" },
      { optionId: "reject", name: "No", kind: "reject_once" },
    ],
  } as unknown as RequestPermissionRequest;
}
