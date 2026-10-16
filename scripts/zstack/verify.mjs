#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPolicy } from "../ci/scope.mjs";
import { createGitHubApi } from "../ci/recovery-api.mjs";
import { planVerification } from "./check-plan.mjs";
import { captureSource, sourceBytes } from "./source.mjs";
import { executeVerification, writeReceipt } from "./runner.mjs";
import { planDriver, runDriver, observeHourly } from "./drivers.mjs";

export const HELP = `node scripts/zstack/verify.mjs plan|run [--test repository/path.test.ts ...]
  run --execute --receipt /private/scratch/receipt.json
  local-ui [--shard 1/3] [--execute --receipt FILE]
  cloud-health|cloud-status|cloud-dispatch --source SHA [--execute --receipt FILE]
  --mode single-session|master-subagents --agent MODEL [--master MODEL]
Plans are offline. Cloud execution requires the task's Alpha authorization.
Cloud model turns run only in the main hourly Actions workflow; dispatch is
unverified until cloud-status observes its exact source green. No workflow,
required check or credential is configured by this tool. Receipts never overwrite.`;

function parse(args) {
  if (!args.length || args[0] === "--help") return null;
  const [action, ...rest] = args, value = { action, tests: [], mode: "single-session", agent: "unspecified", master: null, execute: false };
  if (!["plan", "run", "local-ui", "cloud-health", "cloud-status", "cloud-dispatch"].includes(action)) throw new Error("zstack_input_invalid");
  const known = new Set(["--test", "--mode", "--agent", "--master", "--source", "--receipt", "--shard"]), seen = new Set();
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    if (seen.has(flag) && flag !== "--test") throw new Error("zstack_input_invalid");
    seen.add(flag);
    if (flag === "--execute") { value.execute = true; continue; }
    if (!known.has(flag) || !rest[index + 1] || rest[index + 1].startsWith("--") || /[\0\r\n]/.test(rest[index + 1])) throw new Error("zstack_input_invalid");
    const argument = rest[++index];
    if (flag === "--test") value.tests.push(argument); else value[flag.slice(2)] = argument;
  }
  if (!["single-session", "master-subagents"].includes(value.mode) || value.mode === "master-subagents" && (!value.master || value.agent === "unspecified") ||
    value.agent.length > 100 || (value.master?.length ?? 0) > 100 ||
    value.action === "run" && !value.execute || value.execute && !value.receipt || value.action === "plan" && value.execute)
    throw new Error("zstack_input_invalid");
  return value;
}

export async function runCli(args, { cwd = process.cwd(), write = value => process.stdout.write(`${JSON.stringify(value)}\n`),
  capture = captureSource, receipt = writeReceipt, run = runDriver, observe = observeHourly, signal } = {}) {
  try {
    const options = parse(args);
    if (!options) { write({ schema: "zeros.zstack-help/v1", help: HELP }); return 0; }
    const changelog = await sourceBytes(cwd, "agents/zstack/CHANGELOG.md");
    const packVersion = changelog?.bytes.toString("utf8").match(/^##\s+(?:\[)?(\d+\.\d+\.\d+)/m)?.[1] ?? "unknown";
    const metadata = { mode: options.mode, agent: options.agent, master: options.master, packVersion };
    let result;
    if (["plan", "run"].includes(options.action)) {
      const source = await capture(cwd), plan = planVerification({ policy: loadPolicy(path.join(cwd, "scripts/ci/scope-rules.json")),
        ...source, tests: options.tests });
      if (!options.execute) { write({ ...plan, ...metadata }); return plan.blocked.length ? 1 : 0; }
      result = await executeVerification(plan, { cwd, metadata, signal, fingerprint: async () => (await capture(cwd)).evidence.fingerprint });
    } else {
      const plan = planDriver(options.action, { sourceSha: options.source, shard: options.shard });
      if (!options.execute) { write({ ...plan, ...metadata }); return 0; }
      const startedAt = new Date().toISOString();
      const budget = globalThis.AbortSignal.any([...(signal ? [signal] : []), globalThis.AbortSignal.timeout(60_000)]);
      const observation = options.action === "cloud-status"
        ? await observe(createGitHubApi({ fetchImpl: (url, init) => fetch(url, { ...init,
          signal: globalThis.AbortSignal.any([budget, init.signal]) }) }), options.source)
        : await run(plan.command, { cwd, signal, timeoutMs: options.action === "local-ui" ? 20 * 60_000 : 60_000 });
      const dispatch = options.action === "cloud-dispatch" && observation.status === "passed";
      result = { schema: "zeros.zstack-receipt/v1", ...metadata, intendedSourceSha: options.source ?? null, startedAt,
        completedAt: new Date().toISOString(), status: dispatch ? "unverified" : observation.status,
        code: dispatch ? "dispatch_requested" : observation.code, results: [{ argv: plan.command?.argv ?? null, ...observation }],
        unverified: [...plan.unverified, ...(observation.unverified ?? [])], evidence: [], tokens: null };
    }
    await receipt(path.resolve(cwd, options.receipt), result); write(result);
    return result.status === "passed" || result.code === "dispatch_requested" ? 0 : 1;
  } catch (error) {
    const known = new Set(["zstack_input_invalid", "zstack_requires_linux", "zstack_test_invalid", "zstack_path_invalid", "zstack_source_unsafe",
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
