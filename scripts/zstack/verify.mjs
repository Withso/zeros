#!/usr/bin/env node
import path from "node:path";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadPolicy } from "../ci/scope.mjs";
import { planVerification, repositoryPath } from "./check-plan.mjs";
import { captureSource, sourceBytes } from "./source.mjs";
import { executeVerification, writeReceipt } from "./runner.mjs";
import { planDriver, planHost, runDriver } from "./drivers.mjs";

export const HELP = `node scripts/zstack/verify.mjs plan|run [--test repository/path.test.ts ...] [--anchor path:line ...]
  run --execute --receipt /private/scratch/receipt.json
  local-ui [--shard 1/3] [--execute --receipt FILE]
  host [--host portable|devin|claude|codex|cursor]
    [--can-delegate] [--delegate implementer|reviewer ...] [--implementer-model MODEL] [--reviewer-model MODEL]
  --host HOST can also label verification plans and receipts.
  --mode single-session|master-subagents|co-masters --agent MODEL [--master MODEL]
Host planning never spawns work. Pass --can-delegate only after the active
host exposes delegation and --delegate only for authorized roles.
Plans are offline. Live cloud proof is the deployed Dev gate0 probe
(pnpm --dir apps/control-plane cloud-v2:gate0), run only with the task's Alpha
authorization; this tool never runs it. No workflow, required check or
credential is configured by this tool. Receipts never overwrite.`;

const hostOptions = ["--can-delegate", "--delegate", "--implementer-model", "--reviewer-model"];
const commonOptions = ["--host", "--mode", "--agent", "--master"];
const diffOptions = ["--test", "--anchor"];
const executionOptions = ["--execute", "--receipt"];
const flagsByAction = new Map([
  ["host", ["--host", ...hostOptions]],
  ["plan", [...commonOptions, ...diffOptions]],
  ["run", [...commonOptions, ...diffOptions, ...executionOptions]],
  ["local-ui", [...commonOptions, ...executionOptions, "--source", "--shard"]],
]);
const repeatable = new Map([["--test", "tests"], ["--anchor", "anchors"], ["--delegate", "delegates"]]);

function parse(args) {
  if (!args.length || args[0] === "--help") return null;
  const [action, ...rest] = args, value = { action, tests: [], anchors: [], delegates: [], host: "portable",
    mode: "single-session", agent: "unspecified", master: null, execute: false };
  const known = flagsByAction.get(action), seen = new Set();
  if (!known) throw new Error("zstack_input_invalid");
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    if (!known.includes(flag) || seen.has(flag) && !repeatable.has(flag)) throw new Error("zstack_input_invalid");
    seen.add(flag);
    if (flag === "--execute" || flag === "--can-delegate") { value[flag.slice(2)] = true; continue; }
    if (!rest[index + 1] || rest[index + 1].startsWith("--") || /[\0\r\n]/.test(rest[index + 1])) throw new Error("zstack_input_invalid");
    const argument = rest[++index];
    if (repeatable.has(flag)) value[repeatable.get(flag)].push(argument); else value[flag.slice(2)] = argument;
  }
  if (!["single-session", "master-subagents", "co-masters"].includes(value.mode) || value.mode !== "single-session" && (!value.master || value.agent === "unspecified") ||
    value.agent.length > 100 || (value.master?.length ?? 0) > 100 ||
    action === "run" && !value.execute || value.execute !== Boolean(value.receipt) || value.anchors.length > 2)
    throw new Error("zstack_input_invalid");
  return value;
}

async function declaredAnchors(cwd, anchors, files) {
  const result = [];
  for (const anchor of new Set(anchors)) {
    const [, file, rawLine] = /^([^:]+):([1-9][0-9]{0,8})$/.exec(anchor) ?? [];
    if (!repositoryPath(file) || !files.includes(file)) throw new Error("zstack_anchor_invalid");
    const source = await sourceBytes(cwd, file), line = Number(rawLine);
    if (!source || source.mode === 0o120000 || source.bytes.includes(0)) throw new Error("zstack_anchor_invalid");
    let lines = source.bytes.length && source.bytes.at(-1) !== 10 ? 1 : 0;
    for (const byte of source.bytes) if (byte === 10) lines++;
    if (line > lines) throw new Error("zstack_anchor_invalid");
    result.push({ path: file, line });
  }
  return result;
}

export async function runCli(args, { cwd = process.cwd(), write = value => process.stdout.write(`${JSON.stringify(value)}\n`),
  capture = captureSource, receipt = writeReceipt, run = runDriver, verify = executeVerification, signal } = {}) {
  try {
    const options = parse(args);
    if (!options) { write({ schema: "zeros.zstack-help/v1", help: HELP }); return 0; }
    const host = planHost({ host: options.host, canDelegate: options["can-delegate"], delegates: options.delegates,
      models: { implementer: options["implementer-model"], reviewer: options["reviewer-model"] } });
    if (options.action === "host") { write(host); return 0; }
    cwd = await realpath(cwd);
    const changelog = await sourceBytes(cwd, "agents/zstack/CHANGELOG.md");
    const packVersion = changelog?.bytes.toString("utf8").match(/^##\s+(?:\[)?(\d+\.\d+\.\d+)/m)?.[1] ?? "unknown";
    const metadata = { mode: options.mode, agent: options.agent, master: options.master, packVersion,
      host: host.host, platform: host.platform };
    let result;
    if (["plan", "run"].includes(options.action)) {
      const source = await capture(cwd), plan = planVerification({ policy: loadPolicy(path.join(cwd, "scripts/ci/scope-rules.json")),
        ...source, tests: options.tests });
      metadata.sourceAnchors = await declaredAnchors(cwd, options.anchors, source.files);
      if (!options.execute) { write({ ...plan, ...metadata }); return plan.blocked.length ? 1 : 0; }
      result = await verify(plan, { cwd, metadata, signal, fingerprint: async () => (await capture(cwd)).evidence.fingerprint });
    } else {
      const plan = planDriver(options.action, { sourceSha: options.source, shard: options.shard });
      if (!options.execute) { write({ ...plan, ...metadata }); return 0; }
      const startedAt = new Date().toISOString();
      const observation = await run(plan.command, { cwd, signal, timeoutMs: 20 * 60_000 });
      result = { schema: "zeros.zstack-receipt/v1", ...metadata, intendedSourceSha: options.source ?? null, startedAt,
        completedAt: new Date().toISOString(), status: observation.status,
        code: observation.code, results: [{ argv: plan.command.argv, ...observation }],
        unverified: [...plan.unverified, ...(observation.unverified ?? [])], evidence: [], tokens: null };
    }
    await receipt(path.resolve(cwd, options.receipt), result); write(result);
    return result.status === "passed" ? 0 : 1;
  } catch (error) {
    const known = new Set(["zstack_input_invalid", "zstack_anchor_invalid", "zstack_test_invalid", "zstack_path_invalid", "zstack_source_unsafe",
      "zstack_source_limit", "zstack_plan_invalid", "zstack_plan_blocked", "zstack_git_unavailable", "zstack_receipt_unsafe"]);
    write({ schema: "zeros.zstack-error/v1", code: known.has(error?.message) ? error.message : "zstack_failed" }); return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController(), cancel = () => controller.abort();
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  runCli(process.argv.slice(2), { signal: controller.signal }).then(code => { process.exitCode = code; })
    .finally(() => { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); });
}
