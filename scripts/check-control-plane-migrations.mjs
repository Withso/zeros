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
// records applied files by filename plus a durable content checksum. The
// forward-only comparison still catches edits before deploy; the runtime
// checksum catches a mismatched artifact or database afterward. A fresh
// database built from edited history would otherwise diverge from production.
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
//   3. Migration SQL contains no top-level transaction-control statement. The
//      runner owns BEGIN/COMMIT so DDL and its ledger row stay atomic.
//   4. Forward-only vs origin/main — every migration on main is present and
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

function maskQuotedSql(sql) {
  const masked = sql.split("");
  let state = "normal";
  let blockDepth = 0;
  let dollarTag = "";
  const blank = (start, length) => {
    for (let offset = 0; offset < length; offset += 1) {
      if (masked[start + offset] !== "\n" && masked[start + offset] !== "\r") {
        masked[start + offset] = " ";
      }
    }
  };

  for (let index = 0; index < sql.length; index += 1) {
    const pair = sql.slice(index, index + 2);
    const character = sql[index];
    if (state === "line-comment") {
      if (character === "\n") state = "normal";
      else blank(index, 1);
      continue;
    }
    if (state === "block-comment") {
      if (pair === "/*") {
        blank(index, 2);
        blockDepth += 1;
        index += 1;
      } else if (pair === "*/") {
        blank(index, 2);
        blockDepth -= 1;
        index += 1;
        if (blockDepth === 0) state = "normal";
      } else {
        blank(index, 1);
      }
      continue;
    }
    if (state === "dollar-quote") {
      if (sql.startsWith(dollarTag, index)) {
        blank(index, dollarTag.length);
        index += dollarTag.length - 1;
        state = "normal";
      } else {
        blank(index, 1);
      }
      continue;
    }
    if (
      state === "single-quote" ||
      state === "escape-string" ||
      state === "double-quote"
    ) {
      const delimiter = state === "double-quote" ? '"' : "'";
      blank(index, 1);
      if (character === delimiter && sql[index + 1] === delimiter) {
        blank(index + 1, 1);
        index += 1;
      } else if (
        state === "escape-string" &&
        character === "\\" &&
        index + 1 < sql.length
      ) {
        blank(index + 1, 1);
        index += 1;
      } else if (character === delimiter) {
        state = "normal";
      }
      continue;
    }
    if (pair === "--") {
      blank(index, 2);
      index += 1;
      state = "line-comment";
    } else if (pair === "/*") {
      blank(index, 2);
      index += 1;
      blockDepth = 1;
      state = "block-comment";
    } else if (character === "'" || character === '"') {
      blank(index, 1);
      const escapePrefix =
        character === "'" &&
        /[eE]/u.test(sql[index - 1] ?? "") &&
        !/[A-Za-z0-9_$]/u.test(sql[index - 2] ?? "");
      state =
        character === '"'
          ? "double-quote"
          : escapePrefix
            ? "escape-string"
            : "single-quote";
    } else if (character === "$") {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(index));
      if (tag) {
        dollarTag = tag[0];
        blank(index, dollarTag.length);
        index += dollarTag.length - 1;
        state = "dollar-quote";
      }
    }
  }
  return masked.join("");
}

function topLevelTransactionControl(sql) {
  const masked = maskQuotedSql(sql);
  const statement =
    /(?:^|;)(\s*)(ABORT|BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE(?:\s+SAVEPOINT)?|START\s+TRANSACTION|PREPARE\s+TRANSACTION|SET\s+TRANSACTION|SET\s+SESSION\s+CHARACTERISTICS\s+AS\s+TRANSACTION)\b/giu;
  const match = statement.exec(masked);
  if (!match) return null;
  const prefixLength = match[0].startsWith(";") ? 1 : 0;
  const keywordIndex = match.index + prefixLength + match[1].length;
  return {
    keyword: match[2].replace(/\s+/gu, " ").toUpperCase(),
    line: masked.slice(0, keywordIndex).split("\n").length,
  };
}

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

// 3. Transaction ownership. Quoted function bodies and comments are masked so
// PL/pgSQL BEGIN/END blocks remain valid while script-level control is refused.
for (const f of named) {
  const control = topLevelTransactionControl(
    readFileSync(`${DIR}/${f}`, "utf8"),
  );
  if (control) {
    errs.push(
      `${f} contains top-level transaction control ${control.keyword} at line ${control.line} — migrate.ts owns the transaction and ledger commit`,
    );
  }
}

// 4. Forward-only vs origin/main.
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
          `migration ${f} was EDITED vs origin/main — an applied filename and checksum are immutable, so this file no longer describes deployed reality. Add a new migration instead.`,
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
  `✓ check:control-plane-migrations — ${named.length} migration(s), naming + sequence + transaction ownership${mainFiles ? ` + forward-only vs origin/main:${mainBaseline.dir}` : ""} OK`,
);
