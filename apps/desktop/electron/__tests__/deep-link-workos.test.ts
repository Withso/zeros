import { beforeEach, describe, expect, it, vi } from "vitest";

const emitEvent = vi.fn();
const acceptWorkOSDesktopCallback = vi.fn(() => true);
const whenReady = vi.fn(async (): Promise<void> => undefined);

vi.mock("electron", () => ({
  app: {
    on: vi.fn(),
    setAsDefaultProtocolClient: vi.fn(),
    whenReady,
  },
}));
vi.mock("../sidecar", () => ({
  assertIsDirectory: vi.fn(),
  isPlausibleProject: vi.fn(),
  isSystemDir: vi.fn(),
  spawnEngine: vi.fn(),
}));
vi.mock("../ipc/events", () => ({ emitEvent }));
vi.mock("../../src/engine/runtime", () => ({
  channel: () => "alpha",
  schemeForChannel: () => "zeros-alpha",
}));
vi.mock("../ipc/commands/workos-auth", () => ({
  acceptWorkOSDesktopCallback,
}));

const { handleUrl } = await import("../deep-link");

describe("zeros-alpha:// WorkOS desktop callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    acceptWorkOSDesktopCallback.mockReturnValue(true);
  });

  it("passes only the PKCE-bound code and state into Electron main", async () => {
    await handleUrl(
      `zeros-alpha://auth/callback#code=authorization-code&state=zeros-alpha.${"s".repeat(43)}`,
    );

    expect(acceptWorkOSDesktopCallback).toHaveBeenCalledWith({
      code: "authorization-code",
      state: `zeros-alpha.${"s".repeat(43)}`,
      error: null,
    });
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it("waits for safeStorage readiness when macOS cold-launches the callback recipient", async () => {
    let ready!: () => void;
    whenReady.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          ready = resolve;
        }),
    );
    const handling = handleUrl(
      `zeros-alpha://auth/callback#code=authorization-code&state=zeros-alpha.${"s".repeat(43)}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(whenReady).toHaveBeenCalledOnce();
    expect(acceptWorkOSDesktopCallback).not.toHaveBeenCalled();
    ready();
    await handling;
    expect(acceptWorkOSDesktopCallback).toHaveBeenCalledOnce();
  });

  it("maps provider details to one fixed error without forwarding descriptions", async () => {
    await handleUrl(
      `zeros-alpha://auth/callback#error=provider_error&error_description=private-detail&state=zeros-alpha.${"s".repeat(43)}`,
    );

    expect(acceptWorkOSDesktopCallback).toHaveBeenCalledWith({
      code: null,
      state: `zeros-alpha.${"s".repeat(43)}`,
      error: "provider_error",
    });
  });

  it("rejects invented deep-link error values", async () => {
    await handleUrl(
      `zeros-alpha://auth/callback#error=invented_error&state=zeros-alpha.${"s".repeat(43)}`,
    );

    expect(acceptWorkOSDesktopCallback).not.toHaveBeenCalled();
  });

  it("preserves the opaque Auth0 ticket handoff for mixed-version rollback", async () => {
    await handleUrl(
      "zeros-alpha://auth/callback#ticket=opaque-ticket&nonce=opaque-nonce",
    );

    expect(acceptWorkOSDesktopCallback).not.toHaveBeenCalled();
    expect(emitEvent).toHaveBeenCalledWith("auth-handoff", {
      ticket: "opaque-ticket",
      nonce: "opaque-nonce",
    });
  });
});
