#!/usr/bin/env node
// ──────────────────────────────────────────────────────────
// check-web-deploy — did the tip of origin/main actually reach zeros.build?
// ──────────────────────────────────────────────────────────
//
// The obvious canary (diff the /assets/index-<hash>.js on zeros.build) is WRONG
// and has already misled us once: Vite hashes bundle CONTENT, so any commit that
// touches no file under apps/web or apps/marketing produces a byte-identical bundle — the hash
// stays put even after a perfect deploy. It also can't distinguish zeros-web from
// the leftover `zeros` Pages project, which builds the same marketing source.
//
// So ask the deploy system instead of the artifact. Two independent signals:
//
//   1. GitHub check run "Cloudflare Pages: zeros-web" on the origin/main tip.
//      Needs only `gh` (already authenticated) — NO Cloudflare secret.
//   2. The Cloudflare canonical_deployment — the deployment actually serving
//      zeros.build / www.zeros.build / app.zeros.build. Authoritative, but needs
//      CLOUDFLARE_API_TOKEN. Skipped with a note when the token is absent.
//
// Signal 1 alone answers "did it build?". Signal 2 answers "is it live?".
// Exit 1 only when a signal positively contradicts origin/main.
//
//   pnpm check:web-deploy
//   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… pnpm check:web-deploy
//                                                     # adds the live check
// ──────────────────────────────────────────────────────────

import { execFileSync } from "node:child_process";

const PROJECT = process.env.CF_PAGES_PROJECT || "zeros-web";
const ACCOUNT = (process.env.CLOUDFLARE_ACCOUNT_ID || "").trim();
const CHECK_NAME = `Cloudflare Pages: ${PROJECT}`;

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

/** origin/main tip, refreshed when the network allows (a stale ref lies). */
function targetSha() {
  try {
    execFileSync("git", ["fetch", "origin", "main", "--quiet"], {
      stdio: "ignore",
    });
  } catch {
    console.log(
      "ℹ  offline or fetch blocked — comparing against the local origin/main ref.",
    );
  }
  return git("rev-parse", "origin/main");
}

function repoSlug() {
  const url = git("remote", "get-url", "origin");
  const m = url.match(/github\.com[:/]+(.+?)(?:\.git)?$/);
  if (!m) throw new Error(`origin is not a GitHub remote: ${url}`);
  return m[1];
}

// ── Signal 1: the GitHub check run ────────────────────────
function githubCheck(slug, sha) {
  let raw;
  try {
    raw = execFileSync(
      "gh",
      ["api", `repos/${slug}/commits/${sha}/check-runs`],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (e) {
    const why = String(e.stderr || e.message);
    if (/not found|command not found|ENOENT/i.test(why))
      return {
        state: "unavailable",
        note: "`gh` CLI not installed — see cli.github.com",
      };
    if (/auth|401|403/i.test(why))
      return {
        state: "unavailable",
        note: "`gh` is not authenticated — run `gh auth login`",
      };
    return { state: "unavailable", note: why.split("\n")[0] };
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return {
      state: "unavailable",
      note: "GitHub CLI returned no usable API response — authenticate `gh` and retry",
    };
  }

  const run = (payload.check_runs || []).find(
    (r) => r.name === CHECK_NAME,
  );
  if (!run)
    return {
      state: "missing",
      note: `no "${CHECK_NAME}" check on this commit — Cloudflare may not have picked it up`,
    };
  if (run.status !== "completed")
    return { state: "building", note: `status: ${run.status}` };
  return {
    state: run.conclusion === "success" ? "ok" : "failed",
    note: `conclusion: ${run.conclusion}`,
  };
}

// ── Signal 2: what Cloudflare is actually serving ─────────
async function cloudflareLive(sha) {
  const token = (process.env.CLOUDFLARE_API_TOKEN || "").trim();
  if (!token)
    return {
      state: "skipped",
      note: "CLOUDFLARE_API_TOKEN not set — build status checked, live status not.",
    };
  if (!ACCOUNT)
    return {
      state: "unavailable",
      note: "CLOUDFLARE_ACCOUNT_ID not set — live status not checked.",
    };

  let body;
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/pages/projects/${PROJECT}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(20_000),
      },
    );
    body = await res.json();
  } catch (e) {
    return {
      state: "unavailable",
      note: `Cloudflare API unreachable: ${e.message}`,
    };
  }

  if (!body?.success) {
    const msg =
      (body?.errors || []).map((x) => x.message).join("; ") ||
      "unknown API error";
    // The failure that actually bit us: a shell-expanded token arrives as "Bearer ".
    const hint = /invalid|authentication|10000/i.test(msg)
      ? " — token rejected. Check for a stray `$` in front of a pasted token (the shell expands it to nothing)."
      : "";
    return { state: "unavailable", note: `${msg}${hint}` };
  }

  const dep = body.result?.canonical_deployment;
  if (!dep)
    return {
      state: "unavailable",
      note: "project has no canonical deployment yet",
    };

  const live = (dep.deployment_trigger?.metadata?.commit_hash || "").trim();
  if (live.length < 8)
    return {
      state: "unavailable",
      note: "deployment carries no commit hash to compare",
    };

  // Prefix-compare: Cloudflare returns the full hash, git may be abbreviated.
  // Guarded above on length — "" is a prefix of everything and would false-pass.
  const n = Math.min(live.length, sha.length);
  return {
    state: live.slice(0, n) === sha.slice(0, n) ? "ok" : "stale",
    note: `${dep.environment} · ${live.slice(0, 8)} · ${dep.created_on}`,
    aliases: dep.aliases || [],
  };
}

// ── Report ────────────────────────────────────────────────
const sha = targetSha();
const slug = repoSlug();
console.log(`  ${slug}  origin/main @ ${sha.slice(0, 8)}\n`);

const build = githubCheck(slug, sha);
const live = await cloudflareLive(sha);

const ICON = {
  ok: "✓",
  stale: "✗",
  failed: "✗",
  missing: "✗",
  building: "…",
  skipped: "ℹ",
  unavailable: "ℹ",
};
console.log(
  `  ${ICON[build.state]} build   ${build.state.padEnd(12)} ${build.note}`,
);
console.log(
  `  ${ICON[live.state]} live    ${live.state.padEnd(12)} ${live.note}`,
);
if (live.state === "ok" && live.aliases?.length)
  console.log(`             serving      ${live.aliases.join(", ")}`);

const bad = ["stale", "failed", "missing"];
if (bad.includes(build.state) || bad.includes(live.state)) {
  console.error(
    `\n✗ check:web-deploy — origin/main is NOT fully deployed. ` +
      `Open the project at dash.cloudflare.com → Workers & Pages → ${PROJECT}.`,
  );
  process.exit(1);
}
if (build.state === "building") {
  console.log(
    `\n…  check:web-deploy — Cloudflare is still building ${sha.slice(0, 8)}. Re-run shortly.`,
  );
  process.exit(0);
}
// Only claim "serving" when the live signal actually confirmed it. A green build
// proves Cloudflare compiled the commit, NOT that it is the deployment on the
// custom domains — overstating that is the exact mistake this script exists to stop.
if (live.state === "ok") {
  console.log(
    `\n✓ check:web-deploy — ${PROJECT} is serving origin/main (${sha.slice(0, 8)}).`,
  );
} else if (build.state === "ok") {
  console.log(
    `\n✓ check:web-deploy — ${PROJECT} built origin/main (${sha.slice(0, 8)}) successfully.\n` +
      `   Live status unverified (${live.note}) — set CLOUDFLARE_API_TOKEN to confirm what zeros.build is actually serving.`,
  );
} else {
  console.log(
    `\nℹ check:web-deploy — deployment status is unverified for origin/main (${sha.slice(0, 8)}).\n` +
      `   Build signal: ${build.note}\n` +
      `   Live signal: ${live.note}`,
  );
}
