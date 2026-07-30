import { beforeEach, describe, expect, it, vi } from "vitest";

const completeGithubAppConnection = vi.fn(async () => undefined);
const whenRendererReady = vi.fn(async () => undefined);

vi.mock("electron", () => ({
  app: {
    setAsDefaultProtocolClient: vi.fn(),
    requestSingleInstanceLock: vi.fn(() => true),
    on: vi.fn(),
    whenReady: vi.fn(() => Promise.resolve()),
    quit: vi.fn(),
  },
}));
vi.mock("../sidecar", () => ({
  assertIsDirectory: vi.fn(),
  isPlausibleProject: vi.fn(),
  isSystemDir: vi.fn(),
  spawnEngine: vi.fn(),
}));
vi.mock("../ipc/events", () => ({ emitEvent: vi.fn(), whenRendererReady }));
vi.mock("../../src/engine/runtime", () => ({
  channel: () => "dev",
  schemeForChannel: () => "zeros-dev",
}));
vi.mock("../github-app-flow", () => ({ completeGithubAppConnection }));

const { handleUrl } = await import("../deep-link");

describe("zeros:// GitHub App callback", () => {
  beforeEach(() => {
    completeGithubAppConnection.mockClear();
    whenRendererReady.mockClear();
  });

  // On a cold launch main.ts creates the window inside the same whenReady turn,
  // so the connected/error events are no longer covered by the pre-window
  // buffer. Completion must wait for the renderer or they are sent into a
  // document that cannot receive them.
  it("waits for the renderer before completing, so its events are deliverable", async () => {
    const order: string[] = [];
    whenRendererReady.mockImplementationOnce(async () => {
      order.push("renderer-ready");
    });
    completeGithubAppConnection.mockImplementationOnce(async () => {
      order.push("complete");
      return undefined;
    });

    await handleUrl(
      "zeros-dev://github/connected#nonce=abcdefghijklmnopqrstuvwxyzABCDEFG_123456",
    );

    expect(order).toEqual(["renderer-ready", "complete"]);
  });

  it("passes only parsed nonce/error fields to main-owned completion", async () => {
    await handleUrl(
      "zeros-dev://github/connected#nonce=abcdefghijklmnopqrstuvwxyzABCDEFG_123456&error=access_denied",
    );

    expect(completeGithubAppConnection).toHaveBeenCalledWith({
      nonce: "abcdefghijklmnopqrstuvwxyzABCDEFG_123456",
      error: "access_denied",
    });
  });

  it("accepts the query fallback and never forwards unknown GitHub routes", async () => {
    await handleUrl(
      "zeros-dev://github/connected?nonce=abcdefghijklmnopqrstuvwxyzABCDEFG_123456",
    );
    await handleUrl(
      "zeros-dev://github/not-connected?nonce=abcdefghijklmnopqrstuvwxyzABCDEFG_123456",
    );

    expect(completeGithubAppConnection).toHaveBeenCalledTimes(1);
    expect(completeGithubAppConnection).toHaveBeenCalledWith({
      nonce: "abcdefghijklmnopqrstuvwxyzABCDEFG_123456",
      error: null,
    });
  });
});
