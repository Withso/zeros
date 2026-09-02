#!/usr/bin/env node
// Verify that the selected commit is the exact revision served by every
// selected Cloudflare Pages custom domain. Pages does not publish dependable
// GitHub check runs for these monorepo projects, so each build emits a small,
// non-secret manifest from Cloudflare's injected CF_PAGES_COMMIT_SHA.
//
// Defaults qualify both Alpha web surfaces from main:
//   pnpm check:web-deploy
//
// Select one project for Beta/Production or an individual investigation:
//   CF_PAGES_PROJECT=zeros-web-beta WEB_DEPLOY_REF=origin/release/1.2.3 pnpm check:web-deploy
//   CF_PAGES_PROJECT=zeros-web WEB_DEPLOY_REF=origin/release/1.2.3 pnpm check:web-deploy
//
// Arbitrary projects require an explicit public origin:
//   CF_PAGES_PROJECT=my-project WEB_DEPLOY_ORIGIN=https://example.com pnpm check:web-deploy
//
// CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID optionally add a direct
// canonical-deployment comparison. The public manifest remains the required
// custom-domain proof and needs no long-lived Cloudflare credential.

import { execFileSync } from "node:child_process";

const TARGET_REF = process.env.WEB_DEPLOY_REF || "origin/main";
const ACCOUNT = (process.env.CLOUDFLARE_ACCOUNT_ID || "").trim();
const MANIFEST_PATH = "/zeros-deployment.json";

const PROJECT_ORIGINS = Object.freeze({
  "zeros-web-alpha": "https://app-alpha.zeros.build",
  "zeros-ops-alpha": "https://ops-alpha.zeros.build",
  "zeros-web-beta": "https://app-beta.zeros.build",
  "zeros-web": "https://app.zeros.build",
  "zeros-ops": "https://ops.zeros.build",
});

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function targetSha() {
  const remoteBranch = /^origin\/(.+)$/.exec(TARGET_REF)?.[1];
  try {
    if (remoteBranch) {
      execFileSync("git", ["fetch", "origin", remoteBranch, "--quiet"], {
        stdio: "ignore",
      });
    }
  } catch {
    console.log(
      `ℹ  offline or fetch blocked — comparing against local ${TARGET_REF}.`,
    );
  }
  return git("rev-parse", TARGET_REF);
}

function repoSlug() {
  const url = git("remote", "get-url", "origin");
  const match = url.match(/github\.com[:/]+(.+?)(?:\.git)?$/);
  if (!match) throw new Error(`origin is not a GitHub remote: ${url}`);
  return match[1];
}

function selectedTargets() {
  const explicit = (process.env.CF_PAGES_PROJECT || "").trim();
  const projects = explicit
    ? [explicit]
    : ["zeros-web-alpha", "zeros-ops-alpha"];
  const originOverride = (process.env.WEB_DEPLOY_ORIGIN || "")
    .trim()
    .replace(/\/$/, "");

  return projects.map((project) => {
    const origin = originOverride || PROJECT_ORIGINS[project];
    if (!origin) {
      throw new Error(
        `No public origin is known for ${project}; set WEB_DEPLOY_ORIGIN.`,
      );
    }
    return {
      project,
      origin,
      surface: project.includes("ops") ? "ops" : "app",
    };
  });
}

function sameCommit(actual, expected) {
  if (!/^[a-f0-9]{40}$/i.test(actual) || !/^[a-f0-9]{40}$/i.test(expected)) {
    return false;
  }
  return actual.toLowerCase() === expected.toLowerCase();
}

async function publicManifest(target, sha) {
  const url = `${target.origin}${MANIFEST_PATH}?expected=${sha}`;
  let response;
  let body;
  try {
    response = await fetch(url, {
      cache: "no-store",
      headers: { Accept: "application/json", "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(20_000),
    });
    body = await response.json();
  } catch (error) {
    return {
      state: "unavailable",
      note: `${target.origin} manifest unavailable: ${error.message}`,
    };
  }

  if (!response.ok) {
    return {
      state: "unavailable",
      note: `${target.origin} manifest returned HTTP ${response.status}`,
    };
  }
  if (body?.version !== 1 || body?.surface !== target.surface) {
    return {
      state: "failed",
      note: `${target.origin} returned an invalid ${target.surface} manifest`,
    };
  }
  return {
    state: sameCommit(body.commitSha, sha) ? "ok" : "stale",
    note: `${target.origin} · ${body.surface} · ${String(body.commitSha).slice(0, 8)}`,
  };
}

async function cloudflareCanonical(target, sha) {
  const token = (process.env.CLOUDFLARE_API_TOKEN || "").trim();
  if (!token || !ACCOUNT) {
    return {
      state: "skipped",
      note: "API check skipped (set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID to enable)",
    };
  }

  let body;
  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/pages/projects/${target.project}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(20_000),
      },
    );
    body = await response.json();
  } catch (error) {
    return { state: "unavailable", note: `Cloudflare API: ${error.message}` };
  }

  if (!body?.success) {
    const message =
      (body?.errors || []).map((entry) => entry.message).join("; ") ||
      "unknown API error";
    return { state: "unavailable", note: `Cloudflare API: ${message}` };
  }

  const deployment = body.result?.canonical_deployment;
  const live = String(
    deployment?.deployment_trigger?.metadata?.commit_hash || "",
  ).trim();
  if (!deployment || !/^[a-f0-9]{40}$/i.test(live)) {
    return {
      state: "unavailable",
      note: "Cloudflare canonical deployment carries no full commit SHA",
    };
  }
  return {
    state: sameCommit(live, sha) ? "ok" : "stale",
    note: `${deployment.environment} · ${live.slice(0, 8)} · ${deployment.created_on}`,
  };
}

const sha = targetSha();
const targets = selectedTargets();
console.log(`  ${repoSlug()}  ${TARGET_REF} @ ${sha.slice(0, 8)}\n`);

const results = await Promise.all(
  targets.map(async (target) => ({
    target,
    manifest: await publicManifest(target, sha),
    canonical: await cloudflareCanonical(target, sha),
  })),
);

const icon = {
  ok: "✓",
  stale: "✗",
  failed: "✗",
  skipped: "ℹ",
  unavailable: "✗",
};
for (const { target, manifest, canonical } of results) {
  console.log(`  ${target.project}`);
  console.log(
    `    ${icon[manifest.state]} public  ${manifest.state.padEnd(11)} ${manifest.note}`,
  );
  console.log(
    `    ${icon[canonical.state]} api     ${canonical.state.padEnd(11)} ${canonical.note}`,
  );
}

const manifestFailed = results.some(({ manifest }) => manifest.state !== "ok");
const apiContradicted = results.some(({ canonical }) =>
  ["stale", "failed"].includes(canonical.state),
);
if (manifestFailed || apiContradicted) {
  console.error(
    `\n✗ check:web-deploy — ${TARGET_REF} is not serving from every selected Pages project.`,
  );
  process.exit(1);
}

console.log(
  `\n✓ check:web-deploy — ${targets.map(({ project }) => project).join(" and ")} serve ${TARGET_REF} (${sha.slice(0, 8)}).`,
);
