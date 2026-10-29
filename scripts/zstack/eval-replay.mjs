#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readEvalCases, validateEvalCases } from "./evals.mjs";
import { replayCase, replaySeed, compareEvalReceipts } from "./replay.mjs";
import { sourceBytes } from "./source.mjs";
import { writeReceipt } from "./runner.mjs";

export const HELP = `node scripts/zstack/eval-replay.mjs --case ID [--case ID ...] | --all
  [--execute --receipt /private/scratch/replay.json] [--baseline FILE]
  [--revision FULL_SHA] [--allow-pending] [--dependency-cache DIRECTORY]
  [--mode single-session|master-subagents|co-masters --agent MODEL --master MODEL]
Default is an offline plan. Execution prefetches missing promised Git objects
and caches historical pnpm graphs outside the checkout (offline store first).
Each case gets 120 seconds per side and four Vitest workers; at most 32 cases
run sequentially. --revision pins seeds. Child output is discarded. Caught,
missed and unverified results are distinct. See agents/zstack/tools.md.`;

export async function runCli(args, { cwd = process.cwd(), read = readEvalCases, run = replayCase, seed = replaySeed,
  write = value => process.stdout.write(`${JSON.stringify(value)}\n`), receipt = writeReceipt, signal } = {}) {
  try {
    if (!args.length || args[0] === "--help") { write({ schema: "zeros.zstack-help/v1", help: HELP }); return 0; }
    const options = { cases: [], execute: false, all: false, "allow-pending": false, mode: "single-session", agent: "unspecified", master: null };
    const flags = new Set(["--execute", "--all", "--allow-pending"]), values = new Set(["--case", "--receipt", "--baseline", "--revision", "--mode", "--agent", "--master", "--dependency-cache"]), seen = new Set();
    for (let index = 0; index < args.length; index++) {
      const flag = args[index];
      if (seen.has(flag) && flag !== "--case") throw new Error(); seen.add(flag);
      if (flags.has(flag)) options[flag.slice(2)] = true;
      else if (values.has(flag) && args[index + 1] && !args[index + 1].startsWith("--") && !/[\0\r\n]/.test(args[index + 1])) {
        const value = args[++index]; if (flag === "--case") options.cases.push(value); else options[flag.slice(2)] = value;
      } else throw new Error();
    }
    if ((!options.all && !options.cases.length) || (options.all && options.cases.length) ||
      options.execute && !options.receipt || !["single-session", "master-subagents", "co-masters"].includes(options.mode) ||
      options.mode !== "single-session" && (!options.master || options.agent === "unspecified") ||
      options.agent.length > 100 || (options.master?.length ?? 0) > 100) throw new Error();
    const value = read(cwd);
    if (validateEvalCases(value, { allowPending: options["allow-pending"] }).length) throw new Error();
    const selected = options.all ? value.cases : options.cases.map(id => value.cases.find(entry => entry.id === id));
    if (selected.length > 32) throw new Error("zstack_case_limit");
    if (selected.some(entry => !entry) || new Set(selected.map(entry => entry.id)).size !== selected.length) throw new Error();
    if (!options.execute) { write({ schema: "zeros.zstack-eval-plan/v1", selected: selected.map(entry => entry.id), execute: false }); return 0; }
    const startedAt = new Date().toISOString(), results = [];
    for (const entry of selected) {
      if (signal?.aborted) { results.push({ id: entry.id, status: "unverified", code: "cancelled" }); continue; }
      let result;
      if (entry.kind === "seeded") {
        const definition = await sourceBytes(cwd, `agents/zstack/evals/seeds/${entry.id}.json`);
        result = definition ? await seed(entry, JSON.parse(definition.bytes.toString("utf8")), { cwd, revision: options.revision, signal,
          cacheRoot: options["dependency-cache"] && path.resolve(cwd, options["dependency-cache"]) })
          : { id: entry.id, status: "unverified", code: "seed_definition_required" };
      } else result = await run(entry, { cwd, signal, cacheRoot: options["dependency-cache"] && path.resolve(cwd, options["dependency-cache"]) });
      results.push(result);
      write({ schema: "zeros.zstack-eval-progress/v1", id: entry.id, status: result.status, code: result.code });
    }
    const summary = { selected: results.length, caught: results.filter(row => row.status === "caught").length,
      missed: results.filter(row => row.status === "missed").length, unverified: results.filter(row => row.status === "unverified").length };
    let comparison = null;
    if (options.baseline) {
      const target = path.resolve(cwd, options.baseline), input = await sourceBytes(path.dirname(target), path.basename(target));
      if (!input || input.bytes.length > 2 * 1024 * 1024) throw new Error();
      comparison = compareEvalReceipts(JSON.parse(input.bytes.toString("utf8")), { cases: results });
    }
    const changelog = await sourceBytes(cwd, "agents/zstack/CHANGELOG.md");
    const packVersion = changelog?.bytes.toString("utf8").match(/^##\s+(?:\[)?(\d+\.\d+\.\d+)/m)?.[1] ?? "unknown";
    const result = { schema: "zeros.zstack-eval-receipt/v1", mode: options.mode, agent: options.agent, master: options.master, packVersion,
      startedAt, completedAt: new Date().toISOString(), cases: results, summary, comparison, tokens: null };
    await receipt(path.resolve(cwd, options.receipt), result); write({ ...result, cases: undefined });
    return summary.caught === summary.selected && comparison?.allowed !== false ? 0 : 1;
  } catch (error) {
    write({ schema: "zeros.zstack-error/v1", code: error?.message === "zstack_case_limit" ? "zstack_case_limit" : "zstack_eval_failed" }); return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController(), cancel = () => controller.abort();
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  runCli(process.argv.slice(2), { signal: controller.signal }).then(code => { process.exitCode = code; })
    .finally(() => { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); });
}
