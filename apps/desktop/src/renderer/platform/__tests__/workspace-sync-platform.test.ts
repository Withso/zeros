import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ reply: undefined as unknown, listener: undefined as undefined | ((payload: unknown) => void) }));
vi.mock("../runtime", async original => ({ ...await original<typeof import("../runtime")>(), isElectron: () => true,
  nativeInvoke: async () => state.reply,
  nativeListen: async (_event: string, listener: (payload: unknown) => void) => { state.listener = listener; return () => {}; } }));
import { resetWorkspaceSyncForTests, startWorkspaceSyncStatus, workspaceSyncStatusFor } from "../workspace-sync";

const ws = "11111111-1111-4111-8111-111111111111";
const status = { workspaceId: ws, state: "in_sync" as const, files: 0, problems: 0 };
beforeEach(() => { state.reply = undefined; state.listener = undefined; resetWorkspaceSyncForTests(); });

describe("this Mac's sync statuses in the renderer", () => {
  // Escaped to CI: a main process that answers nothing made the details popup throw on `null.find`.
  it("treats a missing or malformed reply and event as no statuses", async () => {
    state.reply = null;
    const stop = startWorkspaceSyncStatus();
    await vi.waitFor(() => expect(state.listener).toBeDefined());
    await Promise.resolve(); await Promise.resolve();
    expect(workspaceSyncStatusFor(ws)).toBeNull();
    state.listener!(undefined);
    expect(workspaceSyncStatusFor(ws)).toBeNull();
    state.listener!({ not: "a list" });
    expect(workspaceSyncStatusFor(ws)).toBeNull();
    state.listener!([status]);
    expect(workspaceSyncStatusFor(ws)).toEqual(status);
    expect(workspaceSyncStatusFor(null)).toBeNull();
    stop();
  });
});

it("says plainly that sync stopped because this person no longer has access", async () => {
  const { workspaceSyncLabel } = await import("../workspace-sync");
  expect(workspaceSyncLabel({ workspaceId: "11111111-1111-4111-8111-111111111111", state: "error", reason: "access_revoked", problems: 0 })).toBe("Stopped: you no longer have access");
});
