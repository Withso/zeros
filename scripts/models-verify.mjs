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
//   3. MODEL-ID EXISTENCE GATE (no API — reads the bundled CLI BINARY): warns
//      when a curated claude id is one the pinned CLI has never heard of. This
//      is layer 2's mirror image and the direction it cannot see — see
//      checkModelIdsKnownToCli for why a version number can't express it.
//
//   --live (best-effort, opt-in): shells the agents that expose a model-list
//      command (`cursor-agent models`) and warns on curated ids the live
//      account doesn't list. Agents without a simple list command
//      (claude / codex) are noted — use `pnpm models:list` / the app.
//
// Exits non-zero on any STRUCTURAL/CONSISTENCY error (so it can gate CI).
// Warnings (version gate, live drift) never fail the build.
// ──────────────────────────────────────────────────────────

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

// ── 3. model-ID existence: is the curated id still KNOWN to the CLI? ──

/** Model-id-shaped literals in the Claude binary: `claude-<word>-<digit>…`.
 *  The binary is a `bun build --compile` blob that keeps its string table in the
 *  clear, so every id the CLI accepts appears verbatim — including the regexes
 *  and the `[1m]` variants. Verified against CLI 2.1.220: 42 distinct ids, among
 *  them all five curated ones plus unreleased ones (`claude-mythos-5`). */
const CLAUDE_MODEL_ID_RE = /claude-[a-z]+-[0-9][0-9a-z.-]*/g;

/** Overlap kept between chunks. The longest real id is ~26 chars
 *  (`claude-sonnet-4-5-20250929`), so 64 bytes is comfortably more than any id
 *  can straddle. */
const SCAN_OVERLAP = 64;

/** Below this many distinct ids, assume the EXTRACTION broke — a compressed or
 *  re-encoded string table — rather than that Anthropic deleted its whole model
 *  list. 2.1.220 yields 42, so this is a wide margin.
 *
 *  This floor is what makes the gate safe to hard-fail on. Without it, the day
 *  the binary format changes every curated model reads as "removed" and the
 *  check goes red on all five at once — and a check whose failure mode is a
 *  false red on everything is a check that gets deleted. */
const MIN_PLAUSIBLE_IDS = 8;

/** Distinct model-id literals in a binary, streamed so a ~275 MiB blob costs
 *  ~0.4s and bounded memory instead of a 275 MiB string.
 *
 *  Reads as `latin1` — a byte-for-byte mapping, so no multi-byte decode can
 *  split or mangle an ASCII id and no U+FFFD replacement chars appear mid-match.
 *
 *  A match touching the end of a chunk is DROPPED and re-found via the carry, so
 *  it is never recorded truncated. That matters for exactly one case, which is
 *  also the case this whole gate exists for: if the binary contains only
 *  `claude-opus-5-1` and the chunk splits it after `claude-opus-5`, recording
 *  the truncation would report the retired `claude-opus-5` as still present.
 *
 *  Returns null if the path can't be opened (caller decides whether that's
 *  fatal). */
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

/** The set of model ids the PINNED Claude CLI knows, read off the real binary.
 *  Returns null when the platform package isn't installed for this os/cpu —
 *  it's an OPTIONAL dependency, so `--no-optional` installs legitimately lack
 *  it. `check:runtime-pins` is what fails loudly on that; here it degrades to a
 *  note. */
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
  warnings.push("codex live ids are gated by `pnpm codex:smoke` (model/list on the booted app-server).");
  warnings.push("cursor live ids are gated by `pnpm cursor:smoke` when a key is present (--require-models to enforce).");
  warnings.push("claude live ids: use `pnpm models:list claude` or the running app (no simple list CLI).");
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
  // Reads the ~275 MiB binary (~0.4s). Worth it on the only path that can catch
  // a retired model id; `notes` are always soft, `missing` gates under --strict.
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

if (import.meta.url === `file://${process.argv[1]}`) main();
