#!/usr/bin/env node
// ──────────────────────────────────────────────────────────
// models-list.mjs — authoring helper: show real model ids
// ──────────────────────────────────────────────────────────
//
// `pnpm models:list <agent>` — prints (a) the models currently CURATED for
// that family in catalogs/models-v1.json, and (b) where supported, the LIVE
// model ids the installed agent actually accepts, so when you (or an AI agent)
// add a model you paste the EXACT correct id instead of guessing.
//
// Live id sources:
//   cursor          → `cursor-agent models`
//   claude / codex  → no simple list command. Claude: the bundled SDK's
//     query.supportedModels() (run the app, or `pnpm agents:smoke`); Codex:
//     the app-server `model/list`.
//
// Usage: pnpm models:list            (all families, curated)
//        pnpm models:list claude     (one family)
//        pnpm models:list cursor     (curated + live `cursor-agent models`)
// ──────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = join(HERE, "..", "catalogs", "models-v1.json");

// agentId substring → family (mirrors agentFamily in model-catalog.ts).
function familyOf(arg) {
  const a = (arg ?? "").toLowerCase();
  if (a.includes("claude")) return "claude";
  if (a.includes("codex") || a.includes("openai")) return "codex";
  if (a.includes("cursor")) return "cursor";
  return a; // allow passing the family name directly
}

const LIVE = {
  cursor: { bin: "cursor-agent", args: ["models"] },
};
const NO_LIVE_CLI = {
  claude: "no list CLI — run the app or `pnpm agents:smoke` (SDK query.supportedModels())",
  codex: "no list CLI — the app-server `model/list` RPC (run the app)",
};

function printCurated(catalog, family) {
  const list = catalog.families[family] ?? [];
  console.log(`\n# CURATED (catalogs/models-v1.json → families.${family}) — ${list.length} model(s)`);
  if (!list.length) {
    console.log("  (none)");
    return;
  }
  for (const m of list) {
    const bits = [
      m.badge ? `[${m.badge}]` : "",
      m.effortLevels ? `effort=${m.effortLevels.join("/")}` : "",
      m.supportsFast ? "fast" : "",
      m.minCliVersion ? `needs CLI>=${m.minCliVersion}` : "",
    ].filter(Boolean).join(" ");
    console.log(`  ${m.value.padEnd(28)} ${m.label}${bits ? "  " + bits : ""}`);
  }
}

function printLive(family) {
  const spec = LIVE[family];
  if (!spec) {
    if (NO_LIVE_CLI[family]) console.log(`\n# LIVE (${family}): ${NO_LIVE_CLI[family]}`);
    return;
  }
  console.log(`\n# LIVE \`${spec.bin} ${spec.args.join(" ")}\``);
  try {
    const out = execFileSync(spec.bin, spec.args, { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "ignore"] });
    console.log(out.trim() || "  (empty)");
  } catch {
    console.log(`  (skipped — \`${spec.bin}\` not installed/authed)`);
  }
}

function main() {
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
  const arg = process.argv[2];
  const families = arg ? [familyOf(arg)] : Object.keys(catalog.families);
  for (const family of families) {
    if (!catalog.families[family]) {
      console.error(`Unknown family "${family}". Known: ${Object.keys(catalog.families).join(", ")}`);
      process.exitCode = 1;
      continue;
    }
    console.log(`\n${"═".repeat(60)}\n${family.toUpperCase()}`);
    printCurated(catalog, family);
    if (arg) printLive(family); // only shell the CLI when a specific agent is asked
  }
  console.log("\nTip: copy a LIVE id into catalogs/models-v1.json, then `pnpm models:verify`.");
}

main();
