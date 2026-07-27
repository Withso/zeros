#!/usr/bin/env node
// ──────────────────────────────────────────────────────────
// models-verify.mjs — validate the curated model catalog
// ──────────────────────────────────────────────────────────
//
// `pnpm models:verify` (also run in the unit suite via
// models-catalog-validity.test.ts). Two layers:
//
//   1. STRUCTURAL + CONSISTENCY (always, no auth, no agent boot): shape, valid
//      effort levels, no duplicate ids per family, an env var per family,
//      aliases that resolve. This is the always-on gate.
//   2. CLI-VERSION GATE (no API — just reads the bundled SDK's manifest.json):
//      warns when a model's `minCliVersion` exceeds the bundled agent CLI, i.e.
//      it would silently downgrade (the Fable-5-on-2.1.162 class of bug).
//
//   --live (best-effort, opt-in): shells the agents that expose a model-list
//      command (`cursor-agent models`) and warns on curated ids the live
//      account doesn't list. Agents without a simple list command
//      (claude / codex) are noted — use `pnpm models:list` / the app.
//
// Exits non-zero on any STRUCTURAL/CONSISTENCY error (so it can gate CI).
// Warnings (version gate, live drift) never fail the build.
// ──────────────────────────────────────────────────────────

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CATALOG_PATH = join(ROOT, "catalogs", "models-v1.json");

const VALID_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultracode"];
const KNOWN_KEYS = new Set([
  "value",
  "label",
  "badge",
  "effortLevels",
  "supportsFast",
  "minCliVersion",
]);

/** Strip a "[1m]"-style context suffix → base id (for alias-target matching). */
function baseSlug(id) {
  return String(id).replace(/\[[^\]]*\]\s*$/, "");
}

/** Pure structural + consistency validation. Returns {errors, warnings}. */
export function validateCatalog(catalog) {
  const errors = [];
  const warnings = [];
  if (!catalog || typeof catalog !== "object") {
    return { errors: ["catalog is not an object"], warnings };
  }
  if (typeof catalog.version !== "number") errors.push("`version` must be a number");
  if (!catalog.families || typeof catalog.families !== "object") {
    errors.push("`families` must be an object");
    return { errors, warnings };
  }
  if (!catalog.modelEnvVars || typeof catalog.modelEnvVars !== "object") {
    errors.push("`modelEnvVars` must be an object");
  }

  for (const [family, list] of Object.entries(catalog.families)) {
    if (!Array.isArray(list)) {
      errors.push(`families.${family} must be an array`);
      continue;
    }
    if (catalog.modelEnvVars && typeof catalog.modelEnvVars[family] !== "string") {
      warnings.push(`families.${family} has no modelEnvVars entry`);
    }
    const seen = new Set();
    for (const [i, m] of list.entries()) {
      const at = `families.${family}[${i}]`;
      if (!m || typeof m !== "object") {
        errors.push(`${at} is not an object`);
        continue;
      }
      if (typeof m.value !== "string" || m.value.length === 0) {
        errors.push(`${at}.value must be a non-empty string`);
      } else {
        if (seen.has(m.value)) errors.push(`${at}.value "${m.value}" is a duplicate in ${family}`);
        seen.add(m.value);
      }
      if (typeof m.label !== "string" || m.label.length === 0) {
        errors.push(`${at}.label must be a non-empty string`);
      }
      if (m.effortLevels !== undefined) {
        if (!Array.isArray(m.effortLevels)) {
          errors.push(`${at}.effortLevels must be an array`);
        } else {
          for (const e of m.effortLevels) {
            if (!VALID_EFFORTS.includes(e)) {
              errors.push(`${at}.effortLevels has invalid level "${e}" (allowed: ${VALID_EFFORTS.join(", ")})`);
            }
          }
        }
      }
      if (m.supportsFast !== undefined && typeof m.supportsFast !== "boolean") {
        errors.push(`${at}.supportsFast must be a boolean`);
      }
      if (m.minCliVersion !== undefined && typeof m.minCliVersion !== "string") {
        errors.push(`${at}.minCliVersion must be a string`);
      }
      for (const k of Object.keys(m)) {
        if (!KNOWN_KEYS.has(k)) warnings.push(`${at} has unknown key "${k}"`);
      }
    }
  }

  // defaultFavorites must name a curated value in their family (the model a
  // new chat falls back to when the user hasn't starred one).
  if (catalog.defaultFavorites && typeof catalog.defaultFavorites === "object") {
    for (const [family, target] of Object.entries(catalog.defaultFavorites)) {
      if (typeof target !== "string" || target.length === 0) {
        errors.push(`defaultFavorites.${family} must be a non-empty string`);
        continue;
      }
      const values = new Set((catalog.families[family] ?? []).map((m) => m.value));
      if (!values.has(target)) {
        errors.push(`defaultFavorites.${family} → "${target}" is not a curated ${family} model`);
      }
    }
  }

  // Aliases must resolve to a curated value in their family (exact or [1m]-base).
  if (catalog.aliases && typeof catalog.aliases === "object") {
    for (const [family, map] of Object.entries(catalog.aliases)) {
      if (!map || typeof map !== "object") continue;
      const values = new Set((catalog.families[family] ?? []).map((m) => m.value));
      const bases = new Set([...values].map(baseSlug));
      for (const [alias, target] of Object.entries(map)) {
        if (typeof target !== "string" || target.length === 0) {
          errors.push(`aliases.${family}.${alias} target must be a non-empty string`);
        } else if (!values.has(target) && !bases.has(baseSlug(target))) {
          warnings.push(`aliases.${family}.${alias} → "${target}" does not resolve to any curated ${family} model`);
        }
      }
    }
  }

  return { errors, warnings };
}

function parseVersion(v) {
  return String(v).split(".").map((p) => Number.parseInt(p, 10) || 0);
}
function versionGte(have, need) {
  const a = parseVersion(have);
  const b = parseVersion(need);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** Read the bundled claude-code CLI version from the LINKED (active) SDK — its
 *  declared `claudeCodeVersion`, falling back to manifest.json. Reads the
 *  symlinked top-level package (not a `.pnpm` glob, which can match a stale
 *  prior version pnpm keeps around after a bump). */
export function bundledClaudeCliVersion() {
  const linked = join(
    ROOT,
    "node_modules",
    "@anthropic-ai",
    "claude-agent-sdk",
    "package.json",
  );
  try {
    if (existsSync(linked)) {
      const pkg = JSON.parse(readFileSync(linked, "utf8"));
      if (typeof pkg.claudeCodeVersion === "string") return pkg.claudeCodeVersion;
      const manifest = join(dirname(linked), "manifest.json");
      if (existsSync(manifest)) {
        const v = JSON.parse(readFileSync(manifest, "utf8")).version;
        if (typeof v === "string") return v;
      }
    }
  } catch {
    /* ignore — return null */
  }
  return null;
}

/** Warn when a claude model needs a newer CLI than the one bundled. */
export function checkCliVersionGate(catalog, bundledVersion) {
  const warnings = [];
  if (!bundledVersion) return warnings;
  for (const m of catalog.families?.claude ?? []) {
    if (m.minCliVersion && !versionGte(bundledVersion, m.minCliVersion)) {
      warnings.push(
        `claude model "${m.value}" needs CLI >= ${m.minCliVersion} but the bundled SDK pins ${bundledVersion} — the picker WILL still offer it (minCliVersion is not enforced at runtime; see modelsForAgent in model-catalog.ts) and the CLI will SILENTLY DOWNGRADE to an older model. Bump @anthropic-ai/claude-agent-sdk to >= the SDK that ships CLI ${m.minCliVersion}.`,
      );
    }
  }
  return warnings;
}

// ── CLI runner (only when invoked directly) ───────────────

function liveCheck(catalog) {
  const warnings = [];
  const tryList = (bin, args, family, parse) => {
    try {
      const out = execFileSync(bin, args, { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "ignore"] });
      const live = parse(out);
      if (!live.length) return;
      const liveSet = new Set(live);
      for (const m of catalog.families[family] ?? []) {
        if (!liveSet.has(m.value)) {
          warnings.push(`[${family}] curated "${m.value}" not in live \`${bin} ${args.join(" ")}\` output`);
        }
      }
    } catch {
      warnings.push(`[${family}] skipped live check — \`${bin}\` not available/authed`);
    }
  };
  // Cursor exposes a model-list command. It prints "<id> - <label>" per line
  // (skip the "Available models" header); take the id before " - ".
  tryList("cursor-agent", ["models"], "cursor", (o) =>
    o
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.includes(" - ") && !/^available/i.test(l))
      .map((l) => l.split(/\s+-\s+/)[0].trim()),
  );
  warnings.push("claude / codex live ids: use `pnpm models:list <agent>` or the running app (no simple list CLI).");
  return warnings;
}

function main() {
  // `--strict` (used in CI): a CLI-version-gate warning becomes a HARD FAILURE.
  // A curated model that needs a newer CLI than the bundled SDK would silently
  // downgrade at runtime — fail the build so the SDK pin gets bumped instead.
  const strict = process.argv.includes("--strict");
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
  const { errors, warnings } = validateCatalog(catalog);
  const versionWarnings = checkCliVersionGate(catalog, bundledClaudeCliVersion());
  const live = process.argv.includes("--live") ? liveCheck(catalog) : [];

  const hardErrors = strict ? [...errors, ...versionWarnings] : errors;
  const softWarnings = strict
    ? [...warnings, ...live]
    : [...warnings, ...versionWarnings, ...live];

  for (const w of softWarnings) console.warn(`⚠ ${w}`);
  if (hardErrors.length) {
    for (const e of hardErrors) console.error(`✗ ${e}`);
    console.error(
      `\n✗ models:verify FAILED${strict ? " (strict)" : ""} — ${hardErrors.length} error(s) in catalogs/models-v1.json`,
    );
    process.exit(1);
  }
  console.log(
    `✓ models:verify OK${strict ? " (strict)" : ""} — ${Object.values(catalog.families).reduce((n, l) => n + l.length, 0)} models across ${Object.keys(catalog.families).length} families (${softWarnings.length} warning(s))`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
