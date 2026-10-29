#!/usr/bin/env node
// A runnable CLI does not prove that the SDK can launch it through the
// shipping resolver. Require a pinned binary and an auth-shaped SDK response.
// Empty credential directories and an invalid key prevent a paid turn; fail
// if observed output or usage proves real inference. Packaged engines cannot
// resolve platform binaries relative to an SDK embedded in Bun's filesystem.

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { readClaudeCodeVersion } from "./stage-claude-cli.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP_DIR = path.join(ROOT, ".zeros", "claude-smoke");
const RESOLVER =
  "apps/desktop/src/engine/agents/adapters/claude-sdk/binary-resolver.ts";
const TIMEOUT_MS = 90_000;

/** These failures do not prove that an API request reached authentication. */
const LAUNCH_ERR_RX =
  /Native CLI binary|not found|ENOENT|EACCES|spawn\b|Permission denied|exited with code|no such file|cannot execute|Exec format error/i;
const AUTH_ERR_RX =
  /401|403|invalid.{0,20}api.?key|authentication|unauthorized|invalid.{0,20}token|credit balance|OAuth/i;
/** `api_retry` statuses that are themselves proof the server saw us and said no. */
const AUTH_RETRY_STATUSES = new Set([401, 403]);

function die(msg, detail) {
  console.error(`\n✗ FAIL — ${msg}`);
  if (detail) {
    console.error(
      String(detail)
        .split("\n")
        .slice(0, 24)
        .map((l) => `    ${l}`)
        .join("\n"),
    );
  }
  process.exit(1);
}

// Bundle the shipping resolver as CJS inside the checkout to preserve
// require resolution against its own installed dependencies.
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
const fakeHome = fs.mkdtempSync(
  path.join(os.tmpdir(), "zeros-claude-smoke-home-"),
);
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-claude-smoke-"));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.CLAUDE_CONFIG_DIR = path.join(fakeHome, ".claude");
// Low entropy keeps this rejected fixture recognizable to the secret scan
// without exempting real keys. A malformed key also avoids long API retries.
process.env.ANTHROPIC_API_KEY = "sk-ant-xxxxxxxxxxxxxxxxxxxxxxxx";
delete process.env.ANTHROPIC_AUTH_TOKEN;
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
// Authentication rejection is the expected result; retries would exhaust
// the deadline and falsely implicate the handshake.
process.env.CLAUDE_CODE_MAX_RETRIES = "0";

console.log(`▸ home:     ${fakeHome} (empty — no ambient credentials)\n`);

const { query } = await import("@anthropic-ai/claude-agent-sdk");
const expectedCliVersion = readClaudeCodeVersion(
  createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk"),
);

const abort = new AbortController();
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  abort.abort();
}, TIMEOUT_MS);

// Synthetic assistant messages carry auth errors too. Use real model output
// and result cost/token counters to detect unintended inference.
let realInference = false;
let spend = { cost: 0, outputTokens: 0 };
let failure = null;
let authRetry = null;
let initializedCliVersion = null;
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
  // 0.3.296 identifies the executing CLI during the control handshake, before
  // system/init. Compare the real process with the bundled artifact's manifest.
  // Keep this query-scoped: another owner/custom CLI must not share its version.
  const initialized = await q.initializationResult();
  initializedCliVersion = initialized.claude_code_version;
  for await (const msg of q) {
    // If the CLI ignores the retry limit, an observed 401/403 still proves
    // the handshake; abort after recording it instead of waiting for timeout.
    if (
      msg?.type === "system" &&
      msg.subtype === "api_retry" &&
      AUTH_RETRY_STATUSES.has(msg.error_status)
    ) {
      authRetry = `${msg.error_status} ${msg.error ?? "(no error text)"}`;
      abort.abort();
      continue;
    }
    if (msg?.type === "assistant" && msg.message?.model && msg.message.model !== "<synthetic>") {
      realInference = true;
    }
    if (msg?.type === "result") {
      spend = {
        cost: msg.total_cost_usd ?? 0,
        outputTokens: msg.usage?.output_tokens ?? 0,
      };
      if (msg.is_error)
        failure = msg.result ?? msg.subtype ?? "(error result, no text)";
    }
  }
} catch (err) {
  // The SDK rethrows error results after the stream, including expected auth rejection.
  if (!authRetry) failure = err?.message ?? String(err);
}
clearTimeout(timer);
// An observed rejection outranks the "aborted by user" message our own abort
// produced: the retry line is what actually happened, the abort is how we left.
if (authRetry) failure = authRetry;
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
if (!expectedCliVersion || initializedCliVersion !== expectedCliVersion) {
  die("the SDK initialize response does not identify the pinned Claude CLI");
}
if (!failure) {
  die(
    "the query produced neither an error nor assistant output — the SDK↔CLI handshake did not complete.",
  );
}
if (timedOut) {
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
  // Unknown failure shapes do not prove an authentication round trip.
  die(
    "the query failed, but not with a recognisable auth rejection. If this is a new " +
      "auth error shape, add it to AUTH_ERR_RX; if it is a launch failure, that is a real bug.",
    oneLine,
  );
}

console.log(`▸ rejected: ${oneLine.slice(0, 160)}`);
console.log(`▸ handshake version: ${initializedCliVersion}`);
console.log(`▸ spend:    $${spend.cost} / ${spend.outputTokens} output tokens`);
console.log(
  `\n✓ PASS — the Agent SDK launched the pinned claude (${cli.source} tier),`,
);
console.log(
  "  completed the handshake, and reached a server auth rejection. No tokens spent.",
);
process.exit(0);
