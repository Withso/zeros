import { normalizeCodexUsage, type ProviderUsageData } from "./provider-usage";
import {
  providerUsageIdentity,
  type BrowserSubscriptionProvider,
} from "@zeros/protocol/provider-auth";
import { JsonRpcStdioClient } from "../src/engine/agents/adapters/shared/jsonrpc";
import {
  spawnStdioAgent,
  type StdioAgentProcess,
} from "../src/engine/agents/adapters/shared/stdio-process";
import type { GetAccountResponse } from "../src/engine/agents/adapters/codex/generated/v2/GetAccountResponse";
import type { LoginAccountResponse } from "../src/engine/agents/adapters/codex/generated/v2/LoginAccountResponse";
import type { AccountLoginCompletedNotification } from "../src/engine/agents/adapters/codex/generated/v2/AccountLoginCompletedNotification";
import {
  SubscriptionError,
  type SubscriptionAccount,
  type SubscriptionDriver,
} from "./provider-subscription-controller";

export interface SubscriptionRuntime {
  command: string;
  argsPrefix?: string[];
  cwd: string;
  env: Record<string, string>;
  cleanup(): Promise<void>;
}
interface Dependencies {
  resolveRuntime(): Promise<SubscriptionRuntime>;
  openBrowser(url: string): Promise<void>;
  spawn?: typeof spawnStdioAgent;
}

/** Auth processes inherit config roots, locale, keychain access and network
 * settings. API keys, model-only tokens, engine secrets and preload injection
 * variables must not select a different account or execute code on login. */
export function subscriptionEnvironment(
  source: NodeJS.ProcessEnv,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (
      value !== undefined &&
      /^(?:HOME|USER|LOGNAME|SHELL|PATH|TMPDIR|TMP|TEMP|LANG|LANGUAGE|LC_\w+|TZ|XDG_(?:CONFIG|CACHE|DATA|STATE)_HOME|(?:https?|all|no)_proxy|(?:HTTPS?|ALL|NO)_PROXY|SSL_CERT_(?:FILE|DIR)|NODE_EXTRA_CA_CERTS|CLAUDE_CONFIG_DIR|CODEX_HOME|SYSTEMROOT|WINDIR)$/i.test(
        key,
      )
    )
      env[key] = value;
  }
  // The native host opens the validated URL exactly once. Claude's CLI still
  // prints its URL and accepts the documented code fallback on piped stdin.
  env.BROWSER = "/usr/bin/true";
  env.NO_COLOR = "1";
  return env;
}

export function subscriptionBrowserUrl(
  provider: BrowserSubscriptionProvider,
  raw: string,
): string {
  try {
    const url = new URL(raw);
    const allowed =
      provider === "claude"
        ? (url.origin === "https://claude.com" &&
            url.pathname === "/cai/oauth/authorize") ||
          (url.origin === "https://claude.ai" &&
            url.pathname === "/oauth/authorize")
        : url.origin === "https://auth.openai.com" &&
          url.pathname === "/oauth/authorize";
    if (!allowed || url.username || url.password || url.hash) throw new Error();
    return url.href;
  } catch {
    throw new SubscriptionError("browser");
  }
}

function metadata(value: unknown, limit: number): string | undefined {
  return typeof value === "string" &&
    value.length <= limit &&
    !/[\r\n\0]/.test(value)
    ? value
    : undefined;
}

/** Uses only native authentication commands. No thread, prompt, repository
 * trust decision, agent tool, or model invocation occurs during connection. */
export function createSubscriptionDriver(
  provider: "claude" | "codex",
  deps: Dependencies,
): SubscriptionDriver & {
  readUsage(signal: AbortSignal): Promise<ProviderUsageData>;
} {
  const spawn = deps.spawn ?? spawnStdioAgent;
  const withRuntime = async <T>(
    signal: AbortSignal,
    run: (runtime: SubscriptionRuntime) => Promise<T>,
  ): Promise<T> => {
    signal.throwIfAborted();
    const runtime = await deps.resolveRuntime();
    try {
      signal.throwIfAborted();
      return await run(runtime);
    } finally {
      await runtime.cleanup();
    }
  };
  const withProcess = async <T>(
    runtime: SubscriptionRuntime,
    args: string[],
    signal: AbortSignal,
    run: (proc: StdioAgentProcess) => Promise<T>,
  ): Promise<T> => {
    signal.throwIfAborted();
    const proc = spawn({
      command: runtime.command,
      args: [...(runtime.argsPrefix ?? []), ...args],
      cwd: runtime.cwd,
      env: runtime.env,
    });
    // EPIPE can race a browser callback or cancellation; it must never become an
    // unhandled stream error in Electron main. The owned operation reports it.
    proc.child.stdin?.on("error", () => {});
    proc.child.stderr?.resume();
    let onAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new SubscriptionError("failed"));
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([run(proc), aborted]);
    } finally {
      signal.removeEventListener("abort", onAbort);
      await proc.stop();
    }
  };
  const openBrowser = async (raw: string, signal: AbortSignal) => {
    signal.throwIfAborted();
    const url = subscriptionBrowserUrl(provider, raw);
    try {
      await deps.openBrowser(url);
    } catch {
      throw new SubscriptionError("browser");
    }
    signal.throwIfAborted();
  };

  const readClaude = (runtime: SubscriptionRuntime, signal: AbortSignal) =>
    withProcess(
      runtime,
      ["auth", "status", "--json"],
      signal,
      async (proc): Promise<SubscriptionAccount> => {
        let output = "";
        let overflow = false;
        proc.child.stdout?.on("data", (chunk: Buffer) => {
          if (output.length + chunk.length > 65_536) {
            overflow = true;
            return;
          }
          output += chunk.toString();
        });
        const result = await proc.exited;
        if (result.error || result.signal || overflow)
          throw new SubscriptionError("status");
        const status = JSON.parse(output) as Record<string, unknown>;
        if (status.loggedIn !== true || status.authMethod !== "claude.ai")
          return { state: "disconnected" };
        return {
          state: "connected",
          email: metadata(status.email, 320),
          plan: metadata(status.subscriptionType, 100),
          organization: metadata(status.orgName, 320),
        };
      },
    );

  const withCodex = <T>(
    runtime: SubscriptionRuntime,
    signal: AbortSignal,
    run: (rpc: JsonRpcStdioClient, proc: StdioAgentProcess) => Promise<T>,
  ) =>
    withProcess(runtime, ["app-server"], signal, async (proc) => {
      const rpc = new JsonRpcStdioClient(proc.child, {
        defaultTimeoutMs: 15_000,
      });
      try {
        await rpc.request("initialize", {
          clientInfo: { name: "zeros", title: "Zeros", version: "1" },
          capabilities: null,
        });
        rpc.notify("initialized", {});
        return await run(rpc, proc);
      } finally {
        rpc.close();
      }
    });
  const readCodex = async (
    rpc: JsonRpcStdioClient,
  ): Promise<SubscriptionAccount> => {
    const { account } = await rpc.request<GetAccountResponse>("account/read", {
      refreshToken: true,
    });
    if (account?.type !== "chatgpt") return { state: "disconnected" };
    return {
      state: "connected",
      email: metadata(account.email, 320),
      plan: metadata(account.planType, 100),
    };
  };

  return {
    readUsage: (signal) =>
      withRuntime(signal, (runtime) => {
        if (provider !== "codex") throw new Error("Unsupported usage reader.");
        return withCodex(runtime, signal, async (rpc) => {
          const account = await readCodex(rpc);
          if (account.state !== "connected")
            throw new Error("No subscription connected.");
          const response = await rpc.request<{ rateLimits: unknown }>(
            "account/rateLimits/read",
            undefined,
          );
          const after = await readCodex(rpc);
          const identity = providerUsageIdentity(account);
          if (
            !identity ||
            after.state !== "connected" ||
            providerUsageIdentity(after) !== identity
          )
            throw new Error("The usage account changed.");
          return { ...normalizeCodexUsage(response.rateLimits), identity };
        });
      }),
    read: (signal) =>
      withRuntime(signal, (runtime) =>
        provider === "claude"
          ? readClaude(runtime, signal)
          : withCodex(runtime, signal, readCodex),
      ),
    login: ({ signal, onCodeRequired }) =>
      withRuntime(signal, async (runtime) => {
        if (provider === "claude") {
          await withProcess(
            runtime,
            ["auth", "login", "--claudeai"],
            signal,
            async (proc) => {
              let tail = "";
              let opened: Promise<void> | undefined;
              let codeReady = false;
              let fail!: (error: unknown) => void;
              const failed = new Promise<never>((_, reject) => {
                fail = reject;
              });
              const onData = (chunk: Buffer) => {
                // Parse only complete URL tokens; stdout may split PKCE parameters
                // across chunks. Neither raw output nor authorization URLs leave main.
                tail = (tail + chunk.toString()).slice(-16_384);
                if (!opened) {
                  const match = /https:\/\/[^\s<>"']+(?=[\s<>"'])/.exec(tail);
                  if (match) {
                    opened = openBrowser(match[0], signal);
                    void opened.catch(fail);
                  }
                }
                if (
                  opened &&
                  !codeReady &&
                  /(?:paste|enter)[^\r\n]{0,100}code/i.test(tail)
                ) {
                  codeReady = true;
                  onCodeRequired((code) => {
                    signal.throwIfAborted();
                    if (!proc.child.stdin?.writable)
                      throw new SubscriptionError("failed");
                    proc.child.stdin.write(`${code}\n`);
                  });
                }
              };
              proc.child.stdout?.on("data", onData);
              proc.child.stderr?.on("data", onData);
              try {
                const result = await Promise.race([proc.exited, failed]);
                if (
                  !opened ||
                  result.code !== 0 ||
                  result.error ||
                  result.signal
                )
                  throw new SubscriptionError("failed");
                await opened;
              } finally {
                proc.child.stdout?.off("data", onData);
                proc.child.stderr?.off("data", onData);
                tail = "";
              }
            },
          );
          return readClaude(runtime, signal);
        }
        return withCodex(runtime, signal, async (rpc, proc) => {
          let loginId: string | undefined;
          let canceling: Promise<unknown> | undefined;
          const cancel = () => {
            if (loginId)
              canceling ??= rpc
                .request(
                  "account/login/cancel",
                  { loginId },
                  { timeoutMs: 1_000 },
                )
                .catch(() => {});
          };
          let settle!: (result: AccountLoginCompletedNotification) => void;
          const completed = new Promise<AccountLoginCompletedNotification>(
            (resolve) => {
              settle = resolve;
            },
          );
          const early = new Map<string, AccountLoginCompletedNotification>();
          rpc.onNotification("account/login/completed", (raw) => {
            const result = raw as AccountLoginCompletedNotification;
            if (
              typeof result?.loginId !== "string" ||
              typeof result.success !== "boolean"
            )
              return;
            if (result.loginId === loginId) settle(result);
            else if (!loginId && early.size < 8)
              early.set(result.loginId, result);
          });
          try {
            const response = await rpc.request<LoginAccountResponse>(
              "account/login/start",
              { type: "chatgpt", useHostedLoginSuccessPage: true },
            );
            if (response.type !== "chatgpt")
              throw new SubscriptionError("failed");
            loginId = response.loginId;
            signal.addEventListener("abort", cancel, { once: true });
            if (signal.aborted) cancel();
            const existing = early.get(loginId);
            early.clear();
            if (existing) settle(existing);
            await openBrowser(response.authUrl, signal);
            const result = await Promise.race([
              completed,
              proc.exited.then(() => {
                throw new SubscriptionError("failed");
              }),
            ]);
            if (!result.success) throw new SubscriptionError("failed");
            return await readCodex(rpc);
          } finally {
            // Closing the process tears down the callback server too. A best-effort
            // structured cancel retires the provider's ceremony before that close.
            signal.removeEventListener("abort", cancel);
            if (signal.aborted) cancel();
            await canceling;
            early.clear();
          }
        });
      }),
  };
}
