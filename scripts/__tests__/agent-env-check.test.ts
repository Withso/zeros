import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  KNOWN_KEYS,
  OPERATOR_TEMPLATE_KEYS,
  PROVIDER_KEYS,
  SECRET_KEYS,
  checkFile,
  checkLinkedWorktrees,
  gitWorktrees,
  checkZerosDevValues,
  formatResults,
  parseAgentEnv,
  redact,
  runProviderChecks,
  signS3Get,
} from "../agent-env-check.mjs";

const NOW = Date.parse("2026-09-25T10:00:00Z");
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const APP_KEY_B64 = Buffer.from(privateKey.export({ type: "pkcs1", format: "pem" }) as string).toString("base64");

/** Distinctive fixture values, so a leak into the output is detectable. */
const VALUES: Record<string, string> = {
  CLOUDFLARE_ACCOUNT_ID: "acct0123456789abcdef0123456789ab",
  CLOUDFLARE_API_TOKEN: "fixture-cloudflare-token-000000000000",
  ZEROS_R2_ALPHA_BUCKET: "zeros-cloud-workspaces-alpha",
  ZEROS_R2_ALPHA_ENDPOINT: "https://acct0123456789abcdef0123456789ab.r2.cloudflarestorage.com",
  ZEROS_R2_ALPHA_ACCESS_KEY_ID: "r2-access-key-fixture-1111111111",
  ZEROS_R2_ALPHA_SECRET_ACCESS_KEY: "r2-secret-fixture-2222222222222222222222",
  PLANETSCALE_ORG: "zeros",
  ZEROS_PLANETSCALE_ALPHA_DATABASE: "zeros-control-plane-alpha",
  PLANETSCALE_SERVICE_TOKEN_ID: "pscale-token-id-fixture",
  PLANETSCALE_SERVICE_TOKEN: "fixture-planetscale-token-3333333333",
  BOAT_API_KEY: "boat-secret-fixture-4444444444444444",
  RAILWAY_ALPHA_PROJECT_TOKEN: "railway-token-fixture-5555555555",
  WORKOS_ALPHA_API_KEY: "fixture-workos-key-666666666666",
  ZEROS_GITHUB_ALPHA_APP_ID: "5063408",
  ZEROS_GITHUB_ALPHA_APP_SLUG: "zeros-alpha",
  ZEROS_GITHUB_ALPHA_APP_PRIVATE_KEY_B64: APP_KEY_B64,
  ZEROS_GITHUB_CI_TOKEN: "fixture-github-ci-token-777777777777",
  CURSOR_API_KEY: "cursor-key-fixture-888888888888",
};

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

const R2_HOST = "acct0123456789abcdef0123456789ab.r2.cloudflarestorage.com";
const PLANETSCALE_DATABASES = "api.planetscale.com/v1/organizations/zeros/databases";

/** A fake network, routed by exact host and path: every provider answers as a
 *  correctly scoped Alpha key. */
function network(overrides: Record<string, Reply> = {}, railwayEnvironment = "alpha") {
  const seen: string[] = [];
  const replies: Record<string, Reply> = {
    "api.cloudflare.com/client/v4/user/tokens/verify": { status: 200, body: { result: { status: "active", expires_on: "2026-12-24T00:00:00Z" } } },
    [`api.cloudflare.com/client/v4/accounts/${VALUES.CLOUDFLARE_ACCOUNT_ID}/pages/projects`]: { status: 200, body: { success: true, result: [] } },
    [`${R2_HOST}/zeros-cloud-workspaces-alpha`]: { status: 200 },
    [`${R2_HOST}/zeros-cloud-workspaces-production`]: { status: 403 },
    [`${PLANETSCALE_DATABASES}/zeros-control-plane-alpha`]: { status: 200, body: {} },
    [`${PLANETSCALE_DATABASES}/zeros-control-plane-production`]: { status: 404 },
    "boat.dev/api/v1/api-keys": { status: 200, body: { apiKeys: [{ name: "zeros-agent-dev", expiresAt: "2026-12-24T00:00:00Z", scope: { actions: ["sandbox.read", "exec"] } }] } },
    "api.workos.com/user_management/users": { status: 200, body: { data: [] } },
    "api.github.com/app": { status: 200, body: { slug: "zeros-alpha", id: 5063408 } },
    "api.github.com/user": { status: 200, body: { login: "operator" }, headers: { "github-authentication-token-expiration": "2026-12-24 00:00:00 UTC" } },
    "api.github.com/repos/Withso/zeros/environments/alpha/secrets": { status: 200, body: { secrets: [] } },
  };
  const fetch = async (url: string, init: RequestInit = {}) => {
    const { host, pathname } = new URL(url);
    const route = `${host}${pathname}`;
    seen.push(host);
    let reply = overrides[route];
    if (!reply && route === "backboard.railway.com/graphql/v2") {
      const query = JSON.parse(String(init.body)).query as string;
      reply = query.includes("projectToken")
        ? { status: 200, body: { data: { projectToken: { projectId: "p", environmentId: "env-alpha" } } } }
        : { status: 200, body: { data: { environment: { name: railwayEnvironment } } } };
    }
    reply ??= replies[route] ?? { status: 599 };
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status, headers: reply.headers });
  };
  return { deps: { fetch, now: () => NOW }, seen };
}

const byId = (results: Array<{ id: string }>) => Object.fromEntries(results.map((r) => [r.id, r]));

describe("agent credential check", () => {
  it("redacts Actions-only envelopes and decoded secrets without adding them to the canonical file's keys",()=>{
    const device=Buffer.from(JSON.stringify({version:1,privateKey:"synthetic-hourly-private-seed"})).toString("base64");
    const fixture={ZEROS_DEV_PASSWORD:'synthetic-"hourly-password"',ZEROS_DEV_DEVICE_PRIVATE_KEY_B64:device};
    const raw=JSON.stringify(fixture);
    const values={ZEROS_DEV_FIXTURE_B64:Buffer.from(raw).toString("base64"),AGENT_RUNTIME_ANTHROPIC_API_KEY:"synthetic-hourly-claude-key",
      AGENT_RUNTIME_CLAUDE_CODE_OAUTH_TOKEN:"synthetic-hourly-claude-oauth",AGENT_RUNTIME_OPENAI_API_KEY:"synthetic-hourly-openai-key",
      AGENT_RUNTIME_CURSOR_API_KEY:"synthetic-hourly-cursor-key",AGENT_RUNTIME_CODEX_AUTH_JSON:JSON.stringify({tokens:{access_token:"synthetic-hourly-access",refresh_token:"synthetic-hourly-refresh",id_token:"synthetic-hourly-id"}})};
    for(const [key,value] of Object.entries(values)){
      expect(KNOWN_KEYS).not.toContain(key);
      expect(redact(`provider echoed ${value}`,values)).not.toContain(value);
    }
    const text=[raw,device,fixture.ZEROS_DEV_PASSWORD,JSON.stringify(fixture.ZEROS_DEV_PASSWORD),"synthetic-hourly-private-seed",
      "synthetic-hourly-access","synthetic-hourly-refresh","synthetic-hourly-id"].join(" ");
    expect(redact(text,values)).not.toContain("synthetic-");
  });
  it("redacts every zeros-dev secret before fixtures can be added", () => {
    const secrets = {
      ZEROS_DEV_PASSWORD: 'synthetic-"password"-\\value',
      ZEROS_DEV_ACCESS_TOKEN: "synthetic-access-token",
      ZEROS_DEV_REFRESH_TOKEN: "synthetic-refresh-token",
      ZEROS_DEV_DEVICE_PRIVATE_KEY_B64: "synthetic-device-private-key",
      ZEROS_DEV_ALPHA_READONLY_DATABASE_URL: "postgres://fixture:synthetic@localhost/test",
    };
    for (const [key, value] of Object.entries(secrets)) {
      expect(SECRET_KEYS).toContain(key);
      expect(redact(`provider echoed ${value}`, secrets)).not.toContain(value);
      expect(redact(JSON.stringify({ detail: value }), secrets)).not.toContain(
        JSON.stringify(value).slice(1, -1),
      );
    }
  });

  it("does not leak short password values in rejected input diagnostics", () => {
    expect(redact("fixture: abc", { ZEROS_DEV_PASSWORD: "abc" })).toBe("fixture: [redacted]");
  });

  it("redacts the decoded device key as well as its storage envelope", () => {
    const privateKey="synthetic-private-device-seed";
    const raw=JSON.stringify({version:1,privateKey});
    const values={ZEROS_DEV_DEVICE_PRIVATE_KEY_B64:Buffer.from(raw).toString("base64")};
    expect(redact(`${raw} ${privateKey}`,values)).not.toContain(privateKey);
  });

  it("recognizes the pinned zeros-dev identity and session metadata", () => {
    for(const key of ["WORKOS_SUBJECT","ACCOUNT_ID","EMAIL","ORGANIZATION_ID","REPOSITORY","REPOSITORY_ID","GITHUB_INSTALLATION_ID","SESSION_ID","TOKEN_EXPIRES_AT"])
      expect(KNOWN_KEYS).toContain(`ZEROS_DEV_${key}`);
  });

  it("is wired as pnpm agent:check", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["agent:check"]).toBe("node scripts/agent-env-check.mjs");
  });

  it("signs S3 requests exactly as AWS documents", () => {
    const base = {
      // The signature depends on the secret, not the access key ID.
      accessKeyId: "example-access-key-id",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      host: "examplebucket.s3.amazonaws.com",
      region: "us-east-1",
      now: new Date("2013-05-24T00:00:00Z"),
    };
    const signature = (headers: Record<string, string>) => /Signature=([0-9a-f]+)/.exec(headers.authorization)?.[1];
    expect(signature(signS3Get({ ...base, path: "/test.txt", headers: { Range: "bytes=0-9" } })))
      .toBe("f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
    expect(signature(signS3Get({ ...base, path: "/", query: { "max-keys": "2", prefix: "J" } })))
      .toBe("34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7");
    expect(signS3Get({ ...base, path: "/" })).not.toHaveProperty("host");
  });

  it("parses the file and reports a multi-line value by line number only", () => {
    const parsed = parseAgentEnv([
      "# comment",
      "",
      "A=1",
      "B=x=y",
      "C='quoted value'\r",
      "D=first line of a pasted multi-line value",
      "secretbodyline continues here",
      "last line",
      "A=2",
    ].join("\n"));
    expect(Object.fromEntries(parsed.values)).toEqual({ A: "2", B: "x=y", C: "quoted value", D: "first line of a pasted multi-line value" });
    expect(parsed.malformedLines).toEqual([7, 8]);
    expect(parsed.duplicateKeys).toEqual(["A"]);
    const [result] = checkFile({ exists: true, mode: 0o600, parsed });
    expect(result).toMatchObject({ status: "fail" });
    expect(result.detail).toContain("7, 8");
    expect(result.detail).not.toContain("secretbodyline");
  });

  it("warns about a file other users can read", () => {
    const parsed = parseAgentEnv("A=1\n");
    expect(checkFile({ exists: true, mode: 0o644, parsed })).toEqual([
      expect.objectContaining({ status: "warn", detail: expect.stringContaining("chmod 600") }),
    ]);
  });

  it("passes correctly scoped Alpha credentials and never prints a value", async () => {
    const { deps } = network();
    const results = await runProviderChecks(VALUES, deps);
    const status = Object.fromEntries(results.map((r) => [r.id, r.status]));
    expect(status).toEqual({
      cloudflare: "ok", r2: "ok", planetscale: "ok", boat: "ok", railway: "ok", workos: "ok",
      "github-app": "ok", "github-ci": "ok", openai: "skip", claude: "skip", cursor: "ok",
      "zeros-dev": "skip",
    });
    const output = redact(formatResults(results, ".env.agent"), VALUES);
    for (const key of SECRET_KEYS) if (VALUES[key]) expect(output).not.toContain(VALUES[key]);
    expect(output).toContain("lists zeros-cloud-workspaces-alpha; Production bucket refused");
  });

  it("warns when a key also reaches Production", async () => {
    const { deps } = network({
      [`${PLANETSCALE_DATABASES}/zeros-control-plane-production`]: { status: 200, body: {} },
      [`${R2_HOST}/zeros-cloud-workspaces-production`]: { status: 200 },
    }, "production");
    const results = byId(await runProviderChecks(VALUES, deps));
    expect(results.planetscale).toMatchObject({ status: "warn", detail: "reads zeros-control-plane-alpha, but also zeros-control-plane-production" });
    expect(results.r2).toMatchObject({ status: "warn", detail: "lists zeros-cloud-workspaces-alpha, but also zeros-cloud-workspaces-production" });
    expect(results.railway).toMatchObject({ status: "warn", detail: "project token for the production environment, not alpha" });
  });

  it("fails a GitHub App key that belongs to the Production app", async () => {
    const { deps } = network({ "api.github.com/app": { status: 200, body: { slug: "zeros-app" } } });
    const results = byId(await runProviderChecks(VALUES, deps));
    expect(results["github-app"]).toMatchObject({ status: "fail" });
    expect(results["github-app"].detail).toContain("Production app zeros-app");
  });

  it("flags an admin Boat key, a soon-expiring token and a rejected key", async () => {
    const { deps } = network({
      "boat.dev/api/v1/api-keys": { status: 200, body: { apiKeys: [{ name: "k", expiresAt: "2027-01-01T00:00:00Z", scope: { actions: ["*"] } }] } },
      "api.cloudflare.com/client/v4/user/tokens/verify": { status: 200, body: { result: { status: "active", expires_on: "2026-09-30T00:00:00Z" } } },
      "api.workos.com/user_management/users": { status: 401 },
    });
    const results = byId(await runProviderChecks(VALUES, deps));
    expect(results.boat).toMatchObject({ status: "warn", detail: expect.stringContaining("ADMIN scope") });
    expect(results.cloudflare).toMatchObject({ status: "warn", detail: "reads Pages; expires 2026-09-30" });
    expect(results.workos).toMatchObject({ status: "fail", detail: "key rejected (HTTP 401)" });
  });

  it("skips unset providers without calling them", async () => {
    const { deps, seen } = network();
    const results = await runProviderChecks({ ...VALUES, BOAT_API_KEY: "", WORKOS_ALPHA_API_KEY: "" }, deps);
    expect(byId(results).boat).toMatchObject({ status: "skip", detail: "not set" });
    expect(seen).not.toContain("boat.dev");
    expect(seen).not.toContain("api.workos.com");
  });

  it("keeps the template tracked, operator-only and free of values", () => {
    const text = readFileSync(".env.agent.example", "utf8");
    const template = parseAgentEnv(text);
    expect(template.malformedLines).toEqual([]);
    expect(template.duplicateKeys).toEqual([]);
    expect([...template.values.keys()].sort()).toEqual([...OPERATOR_TEMPLATE_KEYS].sort());
    for (const key of OPERATOR_TEMPLATE_KEYS) expect(KNOWN_KEYS).toContain(key);
    for (const key of SECRET_KEYS) expect(template.values.get(key) ?? "").toBe("");
    expect(text).toContain("Zeros Internal MCP");
    expect(text).toContain("agent-env.mjs import");
    expect(() => execFileSync("git", ["check-ignore", "-q", ".env.agent.example"])).toThrow();
    expect(execFileSync("git", ["check-ignore", ".env.agent"]).toString().trim()).toBe(".env.agent");
  });

  it("points agents at the Zeros Internal MCP when there is no .env.agent", () => {
    const results = checkFile({ exists: false, mode: null, parsed: parseAgentEnv("") });
    expect(results.find((r) => r.id === "mcp")).toMatchObject({ status: "skip", detail: expect.stringContaining("whoami") });
    expect(formatResults(results, "process environment")).toContain("check_*");
  });

  it("warns about provider keys in linked worktrees by path and count only", () => {
    const files: Record<string, string> = {
      "/main/.env.agent": `CLOUDFLARE_API_TOKEN=${VALUES.CLOUDFLARE_API_TOKEN}\n`,
      "/linked/.env.agent": `BOAT_API_KEY=${VALUES.BOAT_API_KEY}\nWORKOS_ALPHA_API_KEY=${VALUES.WORKOS_ALPHA_API_KEY}\nZEROS_DEV_PASSWORD=x\n`,
      "/fixture-only/.env.agent": "ZEROS_DEV_PASSWORD=x\nZEROS_DEV_EMAIL=fixture@example.test\nBOAT_API_KEY=\n",
    };
    const read = (file: string) => { if (!(file in files)) throw new Error("ENOENT"); return files[file]; };
    const results = checkLinkedWorktrees(["/main", "/linked", "/fixture-only", "/no-file"], read);
    expect(results).toEqual([expect.objectContaining({ id: "worktree", status: "warn" })]);
    expect(results[0].detail).toContain(`${path.join("/linked", ".env.agent")} holds 2 provider key(s)`);
    expect(results[0].detail).toContain("Zeros Internal MCP");
    expect(JSON.stringify(results)).not.toContain(VALUES.BOAT_API_KEY);
    for (const key of PROVIDER_KEYS) expect(SECRET_KEYS).toContain(key);
  });

  it("lists the main checkout first, then linked worktrees, skipping unbounded files", () => {
    const home = realpathSync(mkdtempSync(path.join(tmpdir(), "agent-check-")));
    try {
      const main = path.join(home, "main"), linked = path.join(home, "linked worktree");
      const git = (...args: string[]) => execFileSync("git", args, { cwd: home, encoding: "utf8", stdio: "pipe" });
      git("init", "-q", main);
      git("-C", main, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "initial");
      git("-C", main, "worktree", "add", "-q", "-b", "feature", linked);
      expect(gitWorktrees(linked)).toEqual([main, linked]);
      symlinkSync("/dev/zero", path.join(linked, ".env.agent"));
      expect(checkLinkedWorktrees(gitWorktrees(main))).toEqual([]);
      writeFileSync(path.join(main, "big.env"), `BOAT_API_KEY=x\n${"#".repeat(300 * 1024)}\n`);
      rmSync(path.join(linked, ".env.agent"));
      symlinkSync(path.join(main, "big.env"), path.join(linked, ".env.agent"));
      expect(checkLinkedWorktrees(gitWorktrees(main))).toEqual([]);
      rmSync(path.join(linked, ".env.agent"));
      writeFileSync(path.join(linked, ".env.agent"), "BOAT_API_KEY=x\n");
      expect(checkLinkedWorktrees(gitWorktrees(main))).toHaveLength(1);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("checks zeros-dev fixture presence locally without authenticating or echoing a password",()=>{
    const values={ZEROS_DEV_WORKOS_SUBJECT:"user_fixture",ZEROS_DEV_ACCOUNT_ID:"11111111-1111-4111-8111-111111111111",ZEROS_DEV_EMAIL:"fixture@example.test",
      ZEROS_DEV_ORGANIZATION_ID:"22222222-2222-4222-8222-222222222222",ZEROS_DEV_REPOSITORY:"test-owner/test-repo",ZEROS_DEV_REPOSITORY_ID:"1234",
      ZEROS_DEV_GITHUB_INSTALLATION_ID:"33333333-3333-4333-8333-333333333333",ZEROS_DEV_PASSWORD:"synthetic-private-password"};
    expect(checkZerosDevValues({})).toMatchObject({status:"skip"});
    expect(checkZerosDevValues(values)).toMatchObject({status:"ok",detail:expect.stringContaining("live login not checked")});
    for(const changes of [{ZEROS_DEV_EMAIL:""},{ZEROS_DEV_ACCOUNT_ID:"bad"},{ZEROS_DEV_REPOSITORY:"../foreign"},{ZEROS_DEV_PASSWORD:""}])
      expect(checkZerosDevValues({...values,...changes})).toMatchObject({status:"fail"});
    expect(JSON.stringify(checkZerosDevValues({...values,ZEROS_DEV_EMAIL:"invalid"}))).not.toContain(values.ZEROS_DEV_PASSWORD);
  });

  it("distinguishes a valid login identity awaiting GitHub from invalid credentials",()=>{
    const identity={ZEROS_DEV_WORKOS_SUBJECT:"user_fixture",ZEROS_DEV_ACCOUNT_ID:"11111111-1111-4111-8111-111111111111",ZEROS_DEV_EMAIL:"fixture@example.test",
      ZEROS_DEV_ORGANIZATION_ID:"22222222-2222-4222-8222-222222222222",ZEROS_DEV_PASSWORD:"synthetic-private-password"};
    for(const partial of [{},{ZEROS_DEV_REPOSITORY:""},{ZEROS_DEV_REPOSITORY:"test-owner/test-repo",ZEROS_DEV_REPOSITORY_ID:"1234"}])
      expect(checkZerosDevValues({...identity,...partial})).toMatchObject({status:"warn",detail:expect.stringContaining("GitHub fixture pending")});
    for(const invalid of [{ZEROS_DEV_ACCOUNT_ID:"bad"},{ZEROS_DEV_REPOSITORY:"../foreign"},{ZEROS_DEV_GITHUB_INSTALLATION_ID:"1234"}])
      expect(checkZerosDevValues({...identity,...invalid})).toMatchObject({status:"fail"});
  });

  it.each([undefined, "", "synthetic-local-password"])("accepts the electron:cloud fixture with an optional password (%#)", async password => {
    const values = { ZEROS_DEV_REPOSITORY: "test-owner/test-repo", ZEROS_DEV_GITHUB_INSTALLATION_ID: "1234",
      ...(password === undefined ? {} : { ZEROS_DEV_PASSWORD: password }) };
    const { deps, seen } = network();
    const result = byId(await runProviderChecks(values, deps))["zeros-dev"];
    expect(result).toMatchObject({ status: "ok", detail: expect.stringContaining("electron:cloud") });
    expect(result.detail).toContain("live login not checked");
    expect(seen).toEqual([]);
    if (password) expect(JSON.stringify(result)).not.toContain(password);
  });

  it("rejects malformed or incomplete local fixtures and never falls back from a partial hosted identity", () => {
    const local = { ZEROS_DEV_REPOSITORY: "test-owner/test-repo", ZEROS_DEV_GITHUB_INSTALLATION_ID: "1234" };
    for (const changes of [
      { ZEROS_DEV_REPOSITORY: "" }, { ZEROS_DEV_REPOSITORY: "../foreign" }, { ZEROS_DEV_REPOSITORY: "owner/repo.git" },
      { ZEROS_DEV_GITHUB_INSTALLATION_ID: "" }, { ZEROS_DEV_GITHUB_INSTALLATION_ID: "0" },
      { ZEROS_DEV_GITHUB_INSTALLATION_ID: "-1" }, { ZEROS_DEV_GITHUB_INSTALLATION_ID: "1e3" },
      { ZEROS_DEV_GITHUB_INSTALLATION_ID: "9007199254740992" },
      { ZEROS_DEV_GITHUB_INSTALLATION_ID: "33333333-3333-4333-8333-333333333333" },
      { ZEROS_DEV_REPOSITORY_ID: "invalid" }, { ZEROS_DEV_PASSWORD: "x".repeat(1025) },
      ...["WORKOS_SUBJECT", "ACCOUNT_ID", "ORGANIZATION_ID", "EMAIL", "ACCESS_TOKEN", "REFRESH_TOKEN", "SESSION_ID", "TOKEN_EXPIRES_AT", "DEVICE_PRIVATE_KEY_B64"]
        .map(name => ({ [`ZEROS_DEV_${name}`]: "incomplete-hosted-identity" })),
    ]) expect(checkZerosDevValues({ ...local, ...changes })).toMatchObject({ status: "fail" });
  });
});
