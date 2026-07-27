#!/usr/bin/env node
// ──────────────────────────────────────────────────────────
// agent-smoke.mjs — LIVE agent smoke harness  (manual / opt-in)
// ──────────────────────────────────────────────────────────
//
// SEPARATE from the unit suite (`pnpm test:git`). This spawns the REAL,
// installed+authed agent CLIs and sends REAL prompts, so it costs tokens /
// quota and is slow + non-deterministic. It is NEVER run automatically — you
// trigger it by hand, and the AI must ask before running it.
//
// It drives the engine's AgentGateway in-process (same construction as
// src/engine/index.ts) and, for every installed+authed agent, runs a small
// capability matrix so you can see — right now — which agents actually work.
//
//   Spawn+prompt   newSession → "reply PINGOK"          (auth / wiring / 401s)
//   Context        2nd turn recalls turn 1               (resume / context loss)
//   Cancel         long task → cancel mid-turn           (cancel classification)
//   Teardown       endSession                            (per-session cleanup)
//   --full only:   sweep every advertised model + effort
//
// Agents that aren't installed or authed are SKIPPED (not failed), so it runs
// with whatever you have configured. Prints a matrix + writes results.json,
// and exits non-zero if any non-skipped check fails (so it can gate a merge).
//
// Usage:
//   pnpm agents:smoke                      # core matrix, default model/agent
//   pnpm agents:smoke --full               # + every advertised model + effort
//   pnpm agents:smoke --agents codex,claude
//   pnpm agents:smoke --help
// ──────────────────────────────────────────────────────────

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const TMP = path.join(ROOT, ".zeros", "agent-smoke");

// ── args ─────────────────────────────────────────────────
const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(
    [
      "agent-smoke — live agent capability matrix (manual, costs tokens)",
      "",
      "  pnpm agents:smoke                 core matrix, default model/agent",
      "  pnpm agents:smoke --full          + sweep every advertised model + effort",
      "  pnpm agents:smoke --agents a,b    only these agent ids",
      "",
      "Skips agents that aren't installed/authed. Exit code is non-zero on any",
      "non-skipped failure.",
    ].join("\n"),
  );
  process.exit(0);
}
const FULL = argv.includes("--full");
const agentFilter = (() => {
  const i = argv.indexOf("--agents");
  return i >= 0 && argv[i + 1] ? new Set(argv[i + 1].split(",").map((s) => s.trim())) : null;
})();

// ── per-agent knobs (engine-side; mirrors catalogs/models-v1 modelEnvVars) ──
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

// ── glyphs ───────────────────────────────────────────────
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

// ── compile the engine gateway to an importable ESM bundle ──
async function compileGateway() {
  fs.mkdirSync(TMP, { recursive: true });
  const out = path.join(TMP, "gateway.mjs");
  await build({
    entryPoints: [path.join(ROOT, "src/engine/agents/gateway.ts")],
    outfile: out,
    format: "esm",
    platform: "node",
    target: "node20",
    bundle: true,
    // Bundle the local TS tree; leave node_modules (SDKs, better-sqlite3,
    // native deps) external so they load at runtime from ./node_modules.
    packages: "external",
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
  return dir;
}

// Gateway whose onSessionUpdate accumulates assistant text per session, and
// which auto-approves any permission prompt so a gated tool doesn't hang.
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

// Run a check, never throw — capture ok + a short detail string.
async function check(fn) {
  try {
    const detail = await fn();
    return { ok: true, detail: detail ?? "" };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

// One prompt round-trip on a fresh session. Returns { sessionId, reply }.
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

  // ── 1. spawn + prompt + 2. context (same session) ──
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

  // ── 3. cancel mid-turn ──
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

  // ── 4. teardown ──
  r.checks.teardown = await check(async () => {
    if (ctxSession) await gw.endSession(id, ctxSession);
    return "endSession ok";
  });

  // ── --full: model + effort sweep ──
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

// ── rendering ────────────────────────────────────────────
function cell(c) {
  if (c?.skip) return SKIP;
  return c?.ok ? OK : NO;
}
function pad(s, n) {
  s = String(s);
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function render(rows) {
  const cols = ["prompt", "context", "cancel", "teardown"];
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

// ── main ─────────────────────────────────────────────────
async function main() {
  console.log("── Zeros LIVE agent smoke ──");
  console.log("Spawns real, authed agent CLIs and sends real prompts (uses tokens).");
  console.log(FULL ? "Mode: --full (every advertised model + effort)\n" : "Mode: core matrix (default model)\n");

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
        reason: !installed ? "not installed" : "not authenticated",
      });
      continue;
    }
    process.stdout.write(`  running ${id} …\n`);
    const cwd = makeTempRepo();
    try {
      rows.push(await smokeAgent(harness, agent, cwd));
    } catch (err) {
      rows.push({ agent: id, installed, authenticated: authed, checks: { prompt: { ok: false, detail: String(err) } }, full: { models: [], efforts: [] } });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }

  const failCount = render(rows);

  // Machine-readable artifact for diffing over time / CI gating.
  const out = path.join(TMP, "results.json");
  fs.writeFileSync(out, JSON.stringify({ full: FULL, rows }, null, 2));
  console.log(`\nWrote ${path.relative(ROOT, out)}`);

  try {
    await harness.gateway.dispose();
  } catch {
    /* best effort */
  }
  fs.rmSync(projectRoot, { recursive: true, force: true });

  const tested = rows.filter((r) => !r.skipped).length;
  console.log(`\n${tested} agent(s) tested, ${rows.length - tested} skipped, ${failCount} failing check(s).`);
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("agent-smoke crashed:", err);
  process.exit(2);
});
