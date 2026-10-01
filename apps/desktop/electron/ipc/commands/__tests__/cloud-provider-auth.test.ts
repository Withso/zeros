import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { cloudProviderAuthStatusSchema } from "@zeros/protocol/provider-auth";
import type { createSubscriptionDriver } from "../../../provider-subscription-drivers";
import { cloudWorkspaceDesktopCapabilityEnabled } from "../../../../src/engine/cloud-workspace-capability";

const deps = vi.hoisted(() => ({
  session: vi.fn(),
  sessionChanged: (() => {}) as () => unknown,
  baseUrl: vi.fn(),
  fetch: vi.fn(),
  driver: vi.fn(),
  login: vi.fn(),
  cursorLogin: vi.fn(),
  runtime: vi.fn(),
  mkdir: vi.fn(),
  mkdtemp: vi.fn(),
  open: vi.fn(),
  stat: vi.fn(),
  readFile: vi.fn(),
  close: vi.fn(),
  rm: vi.fn(),
}));
vi.mock("electron", () => ({
  app: { getPath: () => "/fixture/native" },
  shell: { openExternal: vi.fn() },
}));
vi.mock("node:fs/promises", () => ({
  mkdir: deps.mkdir,
  mkdtemp: deps.mkdtemp,
  open: deps.open,
  rm: deps.rm,
}));
vi.mock("../../../workos-desktop-account", () => ({ controlPlaneBaseUrl: deps.baseUrl }));
vi.mock("../../../control-plane-fetch", () => ({ controlPlaneFetch: deps.fetch }));
vi.mock("../../../provider-subscription-drivers", () => ({ createSubscriptionDriver: deps.driver }));
vi.mock("../auth-session", () => ({
  getValidSessionForMain: deps.session,
  onMainAuthSessionChanged: (listener: () => unknown) => { deps.sessionChanged = listener; },
}));
vi.mock("../cursor-subscription", () => ({ loginCursorSubscription: deps.cursorLogin }));
vi.mock("../provider-subscription", () => ({ resolveRuntime: deps.runtime }));
import { cloudProviderAuth, stopCloudProviderAuth } from "../cloud-provider-auth";

const session = { sub: "fixture-member", accountId: "fixture-account", sessionId: "fixture-session", accessToken: "fixture-workos-access" };
const directory = "/fixture/native/cloud-provider-auth/codex-fixture";
const nativeCache = { tokens: { access_token: "fixture-native-access", refresh_token: "fixture-native-refresh" } };
let cacheBytes: Buffer;
let nextWindowId = 0;

function event(windowId = ++nextWindowId) {
  return { sender: { id: windowId, once: vi.fn() } } as unknown as IpcMainInvokeEvent;
}
function connection(provider: "codex" | "cursor" = "codex") {
  return { action: "connect", attemptId: randomUUID(), organizationId: randomUUID(), provider, displayName: "Fixture account" };
}
const invoke = async (args: Record<string, unknown>, sender: IpcMainInvokeEvent) => cloudProviderAuth(args, sender);
async function finish(request: ReturnType<typeof connection>, sender: IpcMainInvokeEvent, state: string) {
  return vi.waitFor(async () => {
    const status = cloudProviderAuthStatusSchema.parse(await invoke({ action: "status", attemptId: request.attemptId }, sender));
    expect(status.state).toBe(state);
    return status;
  });
}
function pendingLogin() {
  let complete!: () => void;
  deps.login.mockImplementation(({ signal }: { signal: AbortSignal }) => new Promise((resolve, reject) => {
    complete = () => resolve({ state: "connected" });
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  return () => complete();
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("__ZEROS_CLOUD_WORKSPACES_ENABLED_BAKED__", false);
  vi.stubEnv("ZEROS_CLOUD_WORKSPACES_ENABLED", "false");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  deps.session.mockResolvedValue(session);
  deps.baseUrl.mockReturnValue("https://beta.example.test");
  deps.mkdir.mockResolvedValue(undefined);
  deps.mkdtemp.mockResolvedValue(directory);
  deps.runtime.mockResolvedValue({ command: "fixture-codex", argsPrefix: [] });
  deps.login.mockResolvedValue({ state: "connected" });
  deps.driver.mockImplementation((_provider: string, options: Parameters<typeof createSubscriptionDriver>[1]) => ({
    login: async (input: unknown) => { await options.resolveRuntime(); return deps.login(input); },
  }));
  deps.cursorLogin.mockResolvedValue({ apiKey: "fixture-cursor-access", apiKeyExpiresAtMs: Date.now() + 60_000 });
  cacheBytes = Buffer.from(JSON.stringify(nativeCache));
  deps.stat.mockResolvedValue({ isFile: () => true, size: cacheBytes.length });
  deps.readFile.mockResolvedValue(cacheBytes);
  deps.close.mockResolvedValue(undefined);
  deps.open.mockResolvedValue({ stat: deps.stat, readFile: deps.readFile, close: deps.close });
  deps.rm.mockResolvedValue(undefined);
  deps.fetch.mockImplementation(async (url: string, input: RequestInit) => {
    const body = JSON.parse(String(input.body)) as { displayName: string };
    return Response.json({ credential: {
      id: new URL(url).pathname.split("/")[3],
      kind: url.endsWith("/native-codex") ? "codex-chatgpt" : "cursor-api-key",
      displayName: body.displayName, revision: 1, revoked: false,
    } });
  });
});
afterEach(async () => {
  await stopCloudProviderAuth();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("cloud account enrollment IPC without workspace execution", () => {
  it.each(["beta", "production"])("imports native Codex through the authenticated %s backend with cloud disabled", async (channel) => {
    deps.baseUrl.mockReturnValue(`https://${channel}.example.test`);
    const request = connection(), sender = event();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    expect(cloudWorkspaceDesktopCapabilityEnabled()).toBe(false);
    await invoke(request, sender);
    const status = await finish(request, sender, "connected");
    expect(deps.fetch).toHaveBeenCalledTimes(1);
    const [url, input] = deps.fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://${channel}.example.test/v1/cloud-agent-credentials/${request.attemptId}/native-codex`);
    expect(input).toMatchObject({ method: "PUT", redirect: "error", headers: {
      authorization: `Bearer ${session.accessToken}`, "content-type": "application/json", "Idempotency-Key": request.attemptId,
    } });
    expect(input.signal).toBeInstanceOf(AbortSignal);
    expect(timeout).toHaveBeenCalledWith(20_000);
    expect(JSON.parse(String(input.body))).toEqual({ organizationId: request.organizationId, operationId: request.attemptId,
      expectedRevision: 0, displayName: request.displayName, nativeCache });
    expect(deps.open).toHaveBeenCalledWith(`${directory}/auth.json`, constants.O_RDONLY | constants.O_NOFOLLOW);
    expect(deps.runtime).toHaveBeenCalledWith("codex", directory, true);
    expect(cacheBytes.every(byte => byte === 0)).toBe(true);
    expect(deps.close).toHaveBeenCalledTimes(1);
    expect(deps.rm).toHaveBeenCalledWith(directory, { recursive: true, force: true });
    expect(status.credential).toMatchObject({ id: request.attemptId, kind: "codex-chatgpt", revision: 1 });
    expect(JSON.stringify(status)).not.toMatch(/fixture-native|fixture-workos|nativeCache|refresh_token/);
    expect(cloudWorkspaceDesktopCapabilityEnabled()).toBe(false);
  });

  it("enrolls Cursor without creating a Codex native profile", async () => {
    const request = connection("cursor"), sender = event();
    await invoke(request, sender);
    const status = await finish(request, sender, "connected");
    expect(status.credential?.kind).toBe("cursor-api-key");
    expect(deps.cursorLogin).toHaveBeenCalledTimes(1);
    expect(deps.fetch).toHaveBeenCalledWith(`https://beta.example.test/v1/cloud-agent-credentials/${request.attemptId}`, expect.objectContaining({ method: "PUT" }));
    expect(deps.mkdir).not.toHaveBeenCalled();
    expect(deps.driver).not.toHaveBeenCalled();
    expect(JSON.stringify(status)).not.toContain("fixture-cursor-access");
  });

  it.each(["url", "executable", "nativeCache", "ownerUserId"])("rejects renderer %s injection before authentication or provider access", (key) => {
    expect(() => cloudProviderAuth({ ...connection(), [key]: "untrusted" }, event())).toThrow("Invalid cloud account connection request.");
    expect(deps.session).not.toHaveBeenCalled();
    expect(deps.login).not.toHaveBeenCalled();
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it("requires a current main session before native login", async () => {
    deps.session.mockResolvedValue(null);
    await expect(invoke(connection(), event())).rejects.toThrow("Sign in to connect a cloud agent account.");
    expect(deps.mkdir).not.toHaveBeenCalled();
    expect(deps.login).not.toHaveBeenCalled();
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it("deduplicates attempts and refuses a different window or changed request", async () => {
    const complete = pendingLogin(), request = connection(), sender = event();
    await invoke(request, sender);
    await vi.waitFor(() => expect(deps.login).toHaveBeenCalledTimes(1));
    await invoke(request, sender);
    await expect(invoke({ action: "status", attemptId: request.attemptId }, event())).rejects.toThrow("Cloud sign-in is no longer available.");
    await expect(invoke({ ...request, displayName: "Changed" }, sender)).rejects.toThrow("Cloud sign-in request changed.");
    complete();
    await finish(request, sender, "connected");
    expect(deps.login).toHaveBeenCalledTimes(1);
    expect(deps.fetch).toHaveBeenCalledTimes(1);
  });

  it("cannot upload after the main account changes during native login", async () => {
    const complete = pendingLogin(), request = connection(), sender = event();
    await invoke(request, sender);
    await vi.waitFor(() => expect(deps.login).toHaveBeenCalledTimes(1));
    deps.session.mockResolvedValue({ ...session, accountId: "other-account" });
    await expect(invoke({ action: "status", attemptId: request.attemptId }, sender)).rejects.toThrow("Cloud sign-in is no longer available.");
    complete();
    await vi.waitFor(() => expect(console.warn).toHaveBeenCalledWith("[cloud-provider-auth] connection failed", { provider: "codex", phase: "account-check" }));
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.rm).toHaveBeenCalledWith(directory, { recursive: true, force: true });
  });

  it.each(["cancel", "window", "session"])("cleans the isolated native ceremony on %s retirement without an upload", async (retirement) => {
    pendingLogin();
    const request = connection(), sender = event();
    await invoke(request, sender);
    await vi.waitFor(() => expect(deps.login).toHaveBeenCalledTimes(1));
    if (retirement === "cancel") {
      expect(await invoke({ action: "cancel", attemptId: request.attemptId }, sender)).toMatchObject({ state: "canceled" });
    } else if (retirement === "window") {
      expect(sender.sender.once).toHaveBeenCalledWith("destroyed", expect.any(Function));
      const retire = vi.mocked(sender.sender.once).mock.calls[0][1] as () => void;
      retire();
      await stopCloudProviderAuth();
    } else await deps.sessionChanged();
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.rm).toHaveBeenCalledWith(directory, { recursive: true, force: true });
  });

  it.each(["nonfile", "oversized"])("rejects a %s native cache and still closes/removes its profile", async (invalid) => {
    deps.stat.mockResolvedValue({ isFile: () => invalid !== "nonfile", size: invalid === "oversized" ? 64 * 1024 + 1 : 128 });
    const request = connection(), sender = event();
    await invoke(request, sender);
    await finish(request, sender, "failed");
    expect(deps.readFile).not.toHaveBeenCalled();
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.close).toHaveBeenCalledTimes(1);
    expect(deps.rm).toHaveBeenCalledWith(directory, { recursive: true, force: true });
  });

  it("bounds the authenticated import response and exposes only a fixed failure", async () => {
    deps.fetch.mockResolvedValue(new Response("x".repeat(8193)));
    const request = connection(), sender = event();
    await invoke(request, sender);
    const status = await finish(request, sender, "failed");
    expect(status.error).toBe("You signed in, but Zeros could not save this cloud connection. Try again.");
    expect(status.credential).toBeUndefined();
    expect(JSON.stringify(status)).not.toMatch(/fixture-native|fixture-workos|nativeCache|refresh_token/);
  });
});
