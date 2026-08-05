#!/usr/bin/env node
// ──────────────────────────────────────────────────────────
// check-control-plane-migrations — Postgres migration forward-only guard
// ──────────────────────────────────────────────────────────
//
// One of the two migration ladders in this repo (`check:migrations` covers the
// engine's SQLite ladder). apps/control-plane/migrations/ has the higher blast radius:
// it owns the control plane's Postgres — every team, membership, invitation,
// and audit row.
//
// The specific failure this prevents: `runMigrations` (apps/control-plane/src/migrate.ts)
// records applied files by FILENAME ONLY — no checksum, no content hash. It
// skips any name already in `schema_migrations`. So editing an
// already-released migration NEVER re-runs on a database that has it, and the
// file silently stops describing the schema that is actually deployed. A
// fresh database built from the repo then diverges from production, and the
// divergence is invisible until something breaks on one and not the other.
// Renaming a released file is worse: it re-runs from scratch against a live
// database and fails on the first CREATE TABLE.
//
// That runner also runs at service BOOT (apps/control-plane/src/index.ts awaits
// runMigrations before serve()), so a migration that throws is not a failed
// deploy — it is a crash-loop with no control plane.
//
// Checks:
//   1. Filenames are `<4-digit sequence>_<snake_name>.sql` — the shape
//      migrate.ts's own `/^\d{4}_.+\.sql$/` filter accepts. A file that
//      misses this pattern is silently NEVER APPLIED, which is the quietest
//      possible failure.
//   2. Sequence numbers are unique and contiguous from 0001 — a duplicate
//      means two PRs picked the same number (lexical sort then applies them
//      in an arbitrary-but-stable order that neither author intended); a gap
//      usually means a migration was deleted.
//   3. Forward-only vs origin/main — every migration on main is present and
//      BYTE-IDENTICAL on HEAD; new files must use a sequence above main's max.
//
// Byte-identical is deliberate, including comments: the guard cannot tell a
// comment from SQL reliably (`--` appears inside string literals), and
// "it's only a comment" is exactly how a real edit gets waved through. A
// released migration is a historical record — fix the text in a NEW migration
// or in the docs, never in place.
//
// Pure Node — no Postgres, no Docker. Needs origin/main fetched (CI: checkout
// with fetch-depth 0 + `git fetch origin main`); when absent, checks 1-2 still
// run and 3 is skipped with a notice.
// Run: `pnpm check:control-plane-migrations`. Exit 0 = ok, 1 = violation.
// ──────────────────────────────────────────────────────────

import { readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const DIR = "apps/control-plane/migrations";
// The migration tree moved from backend/ in the repository-layout migration.
// A pull request based on a pre-move origin/main must still compare every
// released file against that legacy path; treating an absent new path as an
// empty baseline would silently allow edits during the move itself.
const LEGACY_DIR = "backend/migrations";
const NAME_RE = /^([0-9]{4})_[a-z0-9_]+\.sql$/;
const seq = (f) => Number(f.slice(0, 4));

const errs = [];

// Every .sql in the directory — NOT just the well-named ones, so check 1 can
// actually see a file migrate.ts would ignore.
const files = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

if (files.length === 0) errs.push(`no .sql migrations found in ${DIR}/`);

// 1. Naming.
const named = files.filter((f) => NAME_RE.test(f));
for (const f of files) {
  if (!NAME_RE.test(f)) {
    errs.push(
      `bad filename: ${f} (expected <4-digit sequence>_<snake_name>.sql) — migrate.ts filters on this pattern, so this file would NEVER be applied`,
    );
  }
}

// 2. Unique + contiguous sequence.
for (let i = 0; i < named.length; i++) {
  const expected = i + 1;
  if (seq(named[i]) !== expected) {
    const pad = (n) => String(n).padStart(4, "0");
    errs.push(
      i > 0 && seq(named[i]) === seq(named[i - 1])
        ? `duplicate sequence ${pad(seq(named[i]))}: ${named[i - 1]} and ${named[i]} — two branches picked the same number`
        : `sequence gap or misorder at ${named[i]} (expected ${pad(expected)}_*) — migrations are contiguous from 0001`,
    );
    break; // one report; everything after a break is noise
  }
}

// 3. Forward-only vs origin/main.
function gitShow(ref) {
  return execFileSync("git", ["show", ref], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function migrationsAt(ref, dir) {
  try {
    const files = execFileSync(
      "git",
      ["ls-tree", "--name-only", ref, `${dir}/`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    )
      .split("\n")
      .filter((p) => p.endsWith(".sql"))
      .map((p) => p.replace(`${dir}/`, ""));
    return files.length > 0 ? { dir, files } : null;
  } catch {
    return null;
  }
}

let mainBaseline = null;
try {
  // Resolve the current location first so this naturally switches after the
  // repository-layout migration reaches main. Fall back only while main still
  // contains the released ladder at its former path.
  mainBaseline =
    migrationsAt("origin/main", DIR) ?? migrationsAt("origin/main", LEGACY_DIR);
} catch {
  mainBaseline = null; // origin/main not fetched
}
const mainFiles = mainBaseline?.files ?? null;

if (mainFiles) {
  const maxMainSeq = mainFiles
    .filter((f) => NAME_RE.test(f))
    .reduce((mx, f) => Math.max(mx, seq(f)), 0);

  for (const f of mainFiles) {
    if (!files.includes(f)) {
      errs.push(
        `migration ${f} is on origin/main but MISSING on HEAD — released migrations are append-only; deleting one makes a fresh database diverge from every deployed one`,
      );
      continue;
    }
    try {
      if (
        gitShow(`origin/main:${mainBaseline.dir}/${f}`) !==
        readFileSync(`${DIR}/${f}`, "utf8")
      ) {
        errs.push(
          `migration ${f} was EDITED vs origin/main — schema_migrations records by FILENAME, so this never re-runs on a database that already applied it; the file stops describing deployed reality. Add a new migration instead.`,
        );
      }
    } catch {
      /* unreadable on one side — the missing/extra checks already cover it */
    }
  }

  for (const f of named) {
    if (seq(f) <= maxMainSeq && !mainFiles.includes(f)) {
      errs.push(
        `migration ${f} was inserted at or below the released max (${String(maxMainSeq).padStart(4, "0")}) — a new migration must use a higher sequence, or it lands out of order on databases that already migrated`,
      );
    }
  }
} else {
  console.log(
    "ℹ check:control-plane-migrations — origin/main unavailable; ran naming + sequence only (in CI use actions/checkout with fetch-depth: 0).",
  );
}

if (errs.length > 0) {
  console.error("✖ check:control-plane-migrations — violation(s):");
  for (const e of errs) console.error(`  • ${e}`);
  process.exit(1);
}
console.log(
  `✓ check:control-plane-migrations — ${named.length} migration(s), naming + sequence${mainFiles ? ` + forward-only vs origin/main:${mainBaseline.dir}` : ""} OK`,
);
