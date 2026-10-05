import fs from "node:fs";
import vm from "node:vm";
import { transformSync } from "esbuild";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  local: true,
  handle: vi.fn(),
  on: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: mocks.handle,
    on: mocks.on,
    removeHandler: vi.fn(),
    removeAllListeners: vi.fn(),
  },
  app: { getVersion: () => "0.1.0" },
}));
vi.mock("../runtime-mode", () => ({
  IS_DEV: true,
  get IS_LOCAL_DEVELOPMENT() {
    return mocks.local;
  },
}));
vi.mock("../client-upgrade-signal", () => ({ signalClientUpgrade: vi.fn() }));

beforeEach(() => {
  vi.resetModules();
  mocks.local = true;
  mocks.handle.mockClear();
  mocks.on.mockClear();
  mocks.fetch.mockReset();
  vi.stubGlobal("fetch", mocks.fetch);
});
afterEach(() => vi.unstubAllGlobals());

describe("main-owned Local IPC", () => {
  it("ignores renderer process arguments and uses the main snapshot", () => {
    const source = transformSync(
      fs.readFileSync("apps/desktop/electron/preload.ts", "utf8"),
      { loader: "ts", format: "cjs" },
    ).code;
    const exposed: Record<string, unknown> = {};
    const sendSync = vi.fn(() => false);
    vm.runInNewContext(source, {
      require: (name: string) =>
        name === "electron"
          ? {
              ipcRenderer: { on: vi.fn(), sendSync },
              contextBridge: {
                exposeInMainWorld: (key: string, value: unknown) => {
                  exposed[key] = value;
                },
              },
            }
          : { isAppearanceMode: () => false },
      process: { argv: ["--zeros-local-development=1"] },
      console: { log: vi.fn() },
    });
    expect(
      (exposed.__ZEROS_NATIVE__ as { localDevelopment: boolean })
        .localDevelopment,
    ).toBe(false);
    expect(sendSync).toHaveBeenCalledWith("zeros:local-development");
  });

  it("blocks account/cloud commands before their handlers run and keeps real local commands", async () => {
    const router = await import("../ipc/router");
    const account = vi.fn(),
      local = vi.fn(() => 123);
    router.setCommand("auth_start_signin", account);
    router.setCommand("cloud_workspace_runtime_open", account);
    router.setCommand("get_engine_port", local);
    router.registerIpcHandlers();
    const invoke = mocks.handle.mock.calls[0][1];
    for (const cmd of ["auth_start_signin", "cloud_workspace_runtime_open"])
      await expect(invoke({}, { cmd })).rejects.toThrow("Zeros Local");
    expect(await invoke({}, { cmd: "get_engine_port" })).toBe(123);
    expect(account).not.toHaveBeenCalled();
    const event = { returnValue: undefined };
    mocks.on.mock.calls.find(
      ([name]) => name === "zeros:local-development",
    )![1](event);
    expect(event.returnValue).toBe(true);
  });

  it("rejects hosted native fetches before any network request", async () => {
    const { controlPlaneFetch } = await import("../control-plane-fetch");
    await expect(
      controlPlaneFetch("https://backend.example.test/v1/me"),
    ).rejects.toThrow("Zeros Local");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("leaves the full Dev IPC path unchanged", async () => {
    mocks.local = false;
    const router = await import("../ipc/router");
    const signIn = vi.fn(() => "workos");
    router.setCommand("auth_start_signin", signIn);
    router.registerIpcHandlers();
    expect(
      await mocks.handle.mock.calls[0][1]({}, { cmd: "auth_start_signin" }),
    ).toBe("workos");
  });
});
