#!/usr/bin/env node
// ──────────────────────────────────────────────────────────
// claude-cli-smoke — "can the Agent SDK actually launch the bundled claude?"
// ──────────────────────────────────────────────────────────
//
// Resolves the `claude` executable through the engine's OWN resolver
// (claude-sdk/binary-resolver.ts), then drives a real
// `@anthropic-ai/claude-agent-sdk` `query()` through it and asserts the turn
// dies on AUTH — not on binary resolution, not on a spawn/handshake failure.
//
// WHY THIS EXISTS
// `check:runtime-pins` execs `claude --version`, which proves the binary is
// present and runnable. It does NOT prove the SDK can drive it: `query()`
// spawns the CLI with its own control protocol, and that seam has already
// broken in production once. binary-resolver.ts's header documents the bug
// class in full — the SDK locates its ~245 MiB platform binary *relative to
// sdk.mjs's own on-disk location*, which works in dev (`bun apps/desktop/src/cli.ts`) and is
// IMPOSSIBLE in the packaged app (bun-compiled single-file engine: sdk.mjs
// lives in $bunfs, no node_modules on disk). Every send failed with an opaque
// "AGENT RESPONSE FAILURE", in Beta/Production only.
//
// WHAT IT PROVES
//   1. resolveClaudeCli() returns a path, from a PINNED tier (staged/bundled) —
//      resolving to the developer's own global install means the shipped
//      runtime is missing and the gate is measuring the wrong binary.
//   2. `query()` accepts that path, spawns the CLI, and completes the SDK↔CLI
//      handshake far enough to report a server-side auth rejection.
//   3. The failure is auth-shaped. A resolution/spawn/protocol failure —
//      "Native CLI binary ... not found", ENOENT, EACCES, a non-zero exit
//      before any response — fails this gate.
//
// COST: ZERO TOKENS, BY CONSTRUCTION.
// The key is deliberately invalid, so the first API call 401s before any
// inference. HOME is redirected to an empty temp dir so an ambient credential
// (~/.claude, a keychain-backed session on a dev machine) cannot silently
// authenticate the run and turn this into a real, billable turn. If the query
// nevertheless SUCCEEDS, that is treated as a FAILURE: it means credentials
// leaked in and the gate just spent money proving nothing.
//
// Run: `pnpm claude:smoke`.  Exit 0 = the SDK can launch the pinned CLI.
// ──────────────────────────────────────────────────────────

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP_DIR = path.join(ROOT, ".zeros", "claude-smoke");
const RESOLVER = "apps/desktop/src/engine/agents/adapters/claude-sdk/binary-resolver.ts";
const TIMEOUT_MS = 90_000;

/** Errors that mean the CLI never got far enough to be rejected by the server —
 *  i.e. exactly what this gate exists to catch. */
const LAUNCH_ERR_RX =
  /Native CLI binary|not found|ENOENT|EACCES|spawn\b|Permission denied|exited with code|no such file|cannot execute|Exec format error/i;
/** Errors that mean we DID reach the server and it said no. That is a pass. */
const AUTH_ERR_RX =
  /401|403|invalid.{0,20}api.?key|authentication|unauthorized|invalid.{0,20}token|credit balance|OAuth/i;

function die(msg, detail) {
  console.error(`\n✗ FAIL — ${msg}`);
  if (detail) {
    console.error(String(detail).split("\n").slice(0, 24).map((l) => `    ${l}`).join("\n"));
  }
  process.exit(1);
}

// Compile the engine's real resolver rather than reimplementing its tier order:
// a gate that resolves the binary its own way cannot catch the resolver
// regressing. CJS because binary-resolver.ts uses createRequire/require against
// the repo's node_modules; emitting into the repo keeps that anchored.
async function loadResolver() {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const outfile = path.join(TMP_DIR, "binary-resolver.cjs");
  await build({
    entryPoints: [path.join(ROOT, RESOLVER)],
    outfile,
    format: "cjs",
    platform: "node",
    target: "node20",
    bundle: true,
    external: ["node:*"],
  });
  return createRequire(path.join(TMP_DIR, "loader.cjs"))(outfile);
}

let resolver;
try {
  resolver = await loadResolver();
} catch (err) {
  die("could not compile the Claude binary resolver", err?.message ?? err);
}

const cli = resolver.resolveClaudeCli({});
if (!cli.path) {
  die(
    "resolveClaudeCli() found no `claude` executable — the platform package " +
      "(@anthropic-ai/claude-agent-sdk-<platform>-<arch>) did not install. It is an " +
      "os/cpu-gated optional dep, so confirm the variant for THIS runner exists.",
    resolver.claudeCliMissingMessage?.(),
  );
}
if (!resolver.isPinnedClaudeRuntime(cli.source)) {
  // "well-known"/"path" mean we found the developer's own Claude Code install.
  // Passing on that would certify a binary the app does not ship.
  die(
    `resolveClaudeCli() fell through to the "${cli.source}" tier (${cli.path}) — ` +
      "that is a locally-installed Claude Code, NOT the pinned runtime this app " +
      "bundles. The gate would be measuring the wrong binary.",
  );
}

console.log(`▸ resolved: ${cli.path}`);
console.log(`▸ tier:     ${cli.source} (pinned)`);

// An empty HOME is the token-safety interlock — see the header.
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-claude-smoke-home-"));
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-claude-smoke-"));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.CLAUDE_CONFIG_DIR = path.join(fakeHome, ".claude");
// Key-shaped, and low-entropy ON PURPOSE. check:secrets matches `sk-ant-`
// followed by a 20+ character body and clears the match only when that body has
// <= 2 distinct characters (its looksLikePlaceholder), so a *descriptive* fake
// key reads better and turns the gate red. Low entropy is the right lever here
// rather than excluding this file from the scan: an exclusion would also stop a
// REAL key pasted onto any other line in this file from being caught.
//
// Do NOT dress it up with the real api03 infix to look more authentic. A
// well-formed key is sent to the API and the turn then hangs past this gate's
// 90s budget (measured: >60s, no response); a malformed one is rejected in ~1s
// with the "Invalid API key" this gate asserts on. Fast and deterministic is the
// whole point — the key never has to be realistic, only rejected.
process.env.ANTHROPIC_API_KEY = "sk-ant-xxxxxxxxxxxxxxxxxxxxxxxx";
delete process.env.ANTHROPIC_AUTH_TOKEN;
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

console.log(`▸ home:     ${fakeHome} (empty — no ambient credentials)\n`);

const { query } = await import("@anthropic-ai/claude-agent-sdk");

const abort = new AbortController();
const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);

// Token safety is MEASURED, not assumed. The CLI reports an auth rejection by
// emitting an `assistant` message with `model: "<synthetic>"` — a local
// error-carrier, not model output — so "did an assistant message arrive" is the
// wrong question. `total_cost_usd` / `usage.output_tokens` from the result
// message answer the real one: they are 0 for a rejected turn and non-zero the
// moment inference actually happens.
let realInference = false;
let spend = { cost: 0, outputTokens: 0 };
let failure = null;
try {
  const q = query({
    prompt: "reply with the single word OK",
    options: {
      abortController: abort,
      cwd,
      maxTurns: 1,
      pathToClaudeCodeExecutable: cli.path,
    },
  });
  for await (const msg of q) {
    if (msg?.type === "assistant" && msg.message?.model && msg.message.model !== "<synthetic>") {
      realInference = true;
    }
    if (msg?.type === "result") {
      spend = {
        cost: msg.total_cost_usd ?? 0,
        outputTokens: msg.usage?.output_tokens ?? 0,
      };
      if (msg.is_error) failure = msg.result ?? msg.subtype ?? "(error result, no text)";
    }
  }
} catch (err) {
  // The SDK rethrows an error result as an exception once the stream ends, so
  // this is the normal path for a rejected turn — not an exceptional one.
  failure = err?.message ?? String(err);
}
clearTimeout(timer);
if (spend.cost > 0 || spend.outputTokens > 0) realInference = true;

for (const dir of [fakeHome, cwd]) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* temp dirs */
  }
}

if (realInference) {
  die(
    "the query actually RAN — real credentials reached the CLI despite the empty HOME " +
      "and invalid key, so this gate just spent money proving nothing. Unset ambient " +
      "Claude credentials, or run it in a clean environment.",
    `cost=$${spend.cost} output_tokens=${spend.outputTokens}`,
  );
}
if (!failure) {
  die("the query produced neither an error nor assistant output — the SDK↔CLI handshake did not complete.");
}
if (abort.signal.aborted) {
  die(
    `no response within ${TIMEOUT_MS}ms — the CLI spawned but never answered the SDK. ` +
      "That is a handshake failure, not an auth rejection.",
    failure,
  );
}

const oneLine = String(failure).replace(/\s+/g, " ").trim();
if (LAUNCH_ERR_RX.test(oneLine) && !AUTH_ERR_RX.test(oneLine)) {
  die(
    "the CLI could not be launched or died before reaching the server — this is the " +
      "packaged-build failure class this gate exists to catch, not an auth rejection.",
    oneLine,
  );
}
if (!AUTH_ERR_RX.test(oneLine)) {
  // Neither clearly auth nor clearly launch. Report rather than guess: a gate
  // that silently accepts unrecognised failures is a gate that stops failing.
  die(
    "the query failed, but not with a recognisable auth rejection. If this is a new " +
      "auth error shape, add it to AUTH_ERR_RX; if it is a launch failure, that is a real bug.",
    oneLine,
  );
}

console.log(`▸ rejected: ${oneLine.slice(0, 160)}`);
console.log(`▸ spend:    $${spend.cost} / ${spend.outputTokens} output tokens`);
console.log(`\n✓ PASS — the Agent SDK launched the pinned claude (${cli.source} tier),`);
console.log("  completed the handshake, and reached a server auth rejection. No tokens spent.");
process.exit(0);
