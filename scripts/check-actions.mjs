#!/usr/bin/env node
// ──────────────────────────────────────────────────────────
// check-actions — run actionlint over .github/workflows locally
// ──────────────────────────────────────────────────────────
//
// WHY THIS EXISTS: `.github/workflows/lint-ci.yml` runs actionlint in CI via a
// pinned Docker image, and there was NO local equivalent — so the only way to
// discover a broken workflow was to push and wait. That is how an SC2086
// (`printf ' %s' $KEEP_RUNS` — unquoted, relying on word-splitting) reached a PR:
// every local gate was green because none of them looked at the workflows.
//
// actionlint is not an npm package, so this resolves it in priority order:
//
//   1. `actionlint` already on PATH (brew install actionlint) — fastest.
//   2. Docker with the SAME image+tag CI uses, so a local pass means a CI pass.
//
// The version is READ OUT OF lint-ci.yml rather than duplicated here: a bump there
// must not silently leave this checking against an older linter.
//
// Not wired into `pnpm lint` or the release gates on purpose — it needs a binary or
// a Docker daemon, and a release must not fail because a runner lacks either. CI's
// lint-ci.yml remains the authoritative gate; this is the local pre-push shortcut.
//
// Run: `pnpm check:actions`
// ──────────────────────────────────────────────────────────

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const WORKFLOW = ".github/workflows/lint-ci.yml";

/** The actionlint image+tag CI pins, e.g. "rhysd/actionlint:1.7.7". */
function ciImage() {
  let text;
  try {
    text = readFileSync(WORKFLOW, "utf8");
  } catch {
    fail(`cannot read ${WORKFLOW} — is this being run from the repo root?`);
  }
  const m = /uses:\s*docker:\/\/(rhysd\/actionlint:[^\s"']+)/.exec(text);
  if (!m) {
    fail(
      `no \`uses: docker://rhysd/actionlint:<tag>\` found in ${WORKFLOW}. ` +
        `If CI switched linters, update this script to match — otherwise a local ` +
        `pass would not mean a CI pass.`,
    );
  }
  return m[1];
}

function fail(msg) {
  console.error(`✖ check:actions — ${msg}`);
  process.exit(1);
}

const has = (cmd) =>
  spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0;

const image = ciImage();
const passthrough = process.argv.slice(2);
let res;
let how;

if (has("actionlint")) {
  how = "actionlint on PATH";
  res = spawnSync("actionlint", ["-color", ...passthrough], { stdio: "inherit" });
} else if (spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0) {
  how = `docker ${image}`;
  res = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "-v",
      `${process.cwd()}:/repo`,
      "--workdir",
      "/repo",
      image,
      "-color",
      ...passthrough,
    ],
    { stdio: "inherit" },
  );
} else {
  fail(
    `actionlint is not installed and Docker is not running, so workflow lint was ` +
      `NOT checked. Install one:\n` +
      `    brew install actionlint          # fastest\n` +
      `    # or start Docker; this script then uses ${image}, exactly as CI does\n` +
      `  Skipping silently would hand you a false pass — CI's lint-ci.yml still runs.`,
  );
}

if (res.status !== 0) {
  console.error(
    `\n✖ check:actions — actionlint found problems (via ${how}). ` +
      `These fail lint-ci.yml too.`,
  );
  process.exit(res.status ?? 1);
}
console.log(`✓ check:actions — .github/workflows clean (via ${how})`);
