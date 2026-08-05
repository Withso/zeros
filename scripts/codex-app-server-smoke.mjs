#!/usr/bin/env node
// ──────────────────────────────────────────────────────────
// codex-app-server-smoke — "does the pinned codex binary actually run?"
// ──────────────────────────────────────────────────────────
//
// Boots the REAL `codex app-server` through the engine's own
// `bootCodexAppServerRuntime`, completes the initialize handshake, and asserts
// the running binary is the one we pinned. Needs NO credentials: `initialize`
// is a local stdio protocol exchange, so this runs on every PR.
//
// WHY THIS EXISTS
// `check:codex-pin` compares three version STRINGS (installed @openai/codex ↔
// package.json#codexProtocolVersion ↔ the committed bindings' .version). It is
// pure arithmetic on numbers — it never touches the artifact. So every one of
// these ships green:
//
//   • the platform package (@openai/codex-<os>-<arch>) is missing, so the
//     wrapper falls through to a PATH `codex` that isn't there, or IS there and
//     is some other version entirely;
//   • the binary stages but cannot exec (wrong arch, lost +x, corrupt);
//   • the app-server handshake regressed, or the CLI dropped below
//     MIN_CLI_VERSION, so the committed v2 bindings no longer match the wire.
//
// That is the same hole `check:runtime-pins` closed for Claude by EXECUTING
// `claude --version`. Codex had no equivalent. This is it — and it proves more
// than `--version` does, because it drives the actual protocol.
//
// WHAT IT PROVES
//   1. The binary RESOLVES (via the engine's own resolveCodexBinary cascade,
//      not a hand-rolled path) and is spawnable on this platform.
//   2. `initialize` completes inside the runtime's own 15s budget, and the
//      `initialized` notification is accepted — i.e. the app-server protocol
//      the committed bindings were generated from is the one being spoken.
//   3. The CLI version the SERVER reports equals the @openai/codex version
//      installed in node_modules. A staged-but-wrong binary fails here.
//   4. Boot also enforces MIN_CLI_VERSION internally, so a CLI below 0.131.0
//      throws rather than half-working.
//   5. Every curated codex model id in catalogs/models-v1.json is one the
//      pinned binary actually offers, asked over `model/list`.
//
// ON (5) — WHY HERE, AND WHY IT IS NOT A STRING SCAN
// models-verify.mjs gates retired model ids for Claude by scanning the CLI
// binary's string table, and its own comment explains why that technique does
// not port to Codex: the native Rust binary packs ids contiguously
// (`gpt-5.2-codexgpt-5.2-codex`), so set membership is unreliable. But the
// app-server exposes `model/list`, which is the binary's OWN authoritative
// answer — strictly better than scraping strings, and it needs no credentials.
// The server is already booted here, so this costs one extra request rather
// than a second 5-second boot in CI.
//
// The failure it catches: retiring a model id bumps no version number, so
// nothing can compare against a threshold. The picker keeps offering the dead
// id and codex silently substitutes another model.
//
// "It needs no credentials" is a CONTRACT here, not an aside: because the binary
// answers `model/list` unauthenticated, an empty or unreadable answer can only
// mean something broke, so both are hard failures rather than skips. Only a
// request that never landed is treated as inconclusive.
//
// It is deliberately NOT a prompt test: no auth, no tokens, no network, no
// model. `agents:smoke` is where live turns belong.
//
// ── WHAT THIS DOES *NOT* PROVE — read before trusting it ──
// It proves the PIN is good, not that the packaged app uses the pin. Per
// codex/binary-resolver.ts, the packaged engine is a `bun build --compile`
// single-file binary with no node_modules on disk, so its `require.resolve`
// tier cannot fire and it falls through to whatever `codex` is on the user's
// PATH — a different, unpinned CLI. The tier that would fix that
// (ZEROS_CODEX_CLI_PATH) exists but is wired to nothing: there is no
// stage-codex-cli.mjs, and apps/desktop/electron/sidecar.ts forwards only the Claude pair.
// This gate runs in a source checkout, so it exercises the BUNDLED tier — the
// one dev uses. Point ZEROS_CODEX_CLI_PATH at a staged binary to check the
// packaged one (the resolver's comment reserves that tier for exactly this).
//
// Resolving via PATH is therefore treated as a FAILURE here, not a pass: in a
// source checkout it means the @openai/codex platform package did not install,
// which is precisely the drift this gate exists to catch.
//
// Run: `pnpm codex:smoke`.  Exit 0 = the pinned codex boots and matches.
// ──────────────────────────────────────────────────────────

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
  if (detail) console.error(String(detail).split("\n").map((l) => `    ${l}`).join("\n"));
  process.exit(1);
}

/** Declared before the handlers below, which read it — a `const` referenced
 *  from a handler that can fire at any time must not be in its own TDZ. */
const stderrLines = [];

// A binary that spawns but dies before the handshake (wrong arch, a stub, a
// non-codex executable) kills the stdio pipe, and the engine's write lands as
// an ASYNCHRONOUS EPIPE — outside the try/catch around boot. Unhandled, that
// exits with a raw node:internal stack whose top frame is a stream teardown:
// a CI failure that names the wrong cause, which is the exact anti-pattern
// these gates are supposed to avoid. Convert both channels into the real one.
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
  const pkg = path.join(ROOT, "node_modules", "@openai", "codex", "package.json");
  if (!fs.existsSync(pkg)) {
    die(
      "@openai/codex is not installed — run `pnpm install --frozen-lockfile`.",
      `looked for ${pkg}`,
    );
  }
  return JSON.parse(fs.readFileSync(pkg, "utf-8")).version;
}

// Compile the engine's real app-server module rather than reimplementing the
// handshake here: a smoke that speaks its own dialect of the protocol proves
// nothing about the code that ships. CJS on purpose — binary-resolver.ts
// resolves the platform package with `require.resolve` (the engine is bundled
// to CJS by tsup), which does not exist in an ESM bundle. Emitting into the
// repo keeps that resolution anchored at the repo's own node_modules.
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
  die(`${ENTRY} no longer exports bootCodexAppServerRuntime — update this gate.`);
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
  // The resolver's last tier is the literal string "codex", left to PATH. In a
  // source checkout that can only mean the bundled dep is gone — and whatever
  // answered is by definition not the version we pinned.
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

console.log(`▸ resolved: ${handle.binarySource?.path} (${handle.binarySource?.source})`);
console.log(`▸ reported: codex ${handle.cliVersion ?? "unknown"}`);
console.log(`▸ userAgent: ${handle.initializeResponse?.userAgent ?? "(none)"}`);

// ── Curated model ids exist in the pinned binary ───────────
// `includeHidden` on purpose: a model can be pulled from the default picker
// while still being perfectly usable, and we only care whether the id RESOLVES.
// Flagging a hidden-but-working model as retired would be a false red.
//
// `null` (not `[]`) when the catalog is unreadable, so "we could not look" stays
// distinguishable from "we looked and it is empty" — both are failures, but they
// must not report as each other, and the unreadable case already has its own
// problem line.
const curatedCodex = (() => {
  try {
    const cat = JSON.parse(
      fs.readFileSync(path.join(ROOT, "catalogs", "models-v1.json"), "utf-8"),
    );
    return (cat.families?.codex ?? []).map((m) => m.value).filter(Boolean);
  } catch (err) {
    problems.push(`could not read catalogs/models-v1.json: ${err?.message ?? err}`);
    return null;
  }
})();

let liveIds = null;
try {
  const res = await handle.request("model/list", { includeHidden: true }, { timeoutMs: 20_000 });
  // An ANSWER we cannot read is drift, not a blip. `model/list` is the binary's
  // authoritative RPC, so a missing `data` array means the response shape moved
  // under us — precisely the protocol regression this gate exists to catch. The
  // old `res?.data ?? []` collapsed that into the same silent no-op as an empty
  // list, which would have left the curated-id check permanently vacuous with
  // one SKIPPED line as the only trace. cursor-host-smoke.mjs already treats an
  // unusable models.list result as a problem; this matches it.
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
      // STRICT on purpose. The pinned binary reports its whole catalog with no
      // credentials, so `data: []` is not "nothing to report" — it CONTRADICTS
      // every curated id at once, and there is no reading of it under which the
      // comparison below has done its job. Passing here would leave the gate
      // green forever while checking nothing, which is the exact failure this
      // section exists to prevent.
      //
      // The one benign cause is codex starting to require auth for `model/list`.
      // That is a real change, and worth one red build: fix it by giving this
      // step a credential, not by softening this back to a skip.
      problems.push(
        "model/list returned an empty list. The pinned binary is expected to report its " +
          "catalog WITHOUT credentials, so this contradicts every curated id at once rather " +
          "than confirming any. If codex now requires auth for model/list, give this gate a " +
          "credential — do not downgrade it to a skip.",
      );
    }
  }
} catch (err) {
  // Inconclusive, not failed: an unreachable model/list must not turn CI red on
  // every curated model at once. Same discipline as models-verify's
  // MIN_PLAUSIBLE_IDS guard — report the scan is broken, don't report 4 removals.
  //
  // This is the ONLY skip left, and the asymmetry is deliberate: a request that
  // never landed is a blip, while one that ANSWERED is held to its answer (both
  // branches above are hard failures). Do not "even these out".
  console.log(`▸ models:   model/list unavailable (${String(err?.message ?? err).slice(0, 90)}) — id check SKIPPED`);
}

// UNCONDITIONAL, and deliberately not an `else` arm of the check below: an empty
// curated list means the comparison compares nothing no matter what model/list
// answered. Guarded on `!liveIds` this could only fire when the check had ALREADY
// been skipped — so the normal case (model/list healthy, `families.codex` emptied
// or its `value` key renamed) printed an id count and exited 0.
if (curatedCodex?.length === 0) {
  problems.push("catalogs/models-v1.json lists no codex models — the id check ran against nothing.");
}

if (liveIds) {
  console.log(
    `▸ models:   ${liveIds.size} offered by the pinned binary, checking ` +
      (curatedCodex ? `${curatedCodex.length} curated id(s)` : "nothing (catalog unreadable)"),
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
  /* temp dir */
}

if (problems.length > 0) {
  console.error("\n✗ FAIL — codex booted but does not match the pin:");
  for (const p of problems) console.error(`    ${p}`);
  process.exit(1);
}

console.log(`\n✓ PASS — codex ${handle.cliVersion} booted, completed the app-server`);
console.log("  initialize handshake, and matches the installed pin.");
process.exit(0);
