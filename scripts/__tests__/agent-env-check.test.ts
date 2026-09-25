import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  KNOWN_KEYS,
  SECRET_KEYS,
  checkFile,
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
    [`${R2_HOST}/zeros-cloud-workspaces-beta`]: { status: 403 },
    [`${R2_HOST}/zeros-cloud-workspaces-production`]: { status: 403 },
    [`${PLANETSCALE_DATABASES}/zeros-control-plane-alpha`]: { status: 200, body: {} },
    [`${PLANETSCALE_DATABASES}/zeros-control-plane-beta`]: { status: 404 },
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
    });
    const output = redact(formatResults(results, ".env.agent"), VALUES);
    for (const key of SECRET_KEYS) if (VALUES[key]) expect(output).not.toContain(VALUES[key]);
    expect(output).toContain("lists zeros-cloud-workspaces-alpha; Beta and Production buckets refused");
  });

  it("warns when a key also reaches Beta or Production", async () => {
    const { deps } = network({
      [`${PLANETSCALE_DATABASES}/zeros-control-plane-production`]: { status: 200, body: {} },
      [`${R2_HOST}/zeros-cloud-workspaces-beta`]: { status: 200 },
    }, "production");
    const results = byId(await runProviderChecks(VALUES, deps));
    expect(results.planetscale).toMatchObject({ status: "warn", detail: "reads zeros-control-plane-alpha, but also zeros-control-plane-production" });
    expect(results.r2).toMatchObject({ status: "warn", detail: "lists zeros-cloud-workspaces-alpha, but also zeros-cloud-workspaces-beta" });
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

  it("keeps the template tracked, complete and free of values", () => {
    const template = parseAgentEnv(readFileSync(".env.agent.example", "utf8"));
    expect(template.malformedLines).toEqual([]);
    for (const key of KNOWN_KEYS) expect(template.values.has(key)).toBe(true);
    for (const key of SECRET_KEYS) expect(template.values.get(key)).toBe("");
    expect(() => execFileSync("git", ["check-ignore", "-q", ".env.agent.example"])).toThrow();
    expect(execFileSync("git", ["check-ignore", ".env.agent"]).toString().trim()).toBe(".env.agent");
  });
});
