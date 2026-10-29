#!/usr/bin/env node
// Version strings cannot prove that the pinned binary boots or speaks the
// engine's protocol. Use the real resolver and app-server handshake; PATH
// fallback does not qualify a bundled artifact. Packaging remains a separate check.
// model/list is the binary's credential-free authority: unreadable or empty
// answers fail, while an unreachable request is explicitly inconclusive.
// No prompt is sent; live turns belong to agents:smoke.

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP_DIR = path.join(ROOT, ".zeros", "codex-smoke");
const ENTRY = "apps/desktop/src/engine/agents/adapters/codex/app-server.ts";

function die(msg, detail) {
  console.error(`\n✗ FAIL — ${msg}`);
  if (detail)
    console.error(
      String(detail)
        .split("\n")
        .map((l) => `    ${l}`)
        .join("\n"),
    );
  process.exit(1);
}

/** Initialize before asynchronous error handlers can read it. */
const stderrLines = [];

// A child that exits before handshake can fail writes asynchronously with
// EPIPE, outside boot's try/catch. Report that as a binary/handshake failure.
for (const signal of ["uncaughtException", "unhandledRejection"]) {
  process.on(signal, (err) => {
    const msg = err?.message ?? String(err);
    if (err?.code === "EPIPE" || /EPIPE|write after end/i.test(msg)) {
      die(
        "the codex process died before the app-server handshake completed — " +
          "it spawned, but it is not a working codex for this platform.",
        `${msg}${stderrLines.length ? `\n--- codex stderr ---\n${stderrLines.join("\n")}` : ""}`,
      );
    }
    die(`unexpected ${signal} while booting codex`, err?.stack ?? msg);
  });
}

/** The @openai/codex version actually installed — the thing the running binary
 *  must agree with. Read through the filesystem, not require("<pkg>/package.json"):
 *  the day OpenAI adds an exports map, the require form throws
 *  ERR_PACKAGE_PATH_NOT_EXPORTED and this gate would die naming the wrong cause
 *  (the same trap check-runtime-pins.mjs documents). */
function installedCodexVersion() {
  const pkg = path.join(
    ROOT,
    "node_modules",
    "@openai",
    "codex",
    "package.json",
  );
  if (!fs.existsSync(pkg)) {
    die(
      "@openai/codex is not installed — run `pnpm install --frozen-lockfile`.",
      `looked for ${pkg}`,
    );
  }
  return JSON.parse(fs.readFileSync(pkg, "utf-8")).version;
}

// Compile the shipping runtime so the smoke exercises its protocol and resolver.
// CJS and a repository-local output preserve the engine's require.resolve behavior.
async function loadAppServer() {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const outfile = path.join(TMP_DIR, "app-server.cjs");
  await build({
    entryPoints: [path.join(ROOT, ENTRY)],
    outfile,
    format: "cjs",
    platform: "node",
    target: "node20",
    bundle: true,
    external: ["node:*"],
  });
  return createRequire(path.join(TMP_DIR, "loader.cjs"))(outfile);
}

const expected = installedCodexVersion();
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-codex-smoke-"));
// Keep this credential-free probe's state in scratch. The runtime preserves
// ambient CODEX_HOME, so set it before boot rather than as a rejected child override.
const codexHome = path.join(cwd, "codex-home");
fs.mkdirSync(codexHome, { recursive: true });
process.env.CODEX_HOME = codexHome;

console.log(`▸ entry:    ${ENTRY}`);
console.log(`▸ expected: codex ${expected} (installed @openai/codex)`);
console.log(`▸ cwd:      ${cwd}\n`);

let mod;
try {
  mod = await loadAppServer();
} catch (err) {
  die("could not compile the codex app-server module", err?.message ?? err);
}
if (typeof mod.bootCodexAppServerRuntime !== "function") {
  die(
    `${ENTRY} no longer exports bootCodexAppServerRuntime — update this gate.`,
  );
}

let handle;
try {
  handle = await mod.bootCodexAppServerRuntime({
    cwd,
    clientInfo: { name: "zeros-codex-smoke", version: "0.0.0" },
    onStderr: (line) => stderrLines.push(line),
    logTag: "codex-smoke",
  });
} catch (err) {
  die(
    "codex app-server did not boot — the pinned binary is missing, unspawnable, " +
      "or no longer speaks the protocol the committed bindings expect.",
    `${err?.message ?? err}${stderrLines.length ? `\n--- codex stderr ---\n${stderrLines.join("\n")}` : ""}`,
  );
}

const problems = [];
if (!handle.initializeResponse) {
  problems.push("initialize returned no response object");
}
if (handle.binarySource?.source === "fallback") {
  // PATH fallback cannot certify the pinned platform dependency.
  problems.push(
    "resolved codex from PATH, not the bundled @openai/codex. The platform " +
      "package (@openai/codex-<os>-<arch>) failed to install — an os/cpu-gated " +
      "optional dep, so check it exists for THIS runner's platform.",
  );
}
if (!handle.cliVersion) {
  problems.push(
    `could not parse a CLI version from initialize's userAgent ` +
      `(${JSON.stringify(handle.initializeResponse?.userAgent ?? null)}) — ` +
      `the version check inside bootCodexAppServerRuntime is running blind`,
  );
} else if (handle.cliVersion !== expected) {
  problems.push(
    `the RUNNING codex is ${handle.cliVersion}, but @openai/codex ${expected} is installed. ` +
      `A stale PATH codex is shadowing the bundled one, or the platform package ` +
      `(@openai/codex-<os>-<arch>) failed to install and the wrapper fell through.`,
  );
}

console.log(
  `▸ resolved: ${handle.binarySource?.path} (${handle.binarySource?.source})`,
);
console.log(`▸ reported: codex ${handle.cliVersion ?? "unknown"}`);
console.log(`▸ userAgent: ${handle.initializeResponse?.userAgent ?? "(none)"}`);

// Hidden models can still resolve. Distinguish an unreadable curated catalog
// (null) from a confirmed empty one; neither may silently pass.
const curatedCodex = (() => {
  try {
    const cat = JSON.parse(
      fs.readFileSync(path.join(ROOT, "catalogs", "models-v1.json"), "utf-8"),
    );
    return (cat.families?.codex ?? []).map((m) => m.value).filter(Boolean);
  } catch (err) {
    problems.push(
      `could not read catalogs/models-v1.json: ${err?.message ?? err}`,
    );
    return null;
  }
})();

let liveIds = null;
try {
  const res = await handle.request(
    "model/list",
    { includeHidden: true },
    { timeoutMs: 20_000 },
  );
  // A successful RPC with an unreadable shape is protocol drift, not a skipped check.
  if (!Array.isArray(res?.data)) {
    problems.push(
      `model/list answered, but with no \`data\` array (got ${JSON.stringify(res)?.slice(0, 160) ?? "undefined"}) — ` +
        "the response shape changed, so the curated-id check has nothing to compare against.",
    );
  } else {
    const ids = res.data.map((m) => m?.id).filter(Boolean);
    if (ids.length > 0) {
      liveIds = new Set(ids);
    } else {
      // An empty credential-free catalog verifies no curated IDs and must fail.
      // If the provider starts requiring auth, qualify that change explicitly.
      problems.push(
        "model/list returned an empty list. The pinned binary is expected to report its " +
          "catalog WITHOUT credentials, so this contradicts every curated id at once rather " +
          "than confirming any. If codex now requires auth for model/list, give this gate a " +
          "credential — do not downgrade it to a skip.",
      );
    }
  }
} catch (err) {
  // An unreachable request is inconclusive; a received answer must satisfy the
  // shape and nonempty checks above. Do not report every model as retired.
  console.log(
    `▸ models:   model/list unavailable (${String(err?.message ?? err).slice(0, 90)}) — id check SKIPPED`,
  );
}

// Empty curated input is a failure even when the live catalog is healthy.
if (curatedCodex?.length === 0) {
  problems.push(
    "catalogs/models-v1.json lists no codex models — the id check ran against nothing.",
  );
}

if (liveIds) {
  console.log(
    `▸ models:   ${liveIds.size} offered by the pinned binary, checking ` +
      (curatedCodex
        ? `${curatedCodex.length} curated id(s)`
        : "nothing (catalog unreadable)"),
  );
  for (const id of curatedCodex ?? []) {
    if (!liveIds.has(id)) {
      problems.push(
        `curated codex model "${id}" is NOT offered by codex ${handle.cliVersion} ` +
          `(model/list returned: ${[...liveIds].join(", ")}). Nothing enforces the id at ` +
          `runtime, so the picker will still offer it and codex will silently substitute ` +
          `another model. Either it was retired (drop it from catalogs/models-v1.json, ` +
          `with its aliases and defaultFavorites) or renamed (update the id).`,
      );
    }
  }
}

try {
  await handle.dispose();
} catch {
  /* the assertions above are what matter; teardown is best-effort */
}
try {
  fs.rmSync(cwd, { recursive: true, force: true });
} catch {
  /* A cleanup failure must not replace the probe verdict. */
}

if (problems.length > 0) {
  console.error("\n✗ FAIL — codex booted but does not match the pin:");
  for (const p of problems) console.error(`    ${p}`);
  process.exit(1);
}

console.log(
  `\n✓ PASS — codex ${handle.cliVersion} booted, completed the app-server`,
);
console.log("  initialize handshake, and matches the installed pin.");
process.exit(0);
