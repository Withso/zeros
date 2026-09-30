#!/usr/bin/env node
// ──────────────────────────────────────────────────────────
// agent-github — run git or gh as the zeros-agent GitHub App
// ──────────────────────────────────────────────────────────
//
// Coding agents commit, push and open pull requests as `zeros-agent[bot]`, so
// a person can review and approve them: GitHub never lets the author of a pull
// request approve it. The App is installed on this repository only.
//
// The App key never enters the repository. It is read, in order, from
// `ZEROS_AGENT_GITHUB_APP_B64` (Conductor cloud workspaces),
// `ZEROS_AGENT_GITHUB_APP_FILE`, `~/.config/zeros-agent/github-app.json`, then
// `~/.zeros-dev/agent-github-app.json` (the Mac). Installation tokens last an
// hour and are cached owner-only. Neither the key nor a token is printed or
// passed as a command argument: git's credential helper and gh read the token
// from their environment.
//
// Run: `pnpm agent:git commit …`, `pnpm agent:git push …`,
// `pnpm agent:gh pr create …`, and `pnpm agent:github:check`.
// ──────────────────────────────────────────────────────────

import { spawnSync } from "node:child_process";
import { createPrivateKey } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { githubAppJwt } from "./agent-env-check.mjs";

const REPOSITORY = "Withso/zeros";
const API = "https://api.github.com";
const REFRESH_MARGIN_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20_000;
const USER_AGENT = "zeros-agent-github";
export const TOKEN_ENV = "ZEROS_AGENT_GITHUB_TOKEN";
// git runs this helper itself and passes the action as its argument. It answers
// only `get`, from the helper's environment, so git never stores the token.
export const CREDENTIAL_HELPER = `!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=$${TOKEN_ENV}"; }; f`;

/** The agent App's credentials, or null when this machine has none. */
export function readAgentApp({ env = process.env, home = os.homedir() } = {}) {
  let raw = null;
  let source = null;
  if (env.ZEROS_AGENT_GITHUB_APP_B64) {
    raw = Buffer.from(env.ZEROS_AGENT_GITHUB_APP_B64, "base64").toString("utf8");
    source = "ZEROS_AGENT_GITHUB_APP_B64";
  } else {
    for (const file of [
      env.ZEROS_AGENT_GITHUB_APP_FILE,
      path.join(home, ".config", "zeros-agent", "github-app.json"),
      path.join(home, ".zeros-dev", "agent-github-app.json"),
    ]) {
      if (file && existsSync(file)) {
        raw = readFileSync(file, "utf8");
        source = file;
        break;
      }
    }
  }
  if (raw === null) return null;
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`the agent GitHub App credentials in ${source} are not JSON`);
  }
  // The Mac's setup file keeps GitHub's own field names (`id`, `pem`).
  const app = {
    appId: String(value?.appId ?? value?.id ?? ""),
    slug: value?.slug,
    installationId: value?.installationId,
    botUserId: value?.botUserId,
    privateKey: value?.privateKey ?? value?.pem,
    source,
  };
  let validKey = false;
  try {
    validKey = typeof app.privateKey === "string" && createPrivateKey(app.privateKey).asymmetricKeyType === "rsa";
  } catch {
    validKey = false;
  }
  if (!/^\d+$/.test(app.appId) || typeof app.slug !== "string" || !app.slug || !validKey) {
    throw new Error(`the agent GitHub App credentials in ${source} are incomplete`);
  }
  return app;
}

/** The commit identity GitHub attributes to the App's bot account. */
export function agentIdentity(slug, botUserId) {
  const name = `${slug}[bot]`;
  return { name, email: `${botUserId}+${name}@users.noreply.github.com` };
}

export function defaultTokenCache(home = os.homedir()) {
  return path.join(home, ".cache", "zeros-agent", "github-token.json");
}

function readTokenCache(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeTokenCache(file, value) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  renameSync(temporary, file);
}

async function github(fetch, pathname, credential, init = {}) {
  const response = await fetch(`${API}${pathname}`, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${credential}`,
      "user-agent": USER_AGENT,
      "x-github-api-version": "2022-11-28",
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = typeof body?.message === "string" ? `: ${body.message}` : "";
    throw new Error(`GitHub ${init.method ?? "GET"} ${pathname} returned HTTP ${response.status}${detail}`);
  }
  return body;
}

/** A cached or newly minted installation token limited to this repository. */
export async function agentSession(app, { fetch = globalThis.fetch, now = Date.now, cacheFile = defaultTokenCache() } = {}) {
  const cached = readTokenCache(cacheFile);
  if (
    cached?.appId === app.appId &&
    typeof cached.token === "string" &&
    Date.parse(cached.expiresAt) - now() > REFRESH_MARGIN_MS
  ) {
    return cached;
  }
  const reusable = cached?.appId === app.appId ? cached : null;
  const jwt = githubAppJwt(app.appId, app.privateKey, now());
  const installationId =
    app.installationId ??
    reusable?.installationId ??
    (await github(fetch, `/repos/${REPOSITORY}/installation`, jwt)).id;
  const minted = await github(fetch, `/app/installations/${installationId}/access_tokens`, jwt, {
    method: "POST",
    body: JSON.stringify({ repositories: [REPOSITORY.split("/")[1]] }),
  });
  const botUserId =
    app.botUserId ??
    reusable?.botUserId ??
    (await github(fetch, `/users/${encodeURIComponent(`${app.slug}[bot]`)}`, minted.token)).id;
  const session = {
    appId: app.appId,
    slug: app.slug,
    installationId,
    botUserId,
    token: minted.token,
    expiresAt: minted.expires_at,
  };
  writeTokenCache(cacheFile, session);
  return session;
}

/** git as the bot: its identity for new commits and its token for the remote.
 * Conductor's git wrapper only brokers the owner's credentials, so this calls
 * the git it wraps. */
export function gitInvocation(args, session, env = process.env) {
  const { name, email } = agentIdentity(session.slug, session.botUserId);
  return {
    command: env.CONDUCTOR_REAL_GIT_PATH || "git",
    // The empty value drops every helper configured before it (including a
    // workspace broker that would answer with the owner's token).
    args: ["-c", "credential.helper=", "-c", `credential.https://github.com.helper=${CREDENTIAL_HELPER}`, ...args],
    env: {
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: email,
      [TOKEN_ENV]: session.token,
    },
  };
}

/** gh as the bot. Conductor's gh wrapper substitutes the workspace owner's
 * token, so this calls the CLI it wraps. */
export function ghInvocation(args, session, env = process.env) {
  return {
    command: env.CONDUCTOR_REAL_GH_PATH || "gh",
    args,
    env: { GH_TOKEN: session.token, GH_PROMPT_DISABLED: "1" },
  };
}

async function main(argv = process.argv.slice(2)) {
  const [mode, ...args] = argv;
  if (!["git", "gh", "check"].includes(mode)) {
    console.error("usage: node scripts/agent-github.mjs git <args…> | gh <args…> | check");
    process.exitCode = 2;
    return;
  }
  const app = readAgentApp();
  if (!app) {
    console.error("zeros-agent: no GitHub App credentials on this machine; see AGENTS.md (Agent credentials)");
    process.exitCode = 1;
    return;
  }
  const session = await agentSession(app);
  if (mode === "check") {
    const { repositories } = await github(globalThis.fetch, "/installation/repositories", session.token);
    const { name } = agentIdentity(session.slug, session.botUserId);
    console.log(
      `zeros-agent: ${name} can reach ${repositories.map((repository) => repository.full_name).join(", ")} (token cached until ${session.expiresAt})`,
    );
    return;
  }
  const invocation = mode === "git" ? gitInvocation(args, session) : ghInvocation(args, session);
  const result = spawnSync(invocation.command, invocation.args, {
    stdio: "inherit",
    env: { ...process.env, ...invocation.env },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(`zeros-agent: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
