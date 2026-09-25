#!/usr/bin/env node
// ──────────────────────────────────────────────────────────
// agent-env-check — prove the agent credentials work, read-only
// ──────────────────────────────────────────────────────────
//
// Agents read non-production credentials from the gitignored `.env.agent` at
// the repository root (template: `.env.agent.example`); Conductor copies that
// file into every new workspace. This check makes read-only requests for each
// configured provider and reports what the credential can reach: the Alpha
// resources it should, whether Beta and Production are refused, and when it
// expires. An unset key is reported as not set, never as a failure. Values
// are never printed.
//
// Run: `pnpm agent:check` (`--file <path>` for another file, `--json` for
// machine output). Exit 1 when a configured credential fails or the file is
// malformed.
// ──────────────────────────────────────────────────────────

import { createHash, createHmac, createPrivateKey, createSign } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY = "Withso/zeros";
const PRODUCTION_GITHUB_APP_SLUG = "zeros-app";
const EXPIRY_WARNING_MS = 14 * 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20_000;
const USER_AGENT = "zeros-agent-check";

/** Keys whose values are credentials. Their values are redacted from every
 *  line of output, whatever a provider echoes back. */
export const SECRET_KEYS = Object.freeze([
  "CLOUDFLARE_API_TOKEN",
  "ZEROS_R2_ALPHA_ACCESS_KEY_ID",
  "ZEROS_R2_ALPHA_SECRET_ACCESS_KEY",
  "PLANETSCALE_SERVICE_TOKEN_ID",
  "PLANETSCALE_SERVICE_TOKEN",
  "BOAT_API_KEY",
  "RAILWAY_ALPHA_PROJECT_TOKEN",
  "WORKOS_ALPHA_API_KEY",
  "ZEROS_GITHUB_ALPHA_APP_PRIVATE_KEY_B64",
  "ZEROS_GITHUB_CI_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CURSOR_API_KEY",
  "OPENAI_API_KEY",
]);

/** Every key the template documents. Only these are read from the process
 *  environment when `.env.agent` does not set them. */
export const KNOWN_KEYS = Object.freeze([
  ...SECRET_KEYS,
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_ZONE_ID",
  "ZEROS_R2_ALPHA_BUCKET",
  "ZEROS_R2_ALPHA_ENDPOINT",
  "PLANETSCALE_ORG",
  "ZEROS_PLANETSCALE_ALPHA_DATABASE",
  "BOAT_BILLING_ORG",
  "ZEROS_GITHUB_ALPHA_APP_ID",
  "ZEROS_GITHUB_ALPHA_APP_SLUG",
  "ZEROS_CLOUD_REQUIRED_AGENTS",
  "ZEROS_CLOUD_AGENT_SELECTIONS",
]);

/** Parse a dotenv file. Lines that are neither comments nor `KEY=value` are
 *  reported by number only: a multi-line value pasted across lines is the
 *  usual cause, and its content is secret. */
export function parseAgentEnv(text) {
  const values = new Map();
  const malformedLines = [];
  const duplicateKeys = [];
  text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .forEach((line, index) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
      if (!match) {
        malformedLines.push(index + 1);
        return;
      }
      if (values.has(match[1])) duplicateKeys.push(match[1]);
      values.set(match[1], unquote(match[2].trim()));
    });
  return { values, malformedLines, duplicateKeys };
}

function unquote(value) {
  const quote = value[0];
  return (quote === '"' || quote === "'") &&
    value.length >= 2 &&
    value.at(-1) === quote
    ? value.slice(1, -1)
    : value;
}

const sha256Hex = (value) => createHash("sha256").update(value).digest("hex");
const hmac = (key, value) => createHmac("sha256", key).update(value).digest();
const encodeRfc3986 = (value) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
const canonicalQuery = (query) =>
  Object.keys(query)
    .sort()
    .map((key) => `${encodeRfc3986(key)}=${encodeRfc3986(query[key])}`)
    .join("&");

/** AWS Signature Version 4 headers for a GET with an empty payload, as R2's
 *  S3 API requires. The host is signed but not returned: fetch sets it. */
export function signS3Get({
  accessKeyId,
  secretAccessKey,
  host,
  path: requestPath,
  query = {},
  headers = {},
  region = "auto",
  now = new Date(),
}) {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const payloadHash = sha256Hex("");
  const extra = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()]),
  );
  const signed = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...extra,
  };
  const names = Object.keys(signed).sort();
  const canonicalRequest = [
    "GET",
    requestPath.split("/").map(encodeRfc3986).join("/"),
    canonicalQuery(query),
    names.map((name) => `${name}:${signed[name]}\n`).join(""),
    names.join(";"),
    payloadHash,
  ].join("\n");
  const scope = `${date}/${region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const key = hmac(
    hmac(hmac(hmac(`AWS4${secretAccessKey}`, date), region), "s3"),
    "aws4_request",
  );
  const signature = createHmac("sha256", key).update(stringToSign).digest("hex");
  const { host: _signedHost, ...sent } = signed;
  return {
    ...sent,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`,
  };
}

/** A short-lived GitHub App JWT (RS256), valid for five minutes. */
export function githubAppJwt(appId, privateKeyPem, nowMs = Date.now()) {
  const segment = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const issuedAt = Math.floor(nowMs / 1000) - 60;
  const data = `${segment({ alg: "RS256", typ: "JWT" })}.${segment({ iat: issuedAt, exp: issuedAt + 360, iss: String(appId) })}`;
  return `${data}.${createSign("RSA-SHA256").update(data).sign(privateKeyPem, "base64url")}`;
}

async function request(deps, url, init = {}) {
  try {
    const response = await deps.fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: response.status, body, headers: response.headers };
  } catch (error) {
    return { status: `network error (${error?.name ?? "Error"})`, body: null, headers: null };
  }
}

function expiry(value, nowMs) {
  if (!value) return { text: "no expiry", soon: false };
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return { text: "expiry unknown", soon: false };
  return {
    text: `${at <= nowMs ? "EXPIRED" : "expires"} ${new Date(at).toISOString().slice(0, 10)}`,
    soon: at - nowMs < EXPIRY_WARNING_MS,
  };
}

const ok = (detail) => ({ status: "ok", detail });
const warn = (detail) => ({ status: "warn", detail });
const fail = (detail) => ({ status: "fail", detail });

const siblings = (name) =>
  name.endsWith("-alpha")
    ? ["beta", "production"].map((channel) => name.replace(/-alpha$/, `-${channel}`))
    : [];

export const PROVIDER_CHECKS = Object.freeze([
  {
    id: "cloudflare",
    label: "Cloudflare",
    keys: ["CLOUDFLARE_API_TOKEN"],
    async run(v, deps) {
      const headers = { authorization: `Bearer ${v.CLOUDFLARE_API_TOKEN}` };
      const verified = await request(deps, "https://api.cloudflare.com/client/v4/user/tokens/verify", { headers });
      if (verified.body?.result?.status !== "active") {
        return fail(`token is not active (HTTP ${verified.status})`);
      }
      const expires = expiry(verified.body.result.expires_on, deps.now());
      const notes = [];
      if (v.CLOUDFLARE_ACCOUNT_ID) {
        const pages = await request(
          deps,
          `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(v.CLOUDFLARE_ACCOUNT_ID)}/pages/projects`,
          { headers },
        );
        if (!pages.body?.success) return warn(`token is active but cannot read Pages (HTTP ${pages.status}); ${expires.text}`);
        notes.push("reads Pages");
      }
      notes.push(expires.text);
      return expires.soon ? warn(notes.join("; ")) : ok(notes.join("; "));
    },
  },
  {
    id: "r2",
    label: "R2 (Alpha bucket)",
    keys: ["ZEROS_R2_ALPHA_ACCESS_KEY_ID", "ZEROS_R2_ALPHA_SECRET_ACCESS_KEY", "ZEROS_R2_ALPHA_BUCKET", "ZEROS_R2_ALPHA_ENDPOINT"],
    async run(v, deps) {
      let endpoint;
      try {
        endpoint = new URL(v.ZEROS_R2_ALPHA_ENDPOINT);
      } catch {
        return fail("ZEROS_R2_ALPHA_ENDPOINT is not a URL");
      }
      const query = { "list-type": "2", "max-keys": "1" };
      const list = async (bucket) =>
        (
          await request(deps, `${endpoint.origin}/${encodeRfc3986(bucket)}?${canonicalQuery(query)}`, {
            headers: signS3Get({
              accessKeyId: v.ZEROS_R2_ALPHA_ACCESS_KEY_ID,
              secretAccessKey: v.ZEROS_R2_ALPHA_SECRET_ACCESS_KEY,
              host: endpoint.host,
              path: `/${bucket}`,
              query,
              now: new Date(deps.now()),
            }),
          })
        ).status;
      const bucket = v.ZEROS_R2_ALPHA_BUCKET;
      const own = await list(bucket);
      if (own !== 200) return fail(`cannot list ${bucket} (HTTP ${own})`);
      const reachable = [];
      for (const other of siblings(bucket)) if ((await list(other)) === 200) reachable.push(other);
      if (reachable.length) return warn(`lists ${bucket}, but also ${reachable.join(", ")}`);
      return ok(`lists ${bucket}${siblings(bucket).length ? "; Beta and Production buckets refused" : ""}`);
    },
  },
  {
    id: "planetscale",
    label: "PlanetScale",
    keys: ["PLANETSCALE_ORG", "PLANETSCALE_SERVICE_TOKEN_ID", "PLANETSCALE_SERVICE_TOKEN", "ZEROS_PLANETSCALE_ALPHA_DATABASE"],
    async run(v, deps) {
      const headers = { authorization: `${v.PLANETSCALE_SERVICE_TOKEN_ID}:${v.PLANETSCALE_SERVICE_TOKEN}` };
      const base = `https://api.planetscale.com/v1/organizations/${encodeURIComponent(v.PLANETSCALE_ORG)}/databases/`;
      const database = v.ZEROS_PLANETSCALE_ALPHA_DATABASE;
      const own = await request(deps, base + encodeURIComponent(database), { headers });
      if (own.status !== 200) return fail(`cannot read ${database} (HTTP ${own.status})`);
      const reachable = [];
      for (const other of siblings(database)) {
        if ((await request(deps, base + encodeURIComponent(other), { headers })).status === 200) reachable.push(other);
      }
      if (reachable.length) return warn(`reads ${database}, but also ${reachable.join(", ")}`);
      return ok(`reads ${database}${siblings(database).length ? "; Beta and Production refused" : ""}`);
    },
  },
  {
    id: "boat",
    label: "Boat",
    keys: ["BOAT_API_KEY"],
    async run(v, deps) {
      const listed = await request(deps, "https://boat.dev/api/v1/api-keys", {
        headers: { authorization: `Bearer ${v.BOAT_API_KEY}` },
      });
      if (listed.status !== 200) return fail(`key rejected (HTTP ${listed.status})`);
      const keys = Array.isArray(listed.body?.apiKeys) ? listed.body.apiKeys : [];
      if (keys.length !== 1) return ok(`key works; ${keys.length} keys on the account`);
      const [key] = keys;
      const actions = Array.isArray(key.scope?.actions) ? key.scope.actions : [];
      const admin = actions.includes("*") || actions.includes("account.admin");
      const expires = expiry(key.expiresAt, deps.now());
      const detail = `key "${key.name}" works; ${admin ? "ADMIN scope" : `${actions.length} actions, no admin`}; ${expires.text}`;
      return admin || expires.soon ? warn(detail) : ok(detail);
    },
  },
  {
    id: "railway",
    label: "Railway",
    keys: ["RAILWAY_ALPHA_PROJECT_TOKEN"],
    async run(v, deps) {
      const graphql = (query, variables = {}) =>
        request(deps, "https://backboard.railway.com/graphql/v2", {
          method: "POST",
          headers: { "content-type": "application/json", "project-access-token": v.RAILWAY_ALPHA_PROJECT_TOKEN },
          body: JSON.stringify({ query, variables }),
        });
      const token = (await graphql("{ projectToken { projectId environmentId } }")).body?.data?.projectToken;
      if (!token?.environmentId) return fail("project token rejected");
      const named = await graphql("query($id: String!) { environment(id: $id) { name } }", { id: token.environmentId });
      const name = named.body?.data?.environment?.name ?? "an unknown";
      return name === "alpha"
        ? ok("project token for the alpha environment")
        : warn(`project token for the ${name} environment, not alpha`);
    },
  },
  {
    id: "workos",
    label: "WorkOS (Alpha)",
    keys: ["WORKOS_ALPHA_API_KEY"],
    async run(v, deps) {
      const users = await request(deps, "https://api.workos.com/user_management/users?limit=1", {
        headers: { authorization: `Bearer ${v.WORKOS_ALPHA_API_KEY}` },
      });
      return users.status === 200 ? ok("key can read users") : fail(`key rejected (HTTP ${users.status})`);
    },
  },
  {
    id: "github-app",
    label: "GitHub App (Alpha)",
    keys: ["ZEROS_GITHUB_ALPHA_APP_ID", "ZEROS_GITHUB_ALPHA_APP_PRIVATE_KEY_B64"],
    async run(v, deps) {
      let pem;
      try {
        pem = Buffer.from(v.ZEROS_GITHUB_ALPHA_APP_PRIVATE_KEY_B64, "base64").toString("utf8");
        createPrivateKey(pem);
      } catch {
        return fail("ZEROS_GITHUB_ALPHA_APP_PRIVATE_KEY_B64 is not a base64-encoded PEM key");
      }
      const app = await request(deps, "https://api.github.com/app", {
        headers: {
          authorization: `Bearer ${githubAppJwt(v.ZEROS_GITHUB_ALPHA_APP_ID, pem, deps.now())}`,
          accept: "application/vnd.github+json",
          "user-agent": USER_AGENT,
        },
      });
      const slug = app.body?.slug;
      if (app.status !== 200 || !slug) return fail(`GitHub rejected the key (HTTP ${app.status})`);
      if (slug === PRODUCTION_GITHUB_APP_SLUG) {
        return fail(`this key belongs to the Production app ${slug}; agents may only hold the Alpha app's key`);
      }
      if (v.ZEROS_GITHUB_ALPHA_APP_SLUG && slug !== v.ZEROS_GITHUB_ALPHA_APP_SLUG) {
        return warn(`key authenticates as ${slug}, not ${v.ZEROS_GITHUB_ALPHA_APP_SLUG}`);
      }
      return ok(`key authenticates as ${slug}`);
    },
  },
  {
    id: "github-ci",
    label: "GitHub CI token",
    keys: ["ZEROS_GITHUB_CI_TOKEN"],
    async run(v, deps) {
      const headers = {
        authorization: `Bearer ${v.ZEROS_GITHUB_CI_TOKEN}`,
        accept: "application/vnd.github+json",
        "user-agent": USER_AGENT,
      };
      const user = await request(deps, "https://api.github.com/user", { headers });
      if (user.status !== 200) return fail(`token rejected (HTTP ${user.status})`);
      const header = user.headers?.get?.("github-authentication-token-expiration");
      const expires = expiry(header ? header.replace(" UTC", "Z").replace(" ", "T") : null, deps.now());
      const secrets = await request(deps, `https://api.github.com/repos/${REPOSITORY}/environments/alpha/secrets`, { headers });
      const detail = `${secrets.status === 200 ? "reads Actions environment secrets" : `environment secrets HTTP ${secrets.status}`}; ${expires.text}`;
      return secrets.status !== 200 || expires.soon ? warn(detail) : ok(detail);
    },
  },
  {
    id: "openai",
    label: "OpenAI",
    keys: ["OPENAI_API_KEY"],
    async run(v, deps) {
      const models = await request(deps, "https://api.openai.com/v1/models", {
        headers: { authorization: `Bearer ${v.OPENAI_API_KEY}` },
      });
      return models.status === 200 ? ok("key can list models") : fail(`key rejected (HTTP ${models.status})`);
    },
  },
  {
    id: "claude",
    label: "Claude token",
    keys: ["CLAUDE_CODE_OAUTH_TOKEN"],
    async run() {
      return ok("set; not probed, because validating it spends a model request");
    },
  },
  {
    id: "cursor",
    label: "Cursor",
    keys: ["CURSOR_API_KEY"],
    async run() {
      return ok("set; not probed");
    },
  },
]);

/** Structural findings about the file itself. */
export function checkFile({ exists, mode, parsed }) {
  if (!exists) return [{ id: "file", label: ".env.agent", status: "skip", detail: "no file; using the process environment" }];
  const results = [];
  if (parsed.malformedLines.length) {
    results.push({
      id: "file",
      label: ".env.agent",
      status: "fail",
      detail: `malformed line(s) ${parsed.malformedLines.join(", ")}: keep each value on one line (base64-encode multi-line keys)`,
    });
  }
  if (mode !== null && (mode & 0o077) !== 0) {
    results.push({ id: "file", label: ".env.agent", status: "warn", detail: `mode ${mode.toString(8)}: run chmod 600 .env.agent` });
  }
  if (parsed.duplicateKeys.length) {
    results.push({ id: "file", label: ".env.agent", status: "warn", detail: `duplicate keys ${parsed.duplicateKeys.join(", ")}; the last value wins` });
  }
  if (!results.length) {
    results.push({ id: "file", label: ".env.agent", status: "ok", detail: `mode ${mode === null ? "unknown" : mode.toString(8)}, ${parsed.values.size} keys` });
  }
  return results;
}

/** Run every provider check whose keys are set. */
export async function runProviderChecks(values, deps) {
  return Promise.all(
    PROVIDER_CHECKS.map(async (check) => {
      if (!check.keys.every((key) => values[key])) {
        return { id: check.id, label: check.label, status: "skip", detail: "not set" };
      }
      try {
        return { id: check.id, label: check.label, ...(await check.run(values, deps)) };
      } catch (error) {
        return { id: check.id, label: check.label, status: "fail", detail: `check failed (${error?.name ?? "Error"})` };
      }
    }),
  );
}

/** Replace every secret value that appears in `text`. */
export function redact(text, values) {
  let output = text;
  for (const key of SECRET_KEYS) {
    const value = values[key];
    if (typeof value === "string" && value.length >= 8) output = output.split(value).join("[redacted]");
  }
  return output;
}

const SYMBOL = { ok: "✓", warn: "!", fail: "✗", skip: "-" };

export function formatResults(results, source) {
  const width = Math.max(...results.map((r) => r.label.length));
  const counts = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const r of results) counts[r.status] += 1;
  return [
    `Agent credentials (${source})`,
    ...results.map((r) => `  ${SYMBOL[r.status]} ${r.label.padEnd(width)}  ${r.detail}`),
    `${counts.ok} ok, ${counts.warn} warning(s), ${counts.fail} failed, ${counts.skip} not set`,
  ].join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const fileFlag = args.indexOf("--file");
  const allowed = new Set(["--json", "--file"]);
  if (args.some((arg, i) => !allowed.has(arg) && !(fileFlag >= 0 && i === fileFlag + 1)) || (fileFlag >= 0 && !args[fileFlag + 1])) {
    console.error("usage: node scripts/agent-env-check.mjs [--file <path>] [--json]");
    process.exitCode = 2;
    return;
  }
  const file = fileFlag >= 0 ? path.resolve(args[fileFlag + 1]) : path.join(ROOT, ".env.agent");
  const exists = existsSync(file);
  const parsed = exists
    ? parseAgentEnv(readFileSync(file, "utf8"))
    : { values: new Map(), malformedLines: [], duplicateKeys: [] };
  const mode = exists ? statSync(file).mode & 0o777 : null;
  const values = Object.fromEntries(KNOWN_KEYS.map((key) => [key, parsed.values.get(key) || process.env[key] || ""]));
  const results = [
    ...checkFile({ exists, mode, parsed }),
    ...(await runProviderChecks(values, { fetch: globalThis.fetch, now: Date.now })),
  ];
  const output = args.includes("--json")
    ? JSON.stringify(results, null, 2)
    : formatResults(results, exists ? path.relative(process.cwd(), file) || file : "process environment");
  console.log(redact(output, values));
  process.exitCode = results.some((r) => r.status === "fail") ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
