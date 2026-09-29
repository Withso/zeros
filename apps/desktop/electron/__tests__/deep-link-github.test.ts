import { beforeEach, describe, expect, it, vi } from "vitest";

const completeGithubAppConnection = vi.fn(async () => undefined);
const relayGithubAppCallback = vi.fn(() => false);
const whenRendererReady = vi.fn(async () => undefined);
const { currentChannel, openExternal, registerClient } = vi.hoisted(() => ({
  currentChannel: vi.fn(() => "dev"),
  openExternal: vi.fn(async () => undefined),
  registerClient: vi.fn<(scheme: string, path?: string, args?: string[]) => boolean>(() => true),
}));

vi.mock("electron", () => ({
  app: {
    setAsDefaultProtocolClient: registerClient,
    requestSingleInstanceLock: vi.fn(() => true),
    on: vi.fn(),
    whenReady: vi.fn(() => Promise.resolve()),
    quit: vi.fn(),
  },
  shell: { openExternal },
}));
vi.mock("../sidecar", () => ({
  assertIsDirectory: vi.fn(),
  isPlausibleProject: vi.fn(),
  isSystemDir: vi.fn(),
  spawnEngine: vi.fn(),
}));
vi.mock("../ipc/events", () => ({ emitEvent: vi.fn(), whenRendererReady }));
vi.mock("../../src/engine/runtime", () => ({
  channel: currentChannel,
  schemeForChannel: (channel: string) => `zeros-${channel}`,
}));
vi.mock("../github-app-flow", () => ({ completeGithubAppConnection, relayGithubAppCallback }));

const deepLink = await import("../deep-link");
const { handleUrl } = deepLink;

describe("Dev browser callback ownership", () => {
  beforeEach(() => {
    currentChannel.mockReturnValue("dev");
    openExternal.mockClear();
    registerClient.mockClear();
  });

  it("reclaims the Dev handler before opening OAuth when an older checkout took it", async () => {
    const order: string[] = [];
    registerClient.mockImplementationOnce(() => { order.push("register"); return true; });
    openExternal.mockImplementationOnce(async () => { order.push("browser"); });
    await deepLink.openDesktopAuthBrowser("https://github.com/login/oauth/authorize");
    expect(order).toEqual(["register", "browser"]);
    expect(registerClient.mock.calls[0]?.[0]).toBe("zeros-dev");
  });

  it.each(["alpha", "beta", "stable"])("preserves %s protocol ownership", async channel => {
    currentChannel.mockReturnValue(channel);
    await deepLink.openDesktopAuthBrowser("https://auth.example.test/authorize");
    expect(registerClient).not.toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledExactlyOnceWith("https://auth.example.test/authorize");
  });
});

describe("zeros:// GitHub App callback", () => {
  beforeEach(() => {
    currentChannel.mockReturnValue("dev");
    completeGithubAppConnection.mockClear();
    relayGithubAppCallback.mockReset().mockReturnValue(false);
    whenRendererReady.mockClear();
  });

  it("relays to the initiating Dev process without waiting for this window's renderer", async () => {
    relayGithubAppCallback.mockReturnValue(true);
    await handleUrl("zeros-dev://github/connected#nonce=abcdefghijklmnopqrstuvwxyzABCDEFG_123456");
    expect(relayGithubAppCallback).toHaveBeenCalledOnce();
    expect(whenRendererReady).not.toHaveBeenCalled();
    expect(completeGithubAppConnection).not.toHaveBeenCalled();
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
