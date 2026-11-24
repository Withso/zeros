import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  classifyHiddenChatSession,
  createPristineSessionRetirer,
  HIDDEN_PRISTINE_SESSION_GRACE_MS,
  HIDDEN_PRISTINE_SESSIONS_KEPT,
  planHiddenPristineRetirement,
  type HiddenSessionState,
  type PristineSessionSnapshot,
} from "../pristine-session-retire";

const flush = () => Promise.resolve();

const pristine: PristineSessionSnapshot = {
  status: "ready",
  hasTranscript: false,
  transcriptLoading: false,
  messageCount: 0,
  chatTitle: "Untitled",
  composerHasText: false,
  pendingAutoSend: false,
  running: false,
  queuedCount: 0,
  pendingInteraction: false,
  cloudActivity: false,
};

describe("classifyHiddenChatSession", () => {
  it("treats an untouched ready or warming session as live", () => {
    expect(classifyHiddenChatSession(pristine)).toBe("live");
    expect(classifyHiddenChatSession({ ...pristine, status: "warming" })).toBe("live");
  });

  it.each<[string, Partial<PristineSessionSnapshot>]>([
    ["a transcript", { hasTranscript: true }],
    ["messages", { messageCount: 1 }],
    ["a promoted title", { chatTitle: "Fix the build" }],
    ["composer text", { composerHasText: true }],
    ["a pending auto-send", { pendingAutoSend: true }],
    ["a streaming turn", { status: "streaming" }],
    ["running work", { running: true }],
    ["a queued message waiting on admission", { status: "warming", queuedCount: 1 }],
    ["a permission or question card", { pendingInteraction: true }],
    ["cloud turn ownership", { cloudActivity: true }],
  ])("never retires a session with %s", (_name, patch) => {
    expect(classifyHiddenChatSession({ ...pristine, ...patch })).toBe("busy");
  });

  it.each(["idle", "failed", "auth-required", "reconnecting"] as const)(
    "leaves a %s session alone",
    (status) => {
      expect(classifyHiddenChatSession({ ...pristine, status })).toBe("dormant");
    },
  );

  it("treats a missing slot, or a transcript still loading, as dormant", () => {
    expect(classifyHiddenChatSession({ ...pristine, status: null })).toBe("dormant");
    expect(classifyHiddenChatSession({ ...pristine, transcriptLoading: true })).toBe("dormant");
  });
});

describe("planHiddenPristineRetirement", () => {
  const states = (map: Record<string, HiddenSessionState>) => (chatId: string) => map[chatId] ?? "live";

  it("keeps exactly one hidden pristine session", () => {
    expect(HIDDEN_PRISTINE_SESSIONS_KEPT).toBe(1);
    expect(HIDDEN_PRISTINE_SESSION_GRACE_MS).toBe(120_000);
  });

  it("keeps the most recently hidden live session and retires the rest at once", () => {
    const plan = planHiddenPristineRetirement(
      [{ chatId: "a", hiddenAt: 0 }, { chatId: "b", hiddenAt: 10 }, { chatId: "c", hiddenAt: 10 }],
      states({}),
      20,
    );
    expect(plan.retire).toEqual(["b", "a"]);
    expect(plan.release).toEqual([]);
    expect(plan.nextCheckAt).toBe(10 + HIDDEN_PRISTINE_SESSION_GRACE_MS);
  });

  it("retires the kept session once its grace period ends", () => {
    const plan = planHiddenPristineRetirement(
      [{ chatId: "a", hiddenAt: 0 }],
      states({}),
      HIDDEN_PRISTINE_SESSION_GRACE_MS,
    );
    expect(plan).toEqual({ retire: ["a"], release: [], nextCheckAt: null });
  });

  it("never retires busy sessions and stops tracking them", () => {
    const plan = planHiddenPristineRetirement(
      [{ chatId: "a", hiddenAt: 0 }, { chatId: "b", hiddenAt: 1 }],
      states({ b: "busy" }),
      2,
    );
    expect(plan.retire).toEqual([]);
    expect(plan.release).toEqual(["b"]);
    expect(plan.nextCheckAt).toBe(HIDDEN_PRISTINE_SESSION_GRACE_MS);
  });

  it("does not let a dormant chat occupy the kept slot, and rechecks it until its grace ends", () => {
    const early = planHiddenPristineRetirement(
      [{ chatId: "a", hiddenAt: 0 }, { chatId: "b", hiddenAt: 5 }],
      states({ b: "dormant" }),
      6,
    );
    expect(early).toEqual({ retire: [], release: [], nextCheckAt: HIDDEN_PRISTINE_SESSION_GRACE_MS });
    const late = planHiddenPristineRetirement(
      [{ chatId: "b", hiddenAt: 5 }],
      states({ b: "dormant" }),
      5 + HIDDEN_PRISTINE_SESSION_GRACE_MS,
    );
    expect(late).toEqual({ retire: [], release: ["b"], nextCheckAt: null });
  });
});

describe("createPristineSessionRetirer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = () => {
    const retirer = createPristineSessionRetirer();
    const state: Record<string, HiddenSessionState> = {};
    const retired: string[] = [];
    const handlers = (chatId: string) => ({
      classify: () => state[chatId] ?? "live",
      retire: () => void retired.push(chatId),
    });
    return { retirer, state, retired, handlers };
  };

  it("retires an earlier hidden pristine session as soon as another one hides", async () => {
    const { retirer, retired, handlers } = setup();
    for (const id of ["a", "b", "c"]) retirer.shown(id);
    retirer.hidden("a", handlers("a")); await flush();
    expect(retired).toEqual([]);
    retirer.hidden("b", handlers("b")); await flush();
    expect(retired).toEqual(["a"]);
    retirer.hidden("c", handlers("c")); await flush();
    expect(retired).toEqual(["a", "b"]);
  });

  it("retires the kept session after two minutes hidden", async () => {
    const { retirer, retired, handlers } = setup();
    retirer.shown("a"); await flush();
    retirer.hidden("a", handlers("a")); await flush();
    vi.advanceTimersByTime(HIDDEN_PRISTINE_SESSION_GRACE_MS - 1);
    expect(retired).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(retired).toEqual(["a"]);
  });

  it("cancels a pending retirement when the chat becomes visible again", async () => {
    const { retirer, retired, handlers } = setup();
    retirer.shown("a"); await flush();
    retirer.hidden("a", handlers("a")); await flush();
    vi.advanceTimersByTime(60_000);
    retirer.shown("a"); await flush();
    vi.advanceTimersByTime(HIDDEN_PRISTINE_SESSION_GRACE_MS * 2);
    expect(retired).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("restarts the grace period when a chat hides again", async () => {
    const { retirer, retired, handlers } = setup();
    retirer.shown("a"); await flush();
    retirer.hidden("a", handlers("a")); await flush();
    vi.advanceTimersByTime(100_000);
    retirer.shown("a"); await flush();
    retirer.hidden("a", handlers("a")); await flush();
    vi.advanceTimersByTime(100_000);
    expect(retired).toEqual([]);
    vi.advanceTimersByTime(20_000);
    expect(retired).toEqual(["a"]);
  });

  it("keeps a chat visible in another surface", async () => {
    const { retirer, retired, handlers } = setup();
    retirer.shown("a"); await flush();
    retirer.shown("a"); await flush();
    retirer.hidden("a", handlers("a")); await flush();
    retirer.shown("b"); await flush();
    retirer.hidden("b", handlers("b")); await flush();
    vi.advanceTimersByTime(HIDDEN_PRISTINE_SESSION_GRACE_MS);
    expect(retired).toEqual(["b"]);
  });

  it("re-reads the session when the grace period ends", async () => {
    const { retirer, state, retired, handlers } = setup();
    retirer.shown("a"); await flush();
    retirer.hidden("a", handlers("a")); await flush();
    state.a = "busy";
    vi.advanceTimersByTime(HIDDEN_PRISTINE_SESSION_GRACE_MS);
    expect(retired).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never retires a busy session, even beyond the kept one", async () => {
    const { retirer, state, retired, handlers } = setup();
    state.a = "busy";
    retirer.shown("a"); await flush();
    retirer.hidden("a", handlers("a")); await flush();
    retirer.shown("b"); await flush();
    retirer.hidden("b", handlers("b")); await flush();
    vi.advanceTimersByTime(HIDDEN_PRISTINE_SESSION_GRACE_MS);
    expect(retired).toEqual(["b"]);
  });

  it("treats a session it cannot read as busy, without throwing from the hide", async () => {
    const { retirer, retired, handlers } = setup();
    retirer.shown("a"); await flush();
    retirer.hidden("a", { ...handlers("a"), classify: () => { throw new Error("no store"); } });
    await expect(flush()).resolves.toBeUndefined();
    retirer.shown("b"); await flush();
    retirer.hidden("b", handlers("b")); await flush();
    vi.advanceTimersByTime(HIDDEN_PRISTINE_SESSION_GRACE_MS);
    expect(retired).toEqual(["b"]);
  });

  it("keeps chats that hide and show again within one commit", async () => {
    const { retirer, retired, handlers } = setup();
    for (const id of ["a", "b"]) retirer.shown(id);
    retirer.hidden("a", handlers("a"));
    retirer.hidden("b", handlers("b"));
    retirer.shown("a");
    retirer.shown("b");
    await flush();
    vi.advanceTimersByTime(HIDDEN_PRISTINE_SESSION_GRACE_MS);
    expect(retired).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retires a dormant chat whose admission went live while it was hidden", async () => {
    const { retirer, state, retired, handlers } = setup();
    state.a = "dormant";
    retirer.shown("a"); await flush();
    retirer.hidden("a", handlers("a")); await flush();
    retirer.shown("b"); await flush();
    retirer.hidden("b", handlers("b")); await flush();
    expect(retired).toEqual([]);
    state.a = "live";
    retirer.shown("c"); await flush();
    retirer.hidden("c", handlers("c")); await flush();
    expect(retired).toEqual(["b", "a"]);
  });
});
