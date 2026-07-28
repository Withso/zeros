import { beforeEach, describe, expect, it, vi } from "vitest";

// `zeros://open?path=…` is an UNTRUSTED entry point — any web page can fire one
// with a single click — so these cases pin both halves of its contract: the
// guards that decide whether the engine re-roots at all, and the fact that a
// refusal is now reported to the renderer instead of dying in a console.error.

const emitEvent = vi.fn<(name: string, payload: unknown) => void>();
const spawnEngine = vi.fn<(p: string) => Promise<number>>(async () => 4242);
const assertIsDirectory = vi.fn<(p: string) => void>();
const isSystemDir = vi.fn<(p: string) => boolean>(() => false);
const isPlausibleProject = vi.fn<(p: string) => boolean>(() => true);

vi.mock("electron", () => ({ app: { on: vi.fn(), setAsDefaultProtocolClient: vi.fn() } }));
vi.mock("../ipc/events", () => ({
  emitEvent: (name: string, payload: unknown) => emitEvent(name, payload),
}));
vi.mock("../sidecar", () => ({
  assertIsDirectory: (p: string) => assertIsDirectory(p),
  isSystemDir: (p: string) => isSystemDir(p),
  isPlausibleProject: (p: string) => isPlausibleProject(p),
  spawnEngine: (p: string) => spawnEngine(p),
}));
vi.mock("../../src/engine/runtime", () => ({
  channel: () => "stable",
  schemeForChannel: () => "zeros",
}));

const { handleUrl } = await import("../deep-link");

const emitted = (name: string) =>
  emitEvent.mock.calls.filter((c) => c[0] === name).map((c) => c[1]);

beforeEach(() => {
  vi.clearAllMocks();
  isSystemDir.mockReturnValue(false);
  isPlausibleProject.mockReturnValue(true);
});

describe("zeros://open", () => {
  it("re-roots the engine and announces the root for a real project", async () => {
    await handleUrl("zeros://open?path=/Users/me/proj");
    expect(spawnEngine).toHaveBeenCalledWith("/Users/me/proj");
    expect(emitted("project-changed")).toEqual([
      { root: "/Users/me/proj", port: 4242 },
    ]);
    expect(emitted("project-open-failed")).toEqual([]);
  });

  it("reports a link with no path instead of failing silently", async () => {
    await handleUrl("zeros://open");
    expect(spawnEngine).not.toHaveBeenCalled();
    expect(emitted("project-open-failed")).toEqual([
      { root: null, reason: expect.stringContaining("folder") },
    ]);
  });

  it("refuses a system directory and says why", async () => {
    // A web page can fire zeros://open?path=/ with one click; re-rooting there
    // would widen the remotely-reachable file/PTY surface.
    isSystemDir.mockReturnValue(true);
    await handleUrl("zeros://open?path=/");
    expect(spawnEngine).not.toHaveBeenCalled();
    const [failure] = emitted("project-open-failed") as {
      root: string;
      reason: string;
    }[];
    expect(failure.root).toBe("/");
    expect(failure.reason).toContain("system directory");
  });

  it("refuses a folder that isn't a project and says why", async () => {
    isPlausibleProject.mockReturnValue(false);
    await handleUrl("zeros://open?path=/Users/me/Downloads");
    expect(spawnEngine).not.toHaveBeenCalled();
    expect(
      (emitted("project-open-failed") as { reason: string }[])[0].reason,
    ).toContain("not a project folder");
  });

  it("reports a failed engine respawn", async () => {
    spawnEngine.mockRejectedValueOnce(new Error("port in use"));
    await handleUrl("zeros://open?path=/Users/me/proj");
    expect(emitted("project-changed")).toEqual([]);
    expect(
      (emitted("project-open-failed") as { reason: string }[])[0].reason,
    ).toBe("port in use");
  });

  it("still forwards unknown actions as deep-link", async () => {
    // The team-invite handler is the sole `deep-link` subscriber — routing
    // open-failures away from that channel must not strand invites.
    await handleUrl("zeros://invite?code=abc");
    expect(emitted("deep-link")).toEqual(["zeros://invite?code=abc"]);
    expect(emitted("project-open-failed")).toEqual([]);
  });
});
