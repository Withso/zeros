import { createVerify, generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CREDENTIAL_HELPER,
  TOKEN_ENV,
  agentIdentity,
  agentSession,
  ghInvocation,
  gitInvocation,
  readAgentApp,
} from "../agent-github.mjs";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const TOKEN = "ghs_fixtureInstallationToken0000000000";
const APP = { appId: "5138839", slug: "zeros-agent", installationId: 166599058, botUserId: 336198133, privateKey: PEM };
const SESSION = { ...APP, token: TOKEN, expiresAt: "2026-09-30T13:00:00Z" };

const directories: string[] = [];
function temporaryHome() {
  const home = mkdtempSync(path.join(tmpdir(), "agent-github-"));
  directories.push(home);
  return home;
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

type Call = { url: string; method: string; authorization: string; body?: string };
function fakeGitHub(overrides: Record<string, { status: number; body: unknown }> = {}) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit & { headers: Record<string, string> }) => {
    const method = init.method ?? "GET";
    calls.push({ url, method, authorization: init.headers.authorization, body: init.body as string | undefined });
    const pathname = new URL(url).pathname;
    const answer = overrides[`${method} ${pathname}`] ??
      {
        "GET /repos/Withso/zeros/installation": { status: 200, body: { id: 166599058 } },
        "POST /app/installations/166599058/access_tokens": {
          status: 201,
          body: { token: TOKEN, expires_at: "2026-09-30T13:00:00Z" },
        },
        "GET /users/zeros-agent%5Bbot%5D": { status: 200, body: { id: 336198133 } },
      }[`${method} ${pathname}`] ?? { status: 404, body: { message: "Not Found" } };
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  };
  return { calls, fetch: fetch as unknown as typeof globalThis.fetch };
}

describe("agent GitHub App credentials", () => {
  it("prefers the Conductor environment value and accepts the Mac setup file's field names", () => {
    const home = temporaryHome();
    mkdirSync(path.join(home, ".zeros-dev"));
    writeFileSync(
      path.join(home, ".zeros-dev", "agent-github-app.json"),
      JSON.stringify({ id: 42, slug: "mac-agent", pem: PEM, clientSecret: "unused" }),
    );
    expect(readAgentApp({ env: {}, home })).toMatchObject({ appId: "42", slug: "mac-agent", privateKey: PEM });

    const encoded = Buffer.from(JSON.stringify(APP)).toString("base64");
    expect(readAgentApp({ env: { ZEROS_AGENT_GITHUB_APP_B64: encoded }, home })).toMatchObject({
      appId: "5138839",
      installationId: 166599058,
      source: "ZEROS_AGENT_GITHUB_APP_B64",
    });
  });

  it("reports a missing or malformed credential without echoing it", () => {
    expect(readAgentApp({ env: {}, home: temporaryHome() })).toBeNull();
    const broken = Buffer.from(JSON.stringify({ ...APP, privateKey: "not-a-key-fixture-9999" })).toString("base64");
    expect(() => readAgentApp({ env: { ZEROS_AGENT_GITHUB_APP_B64: broken } })).toThrow(/incomplete/);
    expect(() => readAgentApp({ env: { ZEROS_AGENT_GITHUB_APP_B64: broken } })).not.toThrow(/not-a-key-fixture/);
    const notJson = Buffer.from("{ secret-fixture-8888").toString("base64");
    expect(() => readAgentApp({ env: { ZEROS_AGENT_GITHUB_APP_B64: notJson } })).toThrow(/not JSON$/);
  });
});

describe("agent installation session", () => {
  it("mints a repository-scoped token with a verifiable App JWT and caches it owner-only", async () => {
    const cacheFile = path.join(temporaryHome(), "cache", "token.json");
    const github = fakeGitHub();
    const app = { ...APP, installationId: undefined, botUserId: undefined };

    const session = await agentSession(app, { fetch: github.fetch, now: () => NOW, cacheFile });

    expect(session).toMatchObject({ token: TOKEN, installationId: 166599058, botUserId: 336198133 });
    expect(github.calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      "GET /repos/Withso/zeros/installation",
      "POST /app/installations/166599058/access_tokens",
      "GET /users/zeros-agent%5Bbot%5D",
    ]);
    expect(JSON.parse(github.calls[1].body ?? "{}")).toEqual({ repositories: ["zeros"] });
    const jwt = github.calls[1].authorization.replace(/^Bearer /, "");
    const [header, payload, signature] = jwt.split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    expect(claims.iss).toBe("5138839");
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
    expect(
      createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(publicKey, signature, "base64url"),
    ).toBe(true);
    expect(statSync(cacheFile).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(cacheFile)).mode & 0o777).toBe(0o700);
  });

  it("reuses a cached token until ten minutes before it expires", async () => {
    const cacheFile = path.join(temporaryHome(), "token.json");
    const first = fakeGitHub();
    await agentSession(APP, { fetch: first.fetch, now: () => NOW, cacheFile });
    expect(first.calls).toHaveLength(1);

    const cached = fakeGitHub();
    await agentSession(APP, { fetch: cached.fetch, now: () => NOW + 45 * 60_000, cacheFile });
    expect(cached.calls).toHaveLength(0);

    const refreshed = fakeGitHub();
    await agentSession(APP, { fetch: refreshed.fetch, now: () => NOW + 51 * 60_000, cacheFile });
    expect(refreshed.calls.map((call) => call.method)).toEqual(["POST"]);
  });

  it("names the failing GitHub request without including a credential", async () => {
    const github = fakeGitHub({
      "POST /app/installations/166599058/access_tokens": { status: 401, body: { message: "Bad credentials" } },
    });
    const failure = agentSession(APP, {
      fetch: github.fetch,
      now: () => NOW,
      cacheFile: path.join(temporaryHome(), "token.json"),
    });
    await expect(failure).rejects.toThrow(
      "GitHub POST /app/installations/166599058/access_tokens returned HTTP 401: Bad credentials",
    );
    const message = await failure.catch((error: Error) => error.message);
    expect(message).not.toContain(github.calls[0].authorization.replace(/^Bearer /, ""));
  });
});

describe("agent git and gh invocations", () => {
  it("commits as the bot account and keeps the token out of the arguments", () => {
    const invocation = gitInvocation(["push", "origin", "HEAD"], SESSION, { CONDUCTOR_REAL_GIT_PATH: "/usr/bin/git" });
    expect(agentIdentity("zeros-agent", 336198133)).toEqual({
      name: "zeros-agent[bot]",
      email: "336198133+zeros-agent[bot]@users.noreply.github.com",
    });
    expect(invocation.command).toBe("/usr/bin/git");
    expect(invocation.env).toMatchObject({
      GIT_AUTHOR_NAME: "zeros-agent[bot]",
      GIT_COMMITTER_EMAIL: "336198133+zeros-agent[bot]@users.noreply.github.com",
      [TOKEN_ENV]: TOKEN,
    });
    expect(invocation.args.slice(-3)).toEqual(["push", "origin", "HEAD"]);
    expect(invocation.args.join(" ")).not.toContain(TOKEN);
  });

  it("answers git before any broker helper configured for github.com", () => {
    const home = temporaryHome();
    const globalConfig = path.join(home, "gitconfig");
    writeFileSync(
      globalConfig,
      '[credential "https://github.com"]\n\thelper = "!f() { echo username=owner; echo password=owner-token; }; f"\n',
    );
    const invocation = gitInvocation(["credential", "fill"], SESSION, {});
    const output = execFileSync(invocation.command, invocation.args, {
      input: "protocol=https\nhost=github.com\n\n",
      env: {
        PATH: process.env.PATH,
        HOME: home,
        GIT_CONFIG_GLOBAL: globalConfig,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        ...invocation.env,
      },
      encoding: "utf8",
    });
    expect(output).toContain("username=x-access-token");
    expect(output).toContain(`password=${TOKEN}`);
    expect(output).not.toContain("owner-token");
    expect(CREDENTIAL_HELPER).not.toContain(TOKEN);
  });

  it("runs the gh that Conductor wraps with the bot token in its environment", () => {
    const invocation = ghInvocation(["pr", "create", "--fill"], SESSION, { CONDUCTOR_REAL_GH_PATH: "/opt/gh" });
    expect(invocation).toEqual({
      command: "/opt/gh",
      args: ["pr", "create", "--fill"],
      env: { GH_TOKEN: TOKEN, GH_PROMPT_DISABLED: "1" },
    });
    expect(ghInvocation([], SESSION, {}).command).toBe("gh");
  });
});
