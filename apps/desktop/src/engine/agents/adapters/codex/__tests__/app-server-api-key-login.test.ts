// A Local Codex API-key connection must reach Codex itself. The app-server
// ignores OPENAI_API_KEY in its environment and authenticates from the saved
// login in CODEX_HOME, so a selected key was silently replaced by the device's
// ChatGPT login and its "refresh token was revoked" failure. These run the
// real bundled app-server and read the account it authenticates with; no
// request reaches OpenAI.

import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CODEX_AUTH_ENV } from "../../shared/provider-connection";
import {
  bootCodexAppServerRuntime,
  codexAppServerFeatureArgs,
  redactCodexRpcLine,
  type CodexAppServerHandle,
} from "../app-server";
import { resolveCodexBinary } from "../binary-resolver";

const binary = await resolveCodexBinary({});
const live =
  process.env.CODEX_TEST !== "0" && binary.source !== "fallback" && existsSync(binary.path);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A device ChatGPT login shaped like `codex login` writes it. */
async function homeWithChatgptLogin(): Promise<{ home: string; auth: string }> {
  const home = await mkdtemp(path.join(os.tmpdir(), "zeros-codex-api-key-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const jwt = `${part({ alg: "none" })}.${part({
    email: "device@example.com",
    exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": { chatgpt_plan_type: "plus", chatgpt_account_id: "device-account" },
  })}.signature`;
  const auth = JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: { id_token: jwt, access_token: jwt, refresh_token: "device-refresh-fixture", account_id: "device-account" },
    last_refresh: new Date().toISOString(),
  });
  await writeFile(path.join(home, "auth.json"), auth, { mode: 0o600 });
  return { home, auth };
}

async function boot(env: Record<string, string>): Promise<CodexAppServerHandle> {
  const ambient = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && !["OPENAI_API_KEY", "CODEX_API_KEY", CODEX_AUTH_ENV].includes(entry[0]),
    ),
  );
  const runtime = await bootCodexAppServerRuntime({
    cwd: process.cwd(),
    env: { ...ambient, ...env },
    clientInfo: { name: "Zeros-api-key-test", version: "0.0.1" },
    logTag: "test-api-key",
  });
  cleanups.push(() => runtime.dispose());
  return runtime;
}

async function account(runtime: CodexAppServerHandle) {
  const response = await runtime.requestTyped<"account/read", { account: { type: string } | null }>(
    "account/read",
    { refreshToken: false },
  );
  return response.account;
}

describe.skipIf(!live)("Codex API-key connection (live app-server)", () => {
  it("authenticates the selected key instead of the device ChatGPT login", async () => {
    const { home, auth } = await homeWithChatgptLogin();
    const runtime = await boot({
      CODEX_HOME: home,
      OPENAI_API_KEY: "sk-zeros-fixture-not-a-real-key",
      [CODEX_AUTH_ENV]: "api-key",
    });

    expect(await account(runtime)).toEqual({ type: "apiKey" });
    // The key stays in this process; the device login is neither read nor replaced.
    expect(await readFile(path.join(home, "auth.json"), "utf8")).toBe(auth);
  }, 30_000);

  it("authenticates a key added to a device with no Codex login", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "zeros-codex-api-key-"));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const runtime = await boot({
      CODEX_HOME: home,
      OPENAI_API_KEY: "sk-zeros-fixture-not-a-real-key",
      [CODEX_AUTH_ENV]: "api-key",
    });

    expect(await account(runtime)).toEqual({ type: "apiKey" });
    expect(await readdir(home)).not.toContain("auth.json");
  }, 30_000);

  it("never falls back to the device login when the selected key is missing", async () => {
    const { home, auth } = await homeWithChatgptLogin();
    const runtime = await boot({ CODEX_HOME: home, OPENAI_API_KEY: "", [CODEX_AUTH_ENV]: "api-key" });

    expect(await account(runtime)).toBeNull();
    expect(await readFile(path.join(home, "auth.json"), "utf8")).toBe(auth);
  }, 30_000);
});

describe("Codex API-key connection arguments", () => {
  it("keeps an API-key connection in memory, including in contained sessions", () => {
    for (const contained of [false, true]) {
      const args = codexAppServerFeatureArgs(contained, true);
      expect(args.filter((arg) => arg.startsWith("cli_auth_credentials_store="))).toEqual([
        'cli_auth_credentials_store="ephemeral"',
      ]);
      expect(args.includes('mcp_oauth_credentials_store="file"')).toBe(contained);
    }
  });

  it("redacts credentials from traced JSON-RPC lines", () => {
    const login = redactCodexRpcLine(JSON.stringify({
      id: 1, method: "account/login/start", params: { type: "apiKey", apiKey: "sk-zeros-fixture-secret" },
    }));
    const refresh = redactCodexRpcLine(JSON.stringify({
      id: 2, result: { accessToken: "zeros-fixture-access-token", chatgptAccountId: "account" },
    }));
    expect(login).not.toContain("sk-zeros-fixture-secret");
    expect(login).toContain("account/login/start");
    expect(refresh).not.toContain("zeros-fixture-access-token");
  });
});
