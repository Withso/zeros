import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  createSubscriptionDriver,
  subscriptionEnvironment,
  subscriptionBrowserUrl,
} from "../provider-subscription-drivers";
import type { StdioAgentProcess } from "../../src/engine/agents/adapters/shared/stdio-process";

function processFixture() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  let exit!: (value: { code: number | null; signal: null }) => void;
  const proc: StdioAgentProcess = {
    child: child as unknown as ChildProcess,
    processGroupId: null,
    exited: new Promise((resolve) => {
      exit = resolve;
    }),
    stop: vi.fn(async () => {
      exit({ code: null, signal: null });
      child.emit("close");
    }),
  };
  return { child, proc, exit };
}

describe("provider browser authorization boundary", () => {
  it.each([false, true])(
    "binds Codex usage to the same app-server account (changed=%s)",
    async (changed) => {
      const server = processFixture();
      let accountReads = 0;
      server.child.stdin.on("data", (chunk) => {
        const request = JSON.parse(chunk.toString());
        if (!request.id) return;
        if (request.method === "account/read") accountReads++;
        const result =
          request.method === "account/read"
            ? {
                account: {
                  type: "chatgpt",
                  email:
                    changed && accountReads === 2
                      ? "b@example.test"
                      : "a@example.test",
                  planType: "pro",
                },
              }
            : request.method === "account/rateLimits/read"
              ? {
                  rateLimits: {
                    primary: { windowDurationMins: 10080, usedPercent: 25 },
                  },
                }
              : {};
        queueMicrotask(() =>
          server.child.stdout.write(
            JSON.stringify({ id: request.id, result }) + "\n",
          ),
        );
      });
      const driver = createSubscriptionDriver("codex", {
        resolveRuntime: async () => ({
          command: "/bundled/codex",
          cwd: "/auth",
          env: {},
          cleanup: async () => {},
        }),
        spawn: () => server.proc,
        openBrowser: vi.fn(),
      });
      const work = driver.readUsage(AbortSignal.timeout(1000));
      if (changed) await expect(work).rejects.toThrow("account changed");
      else
        await expect(work).resolves.toMatchObject({
          identity: JSON.stringify(["a@example.test", null]),
          windows: [{ id: "weekly", usedPercent: 25 }],
        });
      expect(server.proc.stop).toHaveBeenCalledOnce();
      expect(accountReads).toBe(2);
    },
  );
  it("cancels the Codex browser ceremony before stopping its process", async () => {
    const server = processFixture();
    const methods: string[] = [];
    const abort = new AbortController();
    server.child.stdin.on("data", (chunk) => {
      const request = JSON.parse(chunk.toString());
      methods.push(request.method);
      if (request.id)
        queueMicrotask(() =>
          server.child.stdout.write(
            JSON.stringify({
              id: request.id,
              result:
                request.method === "account/login/start"
                  ? {
                      type: "chatgpt",
                      loginId: "pending",
                      authUrl:
                        "https://auth.openai.com/oauth/authorize?state=sample",
                    }
                  : {},
            }) + "\n",
          ),
        );
    });
    const opened = vi.fn().mockResolvedValue(undefined);
    const stop = server.proc.stop;
    server.proc.stop = vi.fn(async () => {
      expect(methods).toContain("account/login/cancel");
      await stop();
    });
    const driver = createSubscriptionDriver("codex", {
      resolveRuntime: async () => ({
        command: "/bundled/codex",
        cwd: "/owned/auth",
        env: {},
        cleanup: async () => {},
      }),
      spawn: () => server.proc,
      openBrowser: opened,
    });
    const result = driver
      .login({ signal: abort.signal, onCodeRequired: vi.fn() })
      .catch(() => undefined);
    await vi.waitFor(() => expect(opened).toHaveBeenCalledOnce());
    abort.abort();
    await result;
    expect(methods).toContain("account/login/cancel");
    expect(methods).not.toContain("account/read");
  });

  it("supports the bundled Claude authorization host while rejecting unrelated browser destinations", () => {
    expect(
      subscriptionBrowserUrl(
        "claude",
        "https://claude.com/cai/oauth/authorize?state=sample",
      ),
    ).toContain("claude.com");
    expect(
      subscriptionBrowserUrl(
        "codex",
        "https://auth.openai.com/oauth/authorize?state=sample",
      ),
    ).toContain("auth.openai.com");
    for (const url of [
      "http://claude.com/cai/oauth/authorize",
      "https://evil.claude.com/cai/oauth/authorize",
      "https://claude.com@evil.test/cai/oauth/authorize",
      "https://claude.com:8443/cai/oauth/authorize",
      "https://claude.com/docs",
      "https://claude.com/cai/oauth/authorize#fragment",
    ]) {
      expect(() => subscriptionBrowserUrl("claude", url)).toThrow();
    }
  });

  it("keeps native config roots and proxy settings but excludes API keys and executable injection", () => {
    const source = {
      HOME: "/user",
      PATH: "/bin",
      CLAUDE_CONFIG_DIR: "/profile",
      CODEX_HOME: "/codex-profile",
      HTTPS_PROXY: "https://proxy.example.test",
      ANTHROPIC_API_KEY: "private",
      CLAUDE_CODE_OAUTH_TOKEN: "private",
      OPENAI_API_KEY: "private",
      NODE_OPTIONS: "--require=untrusted",
      ZEROS_ENGINE_TOKEN: "private",
    };
    const env = subscriptionEnvironment(source);
    expect(env).toMatchObject({
      HOME: "/user",
      CLAUDE_CONFIG_DIR: "/profile",
      CODEX_HOME: "/codex-profile",
      HTTPS_PROXY: source.HTTPS_PROXY,
    });
    expect(JSON.stringify(env)).not.toContain("private");
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.BROWSER).toBe("/usr/bin/true");
    expect(source.ANTHROPIC_API_KEY).toBe("private");
  });

  it("uses Claude auth login, handles split authorization output, and verifies the saved account", async () => {
    const login = processFixture();
    const status = processFixture();
    const spawn = vi
      .fn()
      .mockReturnValueOnce(login.proc)
      .mockReturnValueOnce(status.proc);
    const openBrowser = vi.fn().mockResolvedValue(undefined);
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const driver = createSubscriptionDriver("claude", {
      resolveRuntime: async () => ({
        command: "/bundled/claude",
        cwd: "/owned/auth",
        env: {},
        cleanup,
      }),
      spawn,
      openBrowser,
    });
    const onCodeRequired = vi.fn();
    const run = driver.login({
      signal: new AbortController().signal,
      onCodeRequired,
    });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    expect(spawn.mock.calls[0][0].args).toEqual([
      "auth",
      "login",
      "--claudeai",
    ]);
    login.child.stdout.write("Opening https://claude.com/cai/oauth/author");
    expect(openBrowser).not.toHaveBeenCalled();
    login.child.stdout.write(
      "ize?state=sample&code_challenge=sample\nPaste the code here if prompted > ",
    );
    await vi.waitFor(() => expect(openBrowser).toHaveBeenCalledOnce());
    expect(onCodeRequired).toHaveBeenCalledOnce();
    onCodeRequired.mock.calls[0][0]("sample-code#sample-state");
    expect(login.child.stdin.read()?.toString()).toBe(
      "sample-code#sample-state\n",
    );
    login.exit({ code: 0, signal: null });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
    status.child.stdout.write(
      JSON.stringify({
        loggedIn: true,
        authMethod: "claude.ai",
        email: "user@example.test",
        subscriptionType: "max",
        accessToken: "private",
      }),
    );
    status.exit({ code: 0, signal: null });
    expect(await run).toEqual({
      state: "connected",
      email: "user@example.test",
      plan: "max",
    });
    expect(login.proc.stop).toHaveBeenCalled();
    expect(status.proc.stop).toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("uses Codex account RPCs without creating a thread and correlates early completion", async () => {
    const server = processFixture();
    const methods: string[] = [];
    const requests: Record<string, unknown>[] = [];
    server.child.stdin.on("data", (chunk) => {
      for (const line of chunk.toString().trim().split("\n")) {
        const request = JSON.parse(line);
        methods.push(request.method);
        requests.push(request);
        if (!request.id) continue;
        let result: unknown = {};
        if (request.method === "account/login/start") {
          // The notification may arrive in the same stdout batch as the response.
          server.child.stdout.write(
            JSON.stringify({
              method: "account/login/completed",
              params: {
                loginId: "different",
                success: false,
                error: "private",
              },
            }) + "\n",
          );
          server.child.stdout.write(
            JSON.stringify({
              method: "account/login/completed",
              params: { loginId: "matching", success: true, error: null },
            }) + "\n",
          );
          result = {
            type: "chatgpt",
            loginId: "matching",
            authUrl: "https://auth.openai.com/oauth/authorize?state=sample",
          };
        }
        if (request.method === "account/read")
          result = {
            account: {
              type: "chatgpt",
              email: "user@example.test",
              planType: "plus",
            },
            requiresOpenaiAuth: true,
          };
        queueMicrotask(() =>
          server.child.stdout.write(
            JSON.stringify({ id: request.id, result }) + "\n",
          ),
        );
      }
    });
    const openBrowser = vi.fn().mockResolvedValue(undefined);
    const driver = createSubscriptionDriver("codex", {
      resolveRuntime: async () => ({
        command: "/bundled/codex",
        cwd: "/owned/auth",
        env: {},
        cleanup: async () => {},
      }),
      spawn: () => server.proc,
      openBrowser,
    });
    const result = await driver.login({
      signal: new AbortController().signal,
      onCodeRequired: vi.fn(),
    });
    expect(result).toEqual({
      state: "connected",
      email: "user@example.test",
      plan: "plus",
    });
    expect(methods).toEqual([
      "initialize",
      "initialized",
      "account/login/start",
      "account/read",
    ]);
    expect(
      requests.find((request) => request.method === "account/login/start")
        ?.params,
    ).toEqual({ type: "chatgpt", useHostedLoginSuccessPage: true });
    expect(server.proc.stop).toHaveBeenCalled();
  });
});
