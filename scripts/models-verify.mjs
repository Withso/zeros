#!/usr/bin/env node
// A minimum CLI version cannot detect retired model IDs. Qualify catalog
// structure, the installed CLI version, and IDs from each provider's authority.
// CLI-version and model-ID drift fail under --strict; incomplete binary
// extraction stays inconclusive rather than reporting every model removed.

import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

import { resolveClaudeCliSource } from "./stage-claude-cli.mjs";
import { qualifiesAgainst } from "./cursor-curated-ids.mjs";
import { discoverAll } from "./agent-runtime/models.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CATALOG_PATH = join(ROOT, "catalogs", "models-v1.json");

const VALID_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultracode"];
const KNOWN_KEYS = new Set([
  "value",
  "label",
  "description",
  "badge",
  "effortLevels",
  "defaultEffort",
  "supportsFast",
  "minCliVersion",
  "liveRequired",
]);

function baseSlug(id) {
  return String(id).replace(/\[[^\]]*\]\s*$/, "");
}

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
      if (m.description !== undefined && typeof m.description !== "string") {
        errors.push(`${at}.description must be a string`);
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
      if (m.defaultEffort !== undefined &&
          (!VALID_EFFORTS.includes(m.defaultEffort) || !Array.isArray(m.effortLevels) || !m.effortLevels.includes(m.defaultEffort))) {
        errors.push(`${at}.defaultEffort must be a supported effortLevels value`);
      }
      if (m.supportsFast !== undefined && typeof m.supportsFast !== "boolean") {
        errors.push(`${at}.supportsFast must be a boolean`);
      }
      if (m.minCliVersion !== undefined && typeof m.minCliVersion !== "string") {
        errors.push(`${at}.minCliVersion must be a string`);
      }
      if (m.liveRequired !== undefined && typeof m.liveRequired !== "boolean") {
        errors.push(`${at}.liveRequired must be a boolean`);
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

  // Fallbacks are models an adapter may run on the user's behalf, so each one
  // must be a curated row of its family that can run without live discovery.
  if (catalog.fallbacks !== undefined) {
    if (!catalog.fallbacks || typeof catalog.fallbacks !== "object" || Array.isArray(catalog.fallbacks)) {
      errors.push("`fallbacks` must be an object");
    } else {
      for (const [family, list] of Object.entries(catalog.fallbacks)) {
        if (!Array.isArray(list)) {
          errors.push(`fallbacks.${family} must be an array`);
          continue;
        }
        const curated = new Map((catalog.families[family] ?? []).map((m) => [m?.value, m]));
        const seen = new Set();
        for (const [i, value] of list.entries()) {
          const at = `fallbacks.${family}[${i}]`;
          if (typeof value !== "string" || value.length === 0) {
            errors.push(`${at} must be a non-empty string`);
            continue;
          }
          if (seen.has(value)) errors.push(`${at} "${value}" is a duplicate`);
          seen.add(value);
          const model = curated.get(value);
          if (!model) errors.push(`${at} → "${value}" is not a curated ${family} model`);
          else if (model.liveRequired === true) errors.push(`${at} → "${value}" is liveRequired and cannot be a fallback`);
        }
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

/** Read the linked SDK, not a .pnpm glob that can select an obsolete install. */
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


/** Bun-compiled Claude binaries retain model-ID literals in their string table. */
const CLAUDE_MODEL_ID_RE = /claude-[a-z]+-[0-9][0-9a-z.-]*/g;

/** Retain more than the longest model ID so a chunk boundary cannot truncate it. */
const SCAN_OVERLAP = 64;

/** Too few IDs indicate broken extraction, not wholesale model retirement. */
const MIN_PLAUSIBLE_IDS = 8;

/** Stream with byte-preserving latin1. Recheck edge matches in the next chunk
 * so a partial newer ID cannot falsely prove an older one still exists. */
export function scanModelIds(binaryPath, re = CLAUDE_MODEL_ID_RE) {
  const CHUNK = 1 << 22; // 4 MiB
  let fd;
  let size;
  try {
    fd = openSync(binaryPath, "r");
    size = fstatSync(fd).size;
  } catch {
    if (fd !== undefined) closeSync(fd);
    return null;
  }
  const found = new Set();
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    let carry = "";
    let pos = 0;
    let n;
    while ((n = readSync(fd, buf, 0, CHUNK, pos)) > 0) {
      pos += n;
      const s = carry + buf.toString("latin1", 0, n);
      // Compare against the real size rather than inferring EOF from a short
      // read: only at true EOF is a match ending at the buffer edge complete.
      const atEof = pos >= size;
      for (const m of s.matchAll(re)) {
        if (!atEof && m.index + m[0].length === s.length) continue;
        found.add(m[0]);
      }
      carry = s.slice(-SCAN_OVERLAP);
    }
  } finally {
    closeSync(fd);
  }
  return found;
}

/** Optional platform dependencies can be absent; runtime-pins owns that
 * failure while this scan reports unavailable evidence. */
export function knownClaudeModelIds() {
  try {
    return scanModelIds(resolveClaudeCliSource().path);
  } catch {
    return null;
  }
}

/** Every curated claude model whose id the bundled CLI has never heard of.
 *
 *  WHY THIS IS NOT COVERED BY `checkCliVersionGate`: that gate catches a model
 *  too NEW for the pinned CLI (`minCliVersion` > bundled). Its mirror image — a
 *  model the CLI has DROPPED — produces the identical user-visible failure (the
 *  picker offers it, minCliVersion is satisfied, the CLI silently downgrades to
 *  something older) and was undetectable by construction: retiring an id changes
 *  no version number, so there is no threshold to compare against. The only
 *  source of truth is the binary's own accepted-id list.
 *
 *  Compares BASE slugs, not the full curated value. `[1m]` is a context-window
 *  modifier the CLI parses off the id, and only some ids carry the bracket form
 *  as a literal — 2.1.220 ships `claude-opus-5[1m]` but NOT `claude-fable-5[1m]`
 *  — so matching the full value would fire on models that run fine.
 *
 *  Claude only — the string-table scan does not port. Codex is a native Rust
 *  binary that packs ids contiguously (`gpt-5.2-codexgpt-5.2-codex`), so set
 *  membership is unreliable there; Cursor resolves models server-side, and
 *  neither `composer-2.5` nor `grok-4.5` appears anywhere in `@cursor/sdk`.
 *
 *  The OTHER TWO ARE STILL GATED, just not from here — each is checked against
 *  its own authoritative source, by the smoke that already has that runtime up:
 *    • codex  → `pnpm codex:smoke` asks the booted app-server for `model/list`.
 *      The binary's own answer, no credentials, so it runs on every PR.
 *    • cursor → `pnpm cursor:smoke` compares `Cursor.models.list` when
 *      CURSOR_API_KEY is set, and says so loudly when it is not;
 *      `--require-models` turns that skip into a failure. Env var only — the
 *      app's secrets.json holds safeStorage-encrypted values.
 *  Keep those in mind before concluding a family is unverified.
 *
 *  Returns { missing, notes }: `missing` gates (hard error under `--strict`),
 *  `notes` never do — an inconclusive scan must not turn CI red. */
export function checkModelIdsKnownToCli(catalog, knownIds) {
  const missing = [];
  const notes = [];
  if (!knownIds) {
    notes.push(
      "model-ID existence check skipped — the Claude platform binary did not " +
        "resolve for this os/cpu (it is an OPTIONAL dependency). " +
        "`pnpm check:runtime-pins` is the gate that fails loudly on that.",
    );
    return { missing, notes };
  }
  if (knownIds.size < MIN_PLAUSIBLE_IDS) {
    notes.push(
      `model-ID existence check INCONCLUSIVE — only ${knownIds.size} model-id ` +
        `literals found in the bundled CLI binary (expected dozens; 2.1.220 has 42). ` +
        `The binary's string table is most likely no longer stored in the clear, ` +
        `so the scan technique in scanModelIds needs revisiting. Reporting this ` +
        `instead of flagging every curated model as removed.`,
    );
    return { missing, notes };
  }
  for (const m of catalog.families?.claude ?? []) {
    const slug = baseSlug(m.value);
    if (!knownIds.has(slug)) {
      missing.push(
        `claude model "${m.value}" is NOT a model id the bundled CLI knows ` +
          `(scanned ${knownIds.size} ids in the pinned claude binary; "${slug}" ` +
          `is absent). Nothing enforces the id at runtime, so the picker WILL ` +
          `still offer it and the CLI will SILENTLY DOWNGRADE — same symptom as ` +
          `a too-low minCliVersion, but no version bump can fix it because the id ` +
          `is gone. Either the model was retired (drop it from ` +
          `catalogs/models-v1.json, with its aliases and defaultFavorites) or it ` +
          `was renamed (update the id).`,
      );
    }
  }
  return { missing, notes };
}


function liveCheck(catalog) {
  const warnings = [];
  const tryList = (bin, args, family, parse) => {
    try {
      const out = execFileSync(bin, args, { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "ignore"] });
      const live = parse(out);
      if (!live.length) return;
      const liveSet = new Set(live);
      for (const m of catalog.families[family] ?? []) {
        const qualified = family === "cursor"
          ? qualifiesAgainst(m, liveSet)
          : liveSet.has(m.value) || m.liveRequired === true;
        if (!qualified) {
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
  warnings.push("codex live ids are gated by `pnpm codex:smoke` (model/list on the booted app-server).");
  warnings.push("cursor live ids are gated by `pnpm cursor:smoke` when a key is present (--require-models to enforce).");
  warnings.push("claude live ids: use `pnpm models:list claude` or the running app (no simple list CLI).");
  return warnings;
}

async function main() {
  // Fail strict qualification before a too-new model silently falls back at runtime.
  const strict = process.argv.includes("--strict");
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
  if (process.argv.includes("--require-complete") || (process.argv.includes("--bundled") && process.argv.includes("--live"))) {
    const validation = validateCatalog(catalog);
    const discovery = await discoverAll({ root: ROOT, additionalPublicIds: JSON.parse(readFileSync(join(ROOT, "scripts/agent-runtime/public-model-ids.json"), "utf8")) });
    const complete = discovery.every((source) => source.status === "complete");
    const drift = discovery.some((source) => source.data.requiredCuratedMissing?.length);
    const success = validation.errors.length === 0 && complete && !drift;
    if (process.argv.includes("--json")) console.log(JSON.stringify({ schema: 1, status: success ? "passed" : "incomplete", errors: validation.errors, discovery }));
    else {
      for (const source of discovery) console.log(`${source.provider}: ${source.status}; ${source.status === "complete" ? `${source.data.items.length} models, ${source.data.requiredCuratedMissing.length} required curated IDs absent` : source.reason}`);
      console.log(success ? "Bundled model discovery complete." : "Bundled model discovery incomplete or drifting; unavailable probes are not passes.");
    }
    process.exitCode = success ? 0 : 1;
    return;
  }
  const { errors, warnings } = validateCatalog(catalog);
  const versionWarnings = checkCliVersionGate(catalog, bundledClaudeCliVersion());
  const { missing, notes } = checkModelIdsKnownToCli(catalog, knownClaudeModelIds());
  const live = process.argv.includes("--live") ? liveCheck(catalog) : [];

  const hardErrors = strict
    ? [...errors, ...versionWarnings, ...missing]
    : errors;
  const softWarnings = strict
    ? [...warnings, ...notes, ...live]
    : [...warnings, ...versionWarnings, ...missing, ...notes, ...live];

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

if (import.meta.url === `file://${process.argv[1]}`) await main();
