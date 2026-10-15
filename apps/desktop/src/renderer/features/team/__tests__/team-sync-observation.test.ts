import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  effect: null as null | (() => void | (() => void)),
  native: true,
  development: false,
  connected: true,
  auth: { status: "authenticated", userId: "account-a" },
  bridge: { id: "local-bridge" },
  selected: "org-a" as string | null,
  generation: 0,
  listeners: new Set<() => void>(),
  me: vi.fn(),
  settings: vi.fn(),
  courier: vi.fn(),
  accept: vi.fn(),
  repair: vi.fn(),
}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useEffect: (effect: () => void | (() => void)) => {
    state.effect = effect;
  },
}));
vi.mock("../../../platform/runtime", () => ({
  isNativeRuntime: () => state.native,
  isLocalDevelopment: () => state.development,
}));
vi.mock("../../auth", () => ({ useAuth: () => state.auth }));
vi.mock("../../../platform/bridge/use-bridge", () => ({
  useBridge: () => state.bridge,
  useBridgeStatus: () => (state.connected ? "connected" : "disconnected"),
}));
vi.mock("../../../platform/bridge/workspace-bridge", () => ({
  bridgeTeamSetContext: state.courier,
}));
vi.mock("../control-plane", () => ({
  CONTROL_PLANE_URL: "https://control.example.test",
  controlPlane: { me: state.me, getOrganizationSettings: state.settings },
}));
vi.mock("../active-team", () => ({
  getActiveTeamId: () => state.selected,
  subscribeActiveTeam: (listener: () => void) => {
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  },
}));
vi.mock("../team-store", () => ({
  getOrganizationStoreGeneration: () => state.generation,
  acceptOrganizationSnapshot: state.accept,
}));
vi.mock("../organization-membership-history", () => ({
  reconcilePersonalWorkspaceOwnership: async () => {},
  reconcileOrganizationWorkspaceOwnership: state.repair,
}));
vi.mock("../personal-organization", () => ({
  desktopOrganizationChoices: (me: { organizations: unknown[] }) =>
    me.organizations,
}));

import { requestTeamResync, useTeamEngineSync } from "../team-sync";

const INTERVAL = 15 * 60_000;
const snapshot = (account = state.auth.userId) => ({
  user: { id: account },
  organizations: [
    { id: "personal", isPersonal: true },
    { id: "org-a", isPersonal: false },
    { id: "org-b", isPersonal: false },
  ],
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let hidden = false,
  windowEvents: EventTarget,
  documentEvents: EventTarget;
let dispose: (() => void) | undefined;
function SyncConsumer() {
  useTeamEngineSync();
  return null;
}
function mount() {
  SyncConsumer();
  dispose = state.effect?.() || undefined;
}
async function flush() {
  await vi.advanceTimersByTimeAsync(0);
}
async function visibility(value: boolean) {
  hidden = value;
  documentEvents.dispatchEvent(new Event("visibilitychange"));
  await flush();
}
function select(id: string | null) {
  state.selected = id;
  for (const listener of [...state.listeners]) listener();
}
const writes = () => state.courier.mock.calls.map((call) => call[1]);
const settingsWrites = () => writes().filter((value) => value.teamId !== null);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  hidden = false;
  state.native = true;
  state.development = false;
  state.connected = true;
  state.auth = { status: "authenticated", userId: "account-a" };
  state.selected = "org-a";
  state.generation = 0;
  state.listeners.clear();
  state.me.mockReset().mockImplementation(async () => snapshot());
  state.settings
    .mockReset()
    .mockImplementation(async (id: string) => ({
      doc: { owner: id, revision: "current" },
    }));
  state.courier.mockReset().mockResolvedValue(undefined);
  state.accept.mockReset().mockReturnValue(true);
  state.repair.mockReset().mockResolvedValue(undefined);
  windowEvents = new EventTarget();
  documentEvents = new EventTarget();
  vi.stubGlobal("window", windowEvents);
  Object.defineProperty(documentEvents, "visibilityState", {
    get: () => (hidden ? "hidden" : "visible"),
  });
  vi.stubGlobal("document", documentEvents);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("organization engine sync observation", () => {
  it("clears unknown local context while initially hidden without starting CP reads or a timer", async () => {
    hidden = true;
    mount();
    await flush();
    expect(writes()).toContainEqual({ teamId: null, doc: null });
    expect(state.me).not.toHaveBeenCalled();
    expect(state.settings).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    windowEvents.dispatchEvent(new Event("focus"));
    requestTeamResync();
    await vi.advanceTimersByTimeAsync(4 * INTERVAL);
    expect(state.me).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await visibility(false);
    expect(state.me).toHaveBeenCalledOnce();
    expect(settingsWrites()).toHaveLength(1);
  });

  it("removes the hidden fallback and coalesces reveal with focus while retaining same-owner context", async () => {
    mount();
    await flush();
    expect(state.me).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(state.me).toHaveBeenCalledTimes(2);
    const confirmed = writes().length;
    await visibility(true);
    await vi.advanceTimersByTimeAsync(4 * INTERVAL);
    windowEvents.dispatchEvent(new Event("focus"));
    await flush();
    expect(state.me).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    expect(writes()).toHaveLength(confirmed);
    await visibility(false);
    windowEvents.dispatchEvent(new Event("focus"));
    await flush();
    expect(state.me).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("does not publish a held account read or drain an invalidation into hidden work", async () => {
    const held = deferred<ReturnType<typeof snapshot>>();
    state.me.mockReturnValueOnce(held.promise);
    mount();
    await flush();
    expect(state.me).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await visibility(true);
    requestTeamResync();
    held.resolve(snapshot());
    await flush();
    expect(state.accept).not.toHaveBeenCalled();
    expect(state.repair).not.toHaveBeenCalled();
    expect(state.settings).not.toHaveBeenCalled();
    expect(state.me).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await visibility(false);
    expect(state.me).toHaveBeenCalledTimes(2);
    expect(state.accept).toHaveBeenCalledOnce();
  });

  it("catches up on a quick reveal when the read observed hiding before its event", async () => {
    const held = deferred<ReturnType<typeof snapshot>>();
    state.me.mockReturnValueOnce(held.promise);
    mount();
    await flush();
    hidden = true;
    held.resolve(snapshot());
    await flush();
    expect(state.accept).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    documentEvents.dispatchEvent(new Event("visibilitychange"));
    await visibility(false);
    expect(state.me).toHaveBeenCalledTimes(2);
    expect(settingsWrites()).toHaveLength(1);
  });

  it("latches a held settings read across hidden owner A-B-A and catches up once", async () => {
    const held = deferred<{ doc: { revision: string } }>();
    state.settings.mockReturnValueOnce(held.promise);
    mount();
    await flush();
    expect(state.settings).toHaveBeenCalledOnce();
    const beforeSwitch = writes().length;
    await visibility(true);
    select("org-b");
    await flush();
    select("org-a");
    await flush();
    expect(writes().length).toBeGreaterThan(beforeSwitch);
    expect(settingsWrites()).toEqual([]);
    held.resolve({ doc: { revision: "retired-A" } });
    await flush();
    expect(settingsWrites()).toEqual([]);
    expect(state.me).toHaveBeenCalledOnce();
    await visibility(false);
    expect(state.me).toHaveBeenCalledTimes(2);
    expect(settingsWrites()).toEqual([
      { teamId: "org-a", doc: { owner: "org-a", revision: "current" } },
    ]);
  });

  it("rejects a retired A response after a visible A-B-A switch too", async () => {
    const held = deferred<{ doc: { revision: string } }>();
    state.settings.mockReturnValueOnce(held.promise);
    mount();
    await flush();
    select("org-b");
    await flush();
    select("org-a");
    await flush();
    held.resolve({ doc: { revision: "retired-A" } });
    await flush();
    expect(state.me).toHaveBeenCalledTimes(2);
    expect(settingsWrites()).toEqual([
      { teamId: "org-a", doc: { owner: "org-a", revision: "current" } },
    ]);
  });

  it("does not continue from a held ownership repair into a hidden settings read", async () => {
    const held = deferred<void>();
    state.repair.mockReturnValueOnce(held.promise);
    mount();
    await flush();
    expect(state.accept).toHaveBeenCalledOnce();
    await visibility(true);
    held.resolve();
    await flush();
    expect(state.settings).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await visibility(false);
    expect(state.me).toHaveBeenCalledTimes(2);
    expect(settingsWrites()).toHaveLength(1);
  });

  it("does not continue from a held initial clear into a hidden account read", async () => {
    const held = deferred<void>();
    state.courier.mockReturnValueOnce(held.promise);
    mount();
    await flush();
    await visibility(true);
    held.resolve();
    await flush();
    expect(state.me).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await visibility(false);
    expect(state.me).toHaveBeenCalledOnce();
  });

  it("uses its own normalized Personal selection without an extra account request", async () => {
    state.accept.mockImplementationOnce(() => {
      select("personal");
      return true;
    });
    mount();
    await flush();
    expect(state.me).toHaveBeenCalledOnce();
    expect(state.settings).not.toHaveBeenCalled();
    expect(writes().at(-1)).toEqual({ teamId: null, doc: null });
    expect(vi.getTimerCount()).toBe(1);
  });

  it("does not let a late B clear acknowledgement erase the confirmed A bookkeeping", async () => {
    const retiredSettings = deferred<{ doc: { revision: string } }>();
    state.settings.mockReturnValueOnce(retiredSettings.promise);
    mount();
    await flush();
    const heldClear = deferred<void>();
    state.courier.mockReturnValueOnce(heldClear.promise);
    select("org-b");
    await flush();
    select("org-a");
    await flush();
    retiredSettings.resolve({ doc: { revision: "retired-A" } });
    await flush();
    expect(settingsWrites()).toEqual([
      { teamId: "org-a", doc: { owner: "org-a", revision: "current" } },
    ]);
    const confirmed = writes();
    heldClear.resolve();
    await flush();
    state.me.mockRejectedValueOnce(new Error("synthetic unavailable"));
    requestTeamResync();
    await flush();
    expect(writes()).toEqual(confirmed);
  });

  it("clears the same semantic owner immediately when the account generation changes while hidden", async () => {
    mount();
    await flush();
    expect(settingsWrites()).toHaveLength(1);
    await visibility(true);
    state.generation++;
    requestTeamResync();
    await flush();
    expect(writes().at(-1)).toEqual({ teamId: null, doc: null });
    expect(state.me).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await visibility(false);
    expect(state.me).toHaveBeenCalledTimes(2);
  });

  it("keeps hidden sign-out clearing active and rejects a settings reply from the disposed account", async () => {
    const held = deferred<{ doc: { revision: string } }>();
    state.settings.mockReturnValueOnce(held.promise);
    mount();
    await flush();
    await visibility(true);
    dispose?.();
    state.auth = { status: "unauthenticated", userId: "" };
    state.generation++;
    mount();
    await flush();
    expect(writes().at(-1)).toEqual({ teamId: null, doc: null });
    held.resolve({ doc: { revision: "signed-out" } });
    await flush();
    expect(settingsWrites()).toEqual([]);
    expect(state.me).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds focus refreshes and coalesces explicit mutations during a held read", async () => {
    mount();
    await flush();
    windowEvents.dispatchEvent(new Event("focus"));
    await flush();
    expect(state.me).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    const held = deferred<ReturnType<typeof snapshot>>();
    state.me.mockReturnValueOnce(held.promise);
    windowEvents.dispatchEvent(new Event("focus"));
    await flush();
    requestTeamResync();
    requestTeamResync();
    await flush();
    expect(state.me).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    held.resolve(snapshot());
    await flush();
    expect(state.me).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("retains confirmed same-owner settings through an ordinary CP error", async () => {
    mount();
    await flush();
    const confirmed = writes();
    state.me.mockRejectedValueOnce(new Error("synthetic unavailable"));
    requestTeamResync();
    await flush();
    expect(writes()).toEqual(confirmed);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(state.me).toHaveBeenCalledTimes(3);
  });

  it("keeps Personal device-local and does not start an organization settings read", async () => {
    state.selected = "personal";
    mount();
    await flush();
    expect(state.me).toHaveBeenCalledOnce();
    expect(state.settings).not.toHaveBeenCalled();
    expect(settingsWrites()).toEqual([]);
    await visibility(true);
    await vi.advanceTimersByTimeAsync(2 * INTERVAL);
    expect(state.me).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["nonnative", "disconnected", "local-development"] as const)(
    "does not poll in %s mode",
    async (mode) => {
      state.native = mode !== "nonnative";
      state.connected = mode !== "disconnected";
      state.development = mode === "local-development";
      mount();
      await flush();
      await vi.advanceTimersByTimeAsync(2 * INTERVAL);
      expect(state.me).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      if (mode === "local-development")
        expect(writes()).toEqual([{ teamId: null, doc: null }]);
      else expect(writes()).toEqual([]);
    },
  );

  it("retires visibility, focus and invalidation listeners with the effect", async () => {
    mount();
    await flush();
    dispose?.();
    dispose = undefined;
    await visibility(true);
    await visibility(false);
    windowEvents.dispatchEvent(new Event("focus"));
    select("org-b");
    requestTeamResync();
    await vi.advanceTimersByTimeAsync(2 * INTERVAL);
    expect(state.me).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
