import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), stop: vi.fn() }));
vi.mock("../../../platform/runtime", async importOriginal => ({
  ...await importOriginal<typeof import("../../../platform/runtime")>(),
  nativeInvoke: native.invoke,
  nativeListen: native.listen,
}));
import { BLANK, useSessionsStore } from "../../agent/sessions-store";
import type { AgentSessionState, PendingQuestion } from "../../agent/use-agent-session";
import { anyAgentNeedsKeepAwake, startKeepAwakeActivityReporter } from "../keep-awake-activity";

const owners = [
  ["Local", "/personal/project"],
  ["organization-local", "/organization/project"],
  ["cloud", "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222"],
] as const;
const backgroundTasks = [{ taskId: "test-task", name: "Run tests", startedAt: 1, updatedAt: 2 }];
const workflows = [{ taskId: "review", name: "Review", status: "running" as const, phases: [], startedAt: 1, updatedAt: 2 }];
const question = (blocking: boolean): PendingQuestion => ({
  questionId: "ask", agentId: "claude",
  request: { sessionId: "session", questionId: "ask", nativeRequestId: "ask-native", source: "native_dialog", blocking, questions: [] },
});
const store = () => useSessionsStore.getState();
const active = () => anyAgentNeedsKeepAwake(store());
let dispose: (() => void) | undefined;
let refresh: (() => void) | undefined;

beforeEach(() => {
  store().clearAll();
  vi.clearAllMocks();
  refresh = undefined;
  native.invoke.mockResolvedValue(undefined);
  native.listen.mockImplementation((_event, listener) => {
    refresh = listener;
    return Promise.resolve(native.stop);
  });
});
afterEach(() => { dispose?.(); dispose = undefined; });

describe.each(owners)("keep awake activity for %s", (_owner, cwd) => {
  const set = (patch: Partial<AgentSessionState>) => store().setSession("chat", { ...BLANK, cwd, ...patch });

  it.each(["claude", "codex", "cursor"])("counts %s foreground, background and workflow work", agentId => {
    set({ agentId, status: "streaming" });
    expect(active()).toBe(true);
    set({ agentId, status: "ready", backgroundTasks });
    expect(active()).toBe(true);
    set({ agentId, status: "ready", workflows });
    expect(active()).toBe(true);
    set({ agentId, status: "ready" });
    expect(active()).toBe(false);
  });

  it.each(["idle", "ready", "warming", "reconnecting", "failed"] as const)("ignores an idle %s session", status => {
    set({ status, agentId: "codex" });
    expect(active()).toBe(false);
  });

  it("keeps an admitted foreground turn through a session rebuild", () => {
    set({ status: "reconnecting", agentId: "claude", activeTurnStartedAt: 1 });
    expect(active()).toBe(true);
    set({ status: "reconnecting", agentId: "claude", activeTurnStartedAt: 1, lastStopReason: "cancelled" });
    expect(active()).toBe(false);
  });

  it("releases for a blocking question but retains independent tasks and workflows", () => {
    set({ status: "streaming", agentId: "claude", pendingQuestions: [question(true)] });
    store().setPendingLocalTurn("chat", "turn");
    expect(active()).toBe(false);
    store().patchSession("chat", { backgroundTasks });
    expect(active()).toBe(true);
    store().patchSession("chat", { backgroundTasks: [], workflows });
    expect(active()).toBe(true);
    store().patchSession("chat", { workflows: [], pendingQuestions: [question(false)] });
    expect(active()).toBe(true);
  });

  it("releases for permission and plan review until there is independent work", () => {
    const pendingPermission = {
      permissionId: "gate", agentId: "claude",
      request: { sessionId: "session", toolCall: { toolCallId: "tool", title: "ExitPlanMode" }, options: [] },
    };
    set({ agentId: "claude", status: "streaming", pendingPermission });
    expect(active()).toBe(false);
    store().patchSession("chat", { backgroundTasks });
    expect(active()).toBe(true);
  });

  it("releases after Stop, completion and session removal", () => {
    set({ agentId: "codex", status: "ready", backgroundTasks });
    expect(active()).toBe(true);
    store().patchSession("chat", { backgroundTasks: [] });
    expect(active()).toBe(false);
    store().patchSession("chat", { backgroundTasks, lastStopReason: "cancelled" });
    expect(active()).toBe(false);
    store().clearAll();
    expect(active()).toBe(false);
  });

  it("does not treat an idle Claude monitor as active background work", () => {
    set({ agentId: "claude", status: "streaming", backgroundActivity: { state: "idle", startedAt: 1 } });
    expect(active()).toBe(false);
    store().patchSession("chat", { backgroundTasks, waitingForBackgroundTasks: true });
    expect(active()).toBe(true);
  });
});

it("keeps a queued cloud send awake only until it fails or is stopped", () => {
  for (const [placement, cwd] of owners) {
    store().setSession("queued", {
      ...BLANK, cwd, cloudSendWait: { state: "waiting", phase: "starting-workspace", turnId: "turn", startedAt: 1 },
    });
    expect(active()).toBe(placement === "cloud");
  }
  store().patchSession("queued", { cloudSendWait: { state: "failed", turnId: "turn", message: "Stopped" } });
  expect(active()).toBe(false);
});

it("keeps a send awake across a temporarily missing session slot", () => {
  store().setPendingLocalTurn("missing", "turn");
  expect(active()).toBe(true);
  store().setPendingLocalTurn("missing", null);
  expect(active()).toBe(false);
});

describe("global activity reporter", () => {
  it("aggregates owners and placements until the last task ends, without token-chunk IPC", async () => {
    dispose = startKeepAwakeActivityReporter();
    await Promise.resolve();
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith("keep_awake_activity", { active: false });
    for (const [owner, cwd] of owners) store().setSession(owner, { ...BLANK, agentId: "codex", cwd, status: "streaming" });
    expect(native.invoke).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 100; i++) store().patchSession("Local", { usage: { ...BLANK.usage, outputTokens: i } });
    expect(native.invoke).toHaveBeenCalledTimes(2);
    // Switching/removing Local and organization-local views cannot release
    // work still owned by a cloud chat in another workspace.
    store().patchSession("Local", { status: "ready" });
    store().patchSession("organization-local", { status: "ready" });
    expect(native.invoke).toHaveBeenCalledTimes(2);
    store().patchSession("cloud", { status: "ready", backgroundTasks });
    expect(native.invoke).toHaveBeenCalledTimes(2);
    store().patchSession("cloud", { backgroundTasks: [] });
    expect(native.invoke).toHaveBeenLastCalledWith("keep_awake_activity", { active: false });
    expect(native.invoke).toHaveBeenCalledTimes(3);
  });

  it("answers native refreshes from current state even without a store change", async () => {
    store().setSession("cloud", { ...BLANK, cwd: owners[2][1], status: "ready", backgroundTasks });
    dispose = startKeepAwakeActivityReporter();
    await Promise.resolve();
    native.invoke.mockClear();
    refresh!();
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith("keep_awake_activity", { active: true });
  });

  it("unsubscribes and releases activity when the app controller unmounts", async () => {
    dispose = startKeepAwakeActivityReporter();
    await Promise.resolve();
    dispose();
    dispose = undefined;
    native.invoke.mockClear();
    store().setPendingLocalTurn("new", "turn");
    refresh!();
    expect(native.invoke).not.toHaveBeenCalled();
    expect(native.stop).toHaveBeenCalledOnce();
  });

  it("disposes a late native subscription without publishing old activity", async () => {
    let resolve!: (stop: () => void) => void;
    native.listen.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    dispose = startKeepAwakeActivityReporter();
    dispose();
    dispose = undefined;
    native.invoke.mockClear();
    resolve(native.stop);
    await Promise.resolve();
    expect(native.stop).toHaveBeenCalledOnce();
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it("retries a failed report on the next activity observation", async () => {
    dispose = startKeepAwakeActivityReporter();
    await Promise.resolve();
    native.invoke.mockRejectedValueOnce(new Error("temporarily unavailable"));
    store().setPendingLocalTurn("new", "turn");
    await Promise.resolve();
    native.invoke.mockClear();
    refresh!();
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith("keep_awake_activity", { active: true });
  });
});
