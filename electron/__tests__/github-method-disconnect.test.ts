import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clear: vi.fn(),
  detectGhCli: vi.fn(),
  disconnectApp: vi.fn(),
  get: vi.fn(),
  getSelectedMethod: vi.fn(),
  isExplicitlyDisconnected: vi.fn(),
  markExplicitlyDisconnected: vi.fn(),
  pushToEngine: vi.fn(),
  refreshApp: vi.fn(),
  setFallbackMethod: vi.fn(),
  setSelectedMethod: vi.fn(),
  verifyGithubToken: vi.fn(),
}));

vi.mock("../github-auth-runtime", () => ({
  githubCredentialStore: {
    clear: mocks.clear,
    get: mocks.get,
    getSelectedMethod: mocks.getSelectedMethod,
    isExplicitlyDisconnected: mocks.isExplicitlyDisconnected,
    markExplicitlyDisconnected: mocks.markExplicitlyDisconnected,
    setFallbackMethod: mocks.setFallbackMethod,
    setSelectedMethod: mocks.setSelectedMethod,
  },
}));

vi.mock("../github-app-flow", () => ({
  beginGithubAppConnection: vi.fn(),
  cancelGithubAppConnection: vi.fn(),
  disconnectGithubApp: mocks.disconnectApp,
  recheckGithubAppInstallations: vi.fn(),
  refreshGithubAppCredential: mocks.refreshApp,
}));

vi.mock("../sidecar", () => ({
  pushGithubCredentialToEngine: mocks.pushToEngine,
}));

vi.mock("../../src/engine/git", () => ({
  detectGhCli: mocks.detectGhCli,
  isGitError: vi.fn(() => false),
  verifyGithubToken: mocks.verifyGithubToken,
}));

vi.mock("../ipc/commands/auth-session", () => ({
  getSessionUserForMain: vi.fn(() => null),
}));

import {
  ghAuthSnapshot,
  ghCredentialClear,
  ghMethodDisconnect,
  ghMethodSelect,
} from "../ipc/commands/github";

const patCredential = {
  method: "pat",
  accessToken: "github_pat_secret",
  login: "octocat",
  gitHost: "github.com",
  gitHttpUsername: "x-access-token",
} as const;

const cliCredential = {
  ...patCredential,
  method: "gh-cli",
} as const;

describe("GitHub method disconnect commit order", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.clear.mockResolvedValue(undefined);
    mocks.disconnectApp.mockResolvedValue(true);
    mocks.get.mockResolvedValue(patCredential);
    mocks.getSelectedMethod.mockResolvedValue("pat");
    mocks.isExplicitlyDisconnected.mockReturnValue(false);
    mocks.markExplicitlyDisconnected.mockResolvedValue(undefined);
    mocks.pushToEngine.mockResolvedValue(undefined);
    mocks.setFallbackMethod.mockResolvedValue(undefined);
    mocks.setSelectedMethod.mockResolvedValue(undefined);
  });

  it("keeps a selected PAT when its fallback preference cannot be stored", async () => {
    mocks.setFallbackMethod.mockRejectedValueOnce(
      new Error("settings write failed"),
    );

    await expect(
      ghMethodDisconnect({ method: "pat" }, {} as never),
    ).rejects.toThrow("settings write failed");

    expect(mocks.clear).not.toHaveBeenCalled();
  });

  it("keeps a selected App when its fallback preference cannot be stored", async () => {
    mocks.getSelectedMethod.mockResolvedValue("github-app");
    mocks.setFallbackMethod.mockRejectedValueOnce(
      new Error("settings write failed"),
    );

    await expect(
      ghMethodDisconnect({ method: "github-app" }, {} as never),
    ).rejects.toThrow("settings write failed");

    expect(mocks.disconnectApp).not.toHaveBeenCalled();
  });

  it("restores PAT selection when deleting the credential fails", async () => {
    mocks.getSelectedMethod
      .mockResolvedValueOnce("pat")
      .mockResolvedValueOnce("gh-cli");
    mocks.clear.mockRejectedValueOnce(new Error("keychain delete failed"));

    await expect(
      ghMethodDisconnect({ method: "pat" }, {} as never),
    ).rejects.toThrow("keychain delete failed");

    expect(mocks.setFallbackMethod).toHaveBeenCalledWith("gh-cli");
    expect(mocks.setSelectedMethod).toHaveBeenCalledWith("pat");
  });

  it("does not overwrite a concurrent explicit gh CLI selection when PAT deletion fails", async () => {
    let selectedMethod = "pat";
    let rejectDelete!: (error: Error) => void;
    let markDeleteStarted!: () => void;
    const deleteStarted = new Promise<void>((resolve) => {
      markDeleteStarted = resolve;
    });
    mocks.getSelectedMethod.mockImplementation(async () => selectedMethod);
    mocks.setFallbackMethod.mockImplementation(async (method: string) => {
      selectedMethod = method;
    });
    mocks.setSelectedMethod.mockImplementation(async (method: string) => {
      selectedMethod = method;
    });
    mocks.get.mockImplementation(async (method: string) =>
      method === "gh-cli"
        ? cliCredential
        : method === "pat"
          ? patCredential
          : null,
    );
    mocks.detectGhCli.mockResolvedValue({
      available: true,
      authenticated: true,
      configured: true,
      health: "connected",
      login: "octocat",
    });
    mocks.verifyGithubToken.mockResolvedValue({ login: "octocat" });
    mocks.refreshApp.mockResolvedValue(null);
    mocks.clear.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectDelete = reject;
          markDeleteStarted();
        }),
    );

    const disconnect = ghMethodDisconnect(
      { method: "pat" },
      {} as never,
    );
    await deleteStarted;
    await ghMethodSelect({ method: "gh-cli" }, {} as never);
    rejectDelete(new Error("keychain delete failed"));

    await expect(disconnect).rejects.toThrow("keychain delete failed");
    expect(selectedMethod).toBe("gh-cli");
    expect(mocks.setSelectedMethod).not.toHaveBeenCalledWith("pat");
  });
});

describe("engine-originated GitHub credential rejection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.detectGhCli.mockResolvedValue({
      available: true,
      authenticated: false,
      configured: false,
      health: "not-connected",
    });
    mocks.get.mockImplementation(async (method: string) =>
      method === "pat" ? patCredential : null,
    );
    mocks.getSelectedMethod.mockResolvedValue("pat");
    mocks.pushToEngine.mockResolvedValue(undefined);
    mocks.refreshApp.mockResolvedValue(null);
    mocks.verifyGithubToken.mockRejectedValue(
      new Error("GitHub rejected this credential"),
    );
  });

  it("preserves a rejected PAT and re-seeds it only after a later successful probe", async () => {
    await expect(
      ghCredentialClear(
        { method: "pat", reason: "credential-invalid" },
        {} as never,
      ),
    ).resolves.toBeNull();

    expect(mocks.clear).not.toHaveBeenCalled();
    expect(mocks.pushToEngine).not.toHaveBeenCalled();

    mocks.verifyGithubToken.mockResolvedValue({ login: "octocat" });
    await ghAuthSnapshot({}, {} as never);

    expect(mocks.pushToEngine).toHaveBeenCalledTimes(1);
  });
});
