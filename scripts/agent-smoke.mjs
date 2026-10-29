#!/usr/bin/env node
// Manual, opt-in live check: this sends real prompts and spends provider
// quota, so run only with explicit authorization. It drives the shipping gateway.
// Auth comes from gateway probes, not merely API environment variables: Claude
// needs its credential files/keychain, Codex uses login status, and Cursor
// needs Electron's decrypted secret handoff (use cursor:smoke for its host).
// Zero tested agents must fail; --require names agents that may not skip.
// See --help for the core and full model/effort matrices.

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

import {
  agentSmokeProviderCwd,
  agentSmokeSkipReason,
  canonicalAgentSmokeWorkspace,
  installAgentSmokeRuntimeEnvironment,
} from "./agent-smoke-runtime-assets.mjs";
import {
  formatAdmissionFailures,
  parseAdmissionCopies,
} from "./agent-smoke-options.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const TMP = path.join(ROOT, ".zeros", "agent-smoke");

// Native process ownership and pinned executables belong to this checkout,
// even though provider prompts run in a disposable repository.
installAgentSmokeRuntimeEnvironment(ROOT);

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(
    [
      "agent-smoke — live agent capability matrix (manual, costs tokens)",
      "",
      "  pnpm agents:smoke                 core matrix, default model/agent",
      "  pnpm agents:smoke --full          + sweep every advertised model + effort",
      "  pnpm agents:smoke --admission-only  start + tear down; sends no model prompt",
      "  pnpm agents:smoke --admission-only --admission-copies 2",
      "  pnpm agents:smoke --agents a,b    only these agent ids",
      "  pnpm agents:smoke --require a,b   FAIL if a named agent skipped (for CI)",
      "",
      "Skips agents that aren't installed/authed. Exit code is non-zero on any",
      "non-skipped failure, if NO agent ran at all, or if a --require'd agent",
      "skipped. Env-var API keys do not satisfy any auth probe — see the header.",
    ].join("\n"),
  );
  process.exit(0);
}
const FULL = argv.includes("--full");
const ADMISSION_ONLY = argv.includes("--admission-only");
const ADMISSION_COPIES = parseAdmissionCopies(argv);
if (FULL && ADMISSION_ONLY) {
  throw new Error("--full and --admission-only are mutually exclusive");
}
if (!ADMISSION_ONLY && ADMISSION_COPIES !== 1) {
  throw new Error("--admission-copies requires --admission-only");
}
function idList(flag) {
  const i = argv.indexOf(flag);
  if (i < 0 || !argv[i + 1]) return null;
  const ids = argv[i + 1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.length ? new Set(ids) : null;
}
const agentFilter = idList("--agents");
const required = idList("--require");

// Match the engine model variables in catalogs/models-v1.
const MODEL_ENV = {
  claude: "ANTHROPIC_MODEL",
  "claude-code": "ANTHROPIC_MODEL",
  codex: "OPENAI_MODEL",
  cursor: "CURSOR_MODEL",
  "cursor-sdk": "CURSOR_MODEL",
};
const EFFORT_ENV = "ZEROS_THINKING_EFFORT";
const EFFORT_AGENTS = new Set(["codex"]);
const EFFORT_LEVELS = ["low", "medium", "high"];

const PROMPT_TIMEOUT_MS = 90_000;
const CANCEL_AFTER_MS = 2_500;
const CANCEL_RESOLVE_BUDGET_MS = 25_000;

const PROMPT_PING = "Reply with exactly one word and nothing else: PINGOK";
const PROMPT_RECALL =
  "What single word did I ask you to reply with a moment ago? Reply with only that word.";
const PROMPT_LONG =
  "List the numbers from 1 to 500, one per line, with no other text. Do not stop early.";

const OK = "✓"; // ✓
const NO = "✗"; // ✗
const SKIP = "⏭"; // ⏭

function modelEnvFor(agentId) {
  const id = (agentId || "").toLowerCase();
  for (const key of Object.keys(MODEL_ENV)) {
    if (id.includes(key)) return MODEL_ENV[key];
  }
  return null;
}
function supportsEffort(agentId) {
  const id = (agentId || "").toLowerCase();
  return [...EFFORT_AGENTS].some((k) => id.includes(k));
}


/** Externalize bare imports so the SDKs / better-sqlite3 / native deps load at
 *  runtime from ./node_modules — but BUNDLE the `@zeros/*` workspace packages.
 *
 *  This replaces a plain `packages: "external"`, which externalized those too and
 *  made this whole harness unrunnable: @zeros/protocol's exports map points at RAW
 *  .ts sources, so an external `import "@zeros/protocol/system-instructions"`
 *  resolved to index.ts, whose `from "./templates"` is extensionless — something
 *  plain Node ESM cannot resolve. Every invocation died with ERR_MODULE_NOT_FOUND
 *  before listing a single agent (gateway.ts:51 is the importer).
 *
 *  tsup.config.ts carries the identical carve-out for the real engine build
 *  (`noExternal: [..., /^@zeros\/core/]`, with the same reasoning). esbuild's
 *  `packages: "external"` has no `noExternal` escape hatch, so here it has to be
 *  expressed as a resolver. */
const externalizeNodeModules = {
  name: "externalize-node-modules",
  setup(build) {
    build.onResolve({ filter: /^[^./]/ }, (args) =>
      args.path.startsWith("@zeros/")
        ? null // resolve + bundle from source
        : { path: args.path, external: true },
    );
  },
};

async function compileGateway() {
  fs.mkdirSync(TMP, { recursive: true });
  const out = path.join(TMP, "gateway.mjs");
  await build({
    entryPoints: [path.join(ROOT, "apps/desktop/src/engine/agents/gateway.ts")],
    outfile: out,
    format: "esm",
    platform: "node",
    target: "node20",
    bundle: true,
    plugins: [externalizeNodeModules],
    logLevel: "silent",
  });
  return import(pathToFileURL(out).href);
}

function makeTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-smoke-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["commit", "--allow-empty", "-qm", "seed"], { cwd: dir, stdio: "ignore" });
  } catch {
    /* git optional — most agents run in a plain dir too */
  }
  fs.writeFileSync(path.join(dir, "README.md"), "# zeros agent smoke\n");
  // Canonicalize macOS /var before forming workspace identity; Git uses its
  // physical /private/var path and containment checks require the same root.
  return canonicalAgentSmokeWorkspace(dir);
}

function makeGateway(GatewayCtor, projectRoot) {
  const replies = new Map(); // sessionId -> accumulated assistant text
  const harness = { gateway: null, replies };
  const gateway = new GatewayCtor({
    projectRoot,
    events: {
      onSessionUpdate: (_agentId, note) => {
        const sid = note?.sessionId;
        const u = note?.update;
        if (sid && u?.sessionUpdate === "agent_message_chunk") {
          const t = u?.content?.text;
          if (typeof t === "string") replies.set(sid, (replies.get(sid) ?? "") + t);
        }
      },
      onPermissionRequest: (agentId, permissionId) => {
        // Auto-allow so a gated tool-call round-trips instead of hanging.
        try {
          gateway.answerPermission(permissionId, {
            outcome: { outcome: "selected", optionId: "allow_once" },
          });
        } catch {
          /* adapter may not expose this shape — best effort */
        }
      },
      onAgentStderr: () => {},
      onAgentExit: () => {},
    },
    fs: {
      readTextFile: async ({ path: p }) => ({ content: await fsp.readFile(p, "utf-8") }),
      writeTextFile: async ({ path: p, content }) => {
        await fsp.mkdir(path.dirname(p), { recursive: true });
        await fsp.writeFile(p, content);
        return {};
      },
    },
  });
  harness.gateway = gateway;
  return harness;
}

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`timeout after ${ms}ms (${label})`)), ms);
  });
  return Promise.race([promise.finally(() => clearTimeout(t)), timeout]);
}

async function check(fn) {
  try {
    const detail = await fn();
    return { ok: true, detail: detail ?? "" };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

async function askFresh(harness, agentId, cwd, text, env) {
  const session = await harness.gateway.newSession(agentId, { cwd, env });
  const sid = session.sessionId;
  harness.replies.set(sid, "");
  await withTimeout(
    harness.gateway.prompt(agentId, sid, [{ type: "text", text }]),
    PROMPT_TIMEOUT_MS,
    `${agentId} prompt`,
  );
  return { sessionId: sid, reply: harness.replies.get(sid) ?? "" };
}

async function smokeAgent(harness, agent, cwd) {
  const id = agent.id;
  const r = { agent: id, name: agent.name, checks: {}, full: { models: [], efforts: [] } };
  const gw = harness.gateway;

  if (ADMISSION_ONLY) {
    const sessionIds = [];
    r.checks.admission = await check(async () => {
      const startedAt = Date.now();
      const outcomes = await withTimeout(
        Promise.allSettled(
          Array.from({ length: ADMISSION_COPIES }, () =>
            gw.newSession(id, { cwd }),
          ),
        ),
        120_000,
        `${id} admission ×${ADMISSION_COPIES}`,
      );
      const failures = [];
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") {
          failures.push(outcome.reason);
          continue;
        }
        const sessionId = outcome.value.executionId ?? outcome.value.sessionId;
        if (sessionId) sessionIds.push(sessionId);
        else failures.push(new Error("admission returned no execution id"));
      }
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          formatAdmissionFailures(failures, ADMISSION_COPIES),
        );
      }
      return `${ADMISSION_COPIES} ready in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
    });
    r.checks.teardown = sessionIds.length > 0
      ? await check(async () => {
          await withTimeout(
            Promise.all(
              sessionIds.map((sessionId) =>
                gw.endSession(id, sessionId, { failClosed: true }),
              ),
            ),
            30_000,
            `${id} teardown ×${sessionIds.length}`,
          );
          return `${sessionIds.length} endSession + boundary proofs ok`;
        })
      : { ok: false, detail: "skipped (admission failed)" };
    return r;
  }

  let ctxSession = null;
  r.checks.prompt = await check(async () => {
    const { sessionId, reply } = await askFresh(harness, id, cwd, PROMPT_PING);
    ctxSession = sessionId;
    if (!/pingok/i.test(reply))
      throw new Error(`no PINGOK in reply: ${JSON.stringify(reply.slice(0, 120))}`);
    return "PINGOK";
  });

  r.checks.context = r.checks.prompt.ok
    ? await check(async () => {
        harness.replies.set(ctxSession, "");
        await withTimeout(
          gw.prompt(id, ctxSession, [{ type: "text", text: PROMPT_RECALL }]),
          PROMPT_TIMEOUT_MS,
          `${id} context`,
        );
        const reply = harness.replies.get(ctxSession) ?? "";
        if (!/pingok/i.test(reply))
          throw new Error(`turn-2 lost context: ${JSON.stringify(reply.slice(0, 120))}`);
        return "recalled";
      })
    : { ok: false, detail: "skipped (prompt failed)" };

  r.checks.cancel = await check(async () => {
    const session = await gw.newSession(id, { cwd });
    const sid = session.sessionId;
    harness.replies.set(sid, "");
    const started = Date.now();
    const p = gw
      .prompt(id, sid, [{ type: "text", text: PROMPT_LONG }])
      .then((resp) => ({ resp }))
      .catch((err) => ({ err }));
    await new Promise((res) => setTimeout(res, CANCEL_AFTER_MS));
    await gw.cancel(id, sid).catch(() => {});
    const outcome = await withTimeout(p, CANCEL_RESOLVE_BUDGET_MS, `${id} cancel-resolve`);
    const elapsed = Date.now() - started;
    await gw.endSession(id, sid).catch(() => {});
    if (outcome.err) throw new Error(`prompt threw after cancel: ${outcome.err.message ?? outcome.err}`);
    const stop = outcome.resp?.stopReason;
    if (stop && stop !== "cancelled" && stop !== "end_turn")
      throw new Error(`unexpected stopReason after cancel: ${stop}`);
    return `resolved in ${(elapsed / 1000).toFixed(1)}s${stop ? ` (${stop})` : ""}`;
  });

  r.checks.teardown = await check(async () => {
    if (ctxSession) await gw.endSession(id, ctxSession);
    return "endSession ok";
  });

  if (FULL) {
    const modelEnv = modelEnvFor(id);
    let models = [];
    try {
      const init = await gw.initializeAgent(id);
      models = init?._meta?.models?.map((m) => m.id ?? m.modelId ?? m).filter(Boolean) ?? [];
    } catch {
      /* no advertised model list */
    }
    if (modelEnv && models.length) {
      for (const model of models.slice(0, 12)) {
        const res = await check(async () => {
          const { reply } = await askFresh(harness, id, cwd, PROMPT_PING, { [modelEnv]: model });
          if (!/pingok/i.test(reply)) throw new Error("no PINGOK");
          return "ok";
        });
        r.full.models.push({ model, ...res });
      }
    }
    if (supportsEffort(id)) {
      for (const effort of EFFORT_LEVELS) {
        const res = await check(async () => {
          const { reply } = await askFresh(harness, id, cwd, PROMPT_PING, { [EFFORT_ENV]: effort });
          if (!/pingok/i.test(reply)) throw new Error("no PINGOK");
          return "ok";
        });
        r.full.efforts.push({ effort, ...res });
      }
    }
  }

  return r;
}

function cell(c) {
  if (c?.skip) return SKIP;
  return c?.ok ? OK : NO;
}
function pad(s, n) {
  s = String(s);
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function render(rows) {
  const cols = ADMISSION_ONLY
    ? ["admission", "teardown"]
    : ["prompt", "context", "cancel", "teardown"];
  console.log("");
  console.log(
    pad("AGENT", 16) + pad("INSTALL", 9) + pad("AUTH", 7) + cols.map((c) => pad(c.toUpperCase(), 10)).join(""),
  );
  console.log("-".repeat(16 + 9 + 7 + cols.length * 10));
  const failures = [];
  for (const row of rows) {
    if (row.skipped) {
      console.log(pad(row.agent, 16) + pad(row.installed ? OK : NO, 9) + pad(row.authenticated ? OK : NO, 7) + `${SKIP}  ${row.reason}`);
      continue;
    }
    const cells = cols.map((c) => pad(cell(row.checks[c]), 10)).join("");
    console.log(pad(row.agent, 16) + pad(OK, 9) + pad(OK, 7) + cells);
    for (const c of cols) {
      if (row.checks[c] && !row.checks[c].ok) failures.push(`  ${row.agent} · ${c}: ${row.checks[c].detail}`);
    }
    if (FULL) {
      for (const m of row.full.models) {
        console.log("    " + pad(`model:${m.model}`, 40) + (m.ok ? OK : `${NO}  ${m.detail}`));
        if (!m.ok) failures.push(`  ${row.agent} · model ${m.model}: ${m.detail}`);
      }
      for (const e of row.full.efforts) {
        console.log("    " + pad(`effort:${e.effort}`, 40) + (e.ok ? OK : `${NO}  ${e.detail}`));
        if (!e.ok) failures.push(`  ${row.agent} · effort ${e.effort}: ${e.detail}`);
      }
    }
  }
  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) console.log(f);
  }
  return failures.length;
}

async function main() {
  console.log("── Zeros LIVE agent smoke ──");
  console.log(
    ADMISSION_ONLY
      ? "Starts real, authed agent runtimes and tears them down without sending a model prompt."
      : "Spawns real, authed agent CLIs and sends real prompts (uses tokens).",
  );
  console.log(
    ADMISSION_ONLY
      ? "Mode: admission-only (no model turn)\n"
      : FULL
        ? "Mode: --full (every advertised model + effort)\n"
        : "Mode: core matrix (default model)\n",
  );

  const mod = await compileGateway();
  const Gateway = mod.AgentGateway;
  if (!Gateway) throw new Error("AgentGateway not exported from the compiled bundle");

  const projectRoot = makeTempRepo();
  const harness = makeGateway(Gateway, projectRoot);

  let agents;
  try {
    agents = await harness.gateway.listAgents();
  } catch (err) {
    console.error("listAgents failed:", err);
    process.exit(2);
  }

  const rows = [];
  for (const agent of agents) {
    const id = agent.id;
    if (agentFilter && !agentFilter.has(id)) continue;
    const installed = agent.installed !== false;
    const authed = agent.authenticated === true;
    if (!installed || !authed) {
      rows.push({
        agent: id,
        installed,
        authenticated: authed,
        skipped: true,
        reason: agentSmokeSkipReason(agent),
      });
      continue;
    }
    process.stdout.write(`  running ${id} …\n`);
    // Provider cwd must remain inside the gateway's canonical repository boundary.
    const cwd = agentSmokeProviderCwd(projectRoot, id);
    fs.mkdirSync(cwd, { recursive: true });
    try {
      rows.push(await smokeAgent(harness, agent, cwd));
    } catch (err) {
      rows.push({ agent: id, installed, authenticated: authed, checks: { prompt: { ok: false, detail: String(err) } }, full: { models: [], efforts: [] } });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }

  const failCount = render(rows);

  // Compute coverage before writing the artifact so it agrees with the exit verdict.
  const tested = rows.filter((r) => !r.skipped).length;
  const coverage = [];

  if (tested === 0) {
    coverage.push(
      rows.length === 0
        ? "no agents were even listed — the gateway returned an empty agent list, " +
            "so this run proved nothing about any agent."
        : `all ${rows.length} agent(s) skipped — nothing was tested, so a zero ` +
            `failure count says nothing. Env-var API keys do NOT satisfy any auth ` +
            `probe; real credential files are required (see the header of this file).`,
    );
  }

  for (const id of required ?? []) {
    const row = rows.find((r) => r.agent === id);
    if (!row) {
      coverage.push(
        `--require ${id}: no such agent was listed. Known ids: ` +
          `${rows.map((r) => r.agent).join(", ") || "(none)"}` +
          (agentFilter && !agentFilter.has(id)
            ? ` — note --agents excludes it, so --require can never be satisfied.`
            : ""),
      );
    } else if (row.skipped) {
      coverage.push(
        `--require ${id}: SKIPPED (${row.reason}) — installed=${row.installed}, ` +
          `authenticated=${row.authenticated}. Required agents must actually run.`,
      );
    }
  }

  if (coverage.length) {
    console.log("\nCoverage failures:");
    for (const c of coverage) console.log(`  ${c}`);
  }

  const out = path.join(TMP, "results.json");
  fs.writeFileSync(
    out,
    JSON.stringify(
      {
        full: FULL,
        admissionOnly: ADMISSION_ONLY,
        admissionCopies: ADMISSION_COPIES,
        required: [...(required ?? [])],
        tested,
        coverage,
        rows,
      },
      null,
      2,
    ),
  );
  console.log(`\nWrote ${path.relative(ROOT, out)}`);

  try {
    await harness.gateway.dispose();
  } catch {
    /* best effort */
  }
  fs.rmSync(projectRoot, { recursive: true, force: true });

  console.log(
    `\n${tested} agent(s) tested, ${rows.length - tested} skipped, ` +
      `${failCount} failing check(s), ${coverage.length} coverage failure(s).`,
  );
  process.exit(failCount > 0 || coverage.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("agent-smoke crashed:", err);
  process.exit(2);
});
