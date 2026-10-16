import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  bundleIdFromInfoPlist,
  createCuaDriverHost,
  cuaDriverBinaryPath,
  cuaDriverResult,
  type CuaSdk,
  type CuaToolResult,
  type CuaTrustedSession,
  type CuaWorker,
} from "../computer-use/driver";
import { ComputerDriverLostError } from "../computer-use/ports";

class FakeDriverError extends Error {
  constructor(
    readonly tag: string,
    readonly inner: Record<string, unknown> = {},
  ) {
    super(`DriverError.${tag}`);
  }
}

const ok = (overrides: Partial<CuaToolResult> = {}): CuaToolResult => ({
  text: "Done.",
  images: [],
  isError: false,
  ...overrides,
});

class FakeSession implements CuaTrustedSession {
  closed = false;
  readonly calls: Array<{ name: string; args: unknown; signal?: AbortSignal }> =
    [];
  next: Array<() => Promise<CuaToolResult>> = [];
  constructor(
    readonly worker: FakeWorker,
    readonly label: string,
  ) {}
  async callTool(
    name: string,
    argumentsJson: string,
    options?: { signal: AbortSignal },
  ): Promise<CuaToolResult> {
    if (this.closed || this.worker.dead) throw new FakeDriverError("Shutdown");
    this.calls.push({
      name,
      args: JSON.parse(argumentsJson),
      signal: options?.signal,
    });
    const step = this.next.shift();
    return step ? step() : ok();
  }
  close() {
    this.closed = true;
  }
}

class FakeWorker implements CuaWorker {
  dead = false;
  shutdowns = 0;
  readonly sessions: FakeSession[] = [];
  async metadata() {
    if (this.dead) throw new FakeDriverError("Shutdown");
    return { pid: 4242 };
  }
  async shutdown() {
    this.shutdowns += 1;
    if (this.dead) throw new FakeDriverError("Shutdown");
    this.dead = true;
  }
}

function fakeSdk() {
  const workers: FakeWorker[] = [];
  const options: unknown[] = [];
  const sessionOptions: unknown[] = [];
  let startFailure: Error | null = null;
  const sdk: CuaSdk = {
    CuaDriver: {
      createPrivateWorker(value) {
        options.push(value);
        if (startFailure) throw startFailure;
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
    },
    createTrustedSession(driver, value) {
      sessionOptions.push(value);
      const worker = driver as FakeWorker;
      if (worker.dead) throw new FakeDriverError("Shutdown");
      const session = new FakeSession(worker, value.publicSession);
      worker.sessions.push(session);
      return session;
    },
    SessionPermissionMode: { Standard: 0 as never },
    DriverError: {
      instanceOf: (value: unknown) => value instanceof FakeDriverError,
    },
    requestMacOsPermissions: () => ({
      accessibility: false,
      screenRecording: false,
    }),
  };
  return {
    sdk,
    workers,
    options,
    sessionOptions,
    failStart(error: Error | null) {
      startFailure = error;
    },
  };
}

function setup(
  overrides: Partial<Parameters<typeof createCuaDriverHost>[0]> = {},
) {
  const fake = fakeSdk();
  const loadSdk = vi.fn(async () => fake.sdk);
  const log = vi.fn();
  let clock = 1_000_000;
  const host = createCuaDriverHost({
    loadSdk,
    binaryPath: () => "/Applications/Zeros.app/Contents/Resources/cua-driver",
    hostBundleId: "com.zeros",
    home: "/Users/me/Library/Application Support/Zeros/computer-use",
    restartBackoffMs: [0, 1_000, 5_000],
    now: () => clock,
    log,
    ...overrides,
  });
  return {
    ...fake,
    host,
    loadSdk,
    log,
    advance(ms: number) {
      clock += ms;
    },
  };
}

const signal = () => new AbortController().signal;

describe("computer-use driver host", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts one private Standard-only worker on first use, with telemetry off and a private HOME", async () => {
    const { host, options, workers, sessionOptions, loadSdk } = setup();
    expect(loadSdk).not.toHaveBeenCalled();
    const first = await host.openSession("Codex", signal());
    const second = await host.openSession("Claude Code", signal());
    expect(loadSdk).toHaveBeenCalledTimes(1);
    expect(workers).toHaveLength(1);
    expect(options).toEqual([
      {
        binaryPath: "/Applications/Zeros.app/Contents/Resources/cua-driver",
        hostBundleId: "com.zeros",
        startupTimeoutMs: 15_000n,
        shutdownTimeoutMs: 3_000n,
        configuredDriver: {
          claudeCodeCompatibility: false,
          authorization: {
            allowedModes: [0],
            compatibilityMode: 0,
            unrestrictedAcknowledged: false,
            maxSessionTtlSeconds: 3_600n,
            maxIdleTtlSeconds: 900n,
          },
        },
        environment: [
          { name: "CUA_DRIVER_RS_TELEMETRY_ENABLED", value: "0" },
          { name: "CUA_TELEMETRY_ENABLED", value: "false" },
          {
            name: "HOME",
            value: "/Users/me/Library/Application Support/Zeros/computer-use",
          },
        ],
        inheritStderr: false,
      },
    ]);
    expect(sessionOptions).toEqual([
      {
        publicSession: "Codex",
        mode: 0,
        ttlSeconds: 3_600n,
        idleTtlSeconds: 900n,
      },
      {
        publicSession: "Claude Code",
        mode: 0,
        ttlSeconds: 3_600n,
        idleTtlSeconds: 900n,
      },
    ]);
    first.close();
    second.close();
    expect(workers[0]!.sessions.every((session) => session.closed)).toBe(true);
  });

  it("sends tool arguments as JSON with the caller's signal and converts the result", async () => {
    const { host, workers } = setup();
    const session = await host.openSession("Codex", signal());
    const fakeSession = workers[0]!.sessions[0]!;
    fakeSession.next.push(async () =>
      ok({
        text: "2 apps",
        structuredJson: '{"apps":[{"name":"Safari"}]}',
        images: [{ mimeType: "image/png", dataBase64: "iVBORw0KGgo=" }],
      }),
    );
    const controller = new AbortController();
    const result = await session.call(
      "list_apps",
      { pid: 7, query: "Sign in" },
      controller.signal,
    );
    expect(fakeSession.calls).toEqual([
      {
        name: "list_apps",
        args: { pid: 7, query: "Sign in" },
        signal: controller.signal,
      },
    ]);
    expect(result).toEqual({
      isError: false,
      errorCode: null,
      text: "2 apps",
      structured: { apps: [{ name: "Safari" }] },
      images: [{ data: "iVBORw0KGgo=", mimeType: "image/png" }],
    });
  });

  it("returns driver refusals as failed results", async () => {
    const { host, workers } = setup();
    const session = await host.openSession("Codex", signal());
    const fakeSession = workers[0]!.sessions[0]!;
    fakeSession.next.push(async () =>
      ok({ isError: true, errorCode: "window_id_not_found", text: "No window." }),
    );
    fakeSession.next.push(async () => {
      throw new FakeDriverError("Tool", {
        tool: "click",
        message: "Element token is stale.",
        errorCode: "stale_element_token",
      });
    });
    fakeSession.next.push(async () => {
      throw new FakeDriverError("InvalidArguments", {
        tool: "click",
        reason: "x is out of range",
      });
    });
    expect(await session.call("click", {}, signal())).toMatchObject({
      isError: true,
      errorCode: "window_id_not_found",
      text: "No window.",
    });
    expect(await session.call("click", {}, signal())).toMatchObject({
      isError: true,
      errorCode: "stale_element_token",
      text: "Element token is stale.",
    });
    expect(await session.call("click", {}, signal())).toMatchObject({
      isError: true,
      errorCode: "invalid_arguments",
      text: "x is out of range",
    });
    expect(workers).toHaveLength(1);
  });

  it("reports a worker whose channel broke as lost and restarts it after the backoff", async () => {
    const { host, workers, advance } = setup();
    const session = await host.openSession("Codex", signal());
    workers[0]!.dead = true;
    await expect(session.call("list_apps", {}, signal())).rejects.toBeInstanceOf(
      ComputerDriverLostError,
    );
    // The first restart is immediate.
    const replacement = await host.openSession("Codex", signal());
    expect(workers).toHaveLength(2);
    workers[1]!.dead = true;
    await expect(
      replacement.call("list_apps", {}, signal()),
    ).rejects.toBeInstanceOf(ComputerDriverLostError);
    // The second waits a second.
    let opened = false;
    const pending = host.openSession("Codex", signal()).then((value) => {
      opened = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(opened).toBe(false);
    advance(1_000);
    await vi.advanceTimersByTimeAsync(1);
    const third = await pending;
    expect(workers).toHaveLength(3);
    // A call that works resets the backoff.
    expect((await third.call("list_apps", {}, signal())).isError).toBe(false);
    workers[2]!.dead = true;
    await expect(third.call("list_apps", {}, signal())).rejects.toBeInstanceOf(
      ComputerDriverLostError,
    );
    await host.openSession("Codex", signal());
    expect(workers).toHaveLength(4);
  });

  it("tells an interrupted action from a lost worker", async () => {
    const { host, workers } = setup();
    const session = await host.openSession("Codex", signal());
    const fakeSession = workers[0]!.sessions[0]!;
    fakeSession.next.push(async () => {
      throw new FakeDriverError("ActionInterrupted", {
        completion: 2,
        reason: "The window closed during the click.",
      });
    });
    expect(await session.call("click", {}, signal())).toMatchObject({
      isError: true,
      errorCode: "action_interrupted",
      text: "The window closed during the click.",
    });
    fakeSession.next.push(async () => {
      workers[0]!.dead = true;
      throw new FakeDriverError("ActionInterrupted", {
        completion: 0,
        reason: "private worker exited before the request was written",
      });
    });
    await expect(session.call("click", {}, signal())).rejects.toBeInstanceOf(
      ComputerDriverLostError,
    );
  });

  it("replaces a worker that died while idle before handing out a session", async () => {
    const { host, workers } = setup();
    (await host.openSession("Codex", signal())).close();
    workers[0]!.dead = true;
    const session = await host.openSession("Codex", signal());
    expect(workers).toHaveLength(2);
    expect((await session.call("list_apps", {}, signal())).isError).toBe(false);
  });

  it("asks for a new session instead of calling a closed or replaced one", async () => {
    const { host, workers } = setup();
    const session = await host.openSession("Codex", signal());
    session.close();
    session.close();
    expect(await session.call("list_apps", {}, signal())).toMatchObject({
      isError: true,
      errorCode: "session_unavailable",
    });
    expect(workers[0]!.sessions[0]!.calls).toEqual([]);
  });

  it("stops the worker and its sessions, and starts again on next use", async () => {
    const { host, workers } = setup();
    const session = await host.openSession("Codex", signal());
    await host.stop();
    await host.stop();
    expect(workers[0]!.shutdowns).toBe(1);
    expect(workers[0]!.sessions[0]!.closed).toBe(true);
    expect(await session.call("list_apps", {}, signal())).toMatchObject({
      errorCode: "session_unavailable",
    });
    await host.openSession("Codex", signal());
    expect(workers).toHaveLength(2);
  });

  it("refuses without starting anything when the executable or SDK is missing", async () => {
    const missingBinary = setup({ binaryPath: () => null });
    await expect(
      missingBinary.host.openSession("Codex", signal()),
    ).rejects.toThrow(/unavailable in this copy of Zeros/);
    expect(missingBinary.options).toEqual([]);
    expect(missingBinary.log).toHaveBeenCalledWith(
      expect.stringContaining("pnpm stage:cua-driver"),
    );

    const missingSdk = setup({
      loadSdk: async () => {
        throw new Error("dlopen failed");
      },
    });
    await expect(missingSdk.host.openSession("Codex", signal())).rejects.toThrow(
      /unavailable in this copy of Zeros/,
    );
    expect(missingSdk.log).toHaveBeenCalledWith(
      expect.stringContaining("dlopen failed"),
    );
  });

  it("backs off after a worker that fails to start", async () => {
    const { host, failStart, workers } = setup();
    failStart(new FakeDriverError("Worker", { reason: "spawn failed" }));
    await expect(host.openSession("Codex", signal())).rejects.toBeInstanceOf(
      ComputerDriverLostError,
    );
    failStart(null);
    let opened = false;
    void host.openSession("Codex", signal()).then(() => {
      opened = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    // backoff[0] is immediate.
    expect(opened).toBe(true);
    expect(workers).toHaveLength(1);
  });

  it("gives up waiting for a restart when the caller cancels", async () => {
    const { host, workers } = setup();
    for (let index = 0; index < 2; index += 1) {
      const session = await host.openSession("Codex", signal());
      workers[index]!.dead = true;
      await expect(
        session.call("list_apps", {}, signal()),
      ).rejects.toBeInstanceOf(ComputerDriverLostError);
    }
    const controller = new AbortController();
    const pending = host.openSession("Codex", controller.signal);
    controller.abort(new Error("Stopped."));
    await expect(pending).rejects.toThrow("Stopped.");
    expect(workers).toHaveLength(2);
  });
});

describe("cuaDriverResult", () => {
  it("keeps only well-formed parts of a result", () => {
    expect(
      cuaDriverResult({
        text: "Done.",
        isError: false,
        structuredJson: "[1,2]",
        images: [
          { mimeType: "image/png", dataBase64: "AAAA" },
          { mimeType: 3, dataBase64: "BBBB" } as never,
        ],
      }),
    ).toEqual({
      isError: false,
      errorCode: null,
      text: "Done.",
      structured: null,
      images: [{ data: "AAAA", mimeType: "image/png" }],
    });
    expect(
      cuaDriverResult({
        text: "Failed",
        isError: true,
        errorCode: "",
        structuredJson: "{not json",
        images: [],
      }),
    ).toMatchObject({ isError: true, errorCode: null, structured: null });
  });
});

describe("driver location and identity", () => {
  it("reads the bundle ID from Info.plist", () => {
    expect(
      bundleIdFromInfoPlist(
        "<dict>\n\t<key>CFBundleIdentifier</key>\n\t<string>com.zeros.beta</string>\n</dict>",
      ),
    ).toBe("com.zeros.beta");
    expect(bundleIdFromInfoPlist("<dict></dict>")).toBeNull();
    expect(
      bundleIdFromInfoPlist(
        "<key>CFBundleIdentifier</key><string>bad id; rm</string>",
      ),
    ).toBeNull();
  });

  it("uses the staged executable from Resources or binaries/", () => {
    const exists = (file: string) => file.endsWith("cua-driver");
    expect(
      cuaDriverBinaryPath({
        packaged: true,
        resourcesPath: "/Applications/Zeros.app/Contents/Resources",
        repoRoot: "/repo",
        exists,
      }),
    ).toBe("/Applications/Zeros.app/Contents/Resources/cua-driver");
    expect(
      cuaDriverBinaryPath({
        packaged: false,
        resourcesPath: "/electron/Resources",
        repoRoot: "/repo",
        exists,
      }),
    ).toBe("/repo/binaries/cua-driver");
    expect(
      cuaDriverBinaryPath({
        packaged: false,
        resourcesPath: "/electron/Resources",
        repoRoot: "/repo",
        exists: () => false,
      }),
    ).toBeNull();
  });
});
