// ──────────────────────────────────────────────────────────
// check-migrations-forward-only — guard the engine SQLite migration ladder
// ──────────────────────────────────────────────────────────
//
// The shipped zeros.db is advanced by an ORDERED, append-only list of migrations
// (apps/desktop/src/engine/db/migrations.ts). runMigrations() skips versions already recorded
// in schema_migrations, so EDITING or REORDERING an already-released migration
// NEVER re-runs on existing users — their on-disk DB silently diverges from a
// fresh install (wrong schema, FTS/trigger drift, unrecoverable loss of chats).
//
// This Preflight guard enforces the append-only invariant:
//   1. HEAD's ladder is well-formed — versions are 1..N contiguous, unique, and
//      in order; every entry has a non-empty name + up SQL.
//   2. Forward-only vs origin/main — every migration on main is present and
//      BYTE-IDENTICAL on HEAD (same version, name, up); HEAD may only ADD
//      entries with a version greater than main's current max.
//
// Structural, not regex: it imports the real `MIGRATIONS` array (the `up` bodies
// are multi-line template literals a regex can't capture). Pure + offline —
// migrations.ts only TYPE-imports better-sqlite3, which tsx erases, so importing
// it runs no DB code. Run: `pnpm check:migrations`. Needs origin/main fetched
// (CI: actions/checkout with fetch-depth: 0); when it isn't, the cross-ref check
// is skipped with a notice and only (1) runs.
// ──────────────────────────────────────────────────────────

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

interface Migration {
  version: number;
  name: string;
  up: string;
}

const MIG_PATH = "apps/desktop/src/engine/db/migrations.ts";
const LEGACY_MIG_PATH = "src/engine/db/migrations.ts";

async function importMigrations(fileUrl: string): Promise<Migration[]> {
  const mod = (await import(fileUrl)) as { MIGRATIONS?: Migration[] };
  if (!Array.isArray(mod.MIGRATIONS)) {
    throw new Error(`no MIGRATIONS export found in ${fileUrl}`);
  }
  return mod.MIGRATIONS;
}

function headMigrations(): Promise<Migration[]> {
  return importMigrations(pathToFileURL(join(process.cwd(), MIG_PATH)).href);
}

async function mainMigrations(): Promise<Migration[] | null> {
  let src: string;
  try {
    try {
      src = execFileSync("git", ["show", `origin/main:${MIG_PATH}`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      // One-time repository move: compare the new working-tree location with
      // the legacy path until origin/main contains apps/desktop/.
      src = execFileSync("git", ["show", `origin/main:${LEGACY_MIG_PATH}`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    }
  } catch {
    return null; // origin/main not fetched, or the file is absent there
  }
  // Write to a temp .mts so tsx transpiles + imports it (the only import in the
  // file is `import type`, erased at load — no runtime deps to resolve).
  const dir = mkdtempSync(join(tmpdir(), "zeros-mig-main-"));
  const file = join(dir, "migrations.mts");
  writeFileSync(file, src);
  return importMigrations(pathToFileURL(file).href);
}

function validateInternal(migs: Migration[]): string[] {
  const errs: string[] = [];
  if (migs.length === 0) errs.push("MIGRATIONS is empty");
  const seen = new Set<number>();
  migs.forEach((m, i) => {
    if (m.version !== i + 1) {
      errs.push(
        `index ${i}: version ${m.version} breaks the contiguous 1..N order (expected ${i + 1}) — append in version order`,
      );
    }
    if (seen.has(m.version)) errs.push(`duplicate version ${m.version}`);
    seen.add(m.version);
    if (!m.name?.trim()) errs.push(`migration ${m.version}: empty name`);
    if (!m.up?.trim()) errs.push(`migration ${m.version}: empty up SQL`);
  });
  return errs;
}

function validateForwardOnly(main: Migration[], head: Migration[]): string[] {
  const errs: string[] = [];
  const headByVersion = new Map(head.map((m) => [m.version, m]));
  for (const m of main) {
    const h = headByVersion.get(m.version);
    if (!h) {
      errs.push(
        `migration ${m.version} ("${m.name}") exists on origin/main but is MISSING on HEAD — released migrations are append-only; never delete one`,
      );
      continue;
    }
    if (h.name !== m.name) {
      errs.push(
        `migration ${m.version}: name changed (main: "${m.name}" → HEAD: "${h.name}") — a released migration must not be edited`,
      );
    }
    if (h.up !== m.up) {
      errs.push(
        `migration ${m.version} ("${m.name}"): up SQL changed — a released migration NEVER re-runs on existing users, so editing it corrupts their on-disk DB. Add a NEW migration instead.`,
      );
    }
  }
  const maxMain = main.reduce((mx, m) => Math.max(mx, m.version), 0);
  for (const h of head) {
    if (h.version <= maxMain && !main.some((m) => m.version === h.version)) {
      errs.push(
        `migration ${h.version} ("${h.name}") was inserted at or below the released max (${maxMain}) — a new migration must use a version greater than ${maxMain}`,
      );
    }
  }
  return errs;
}

async function main(): Promise<void> {
  const head = await headMigrations();
  const errs = validateInternal(head);

  const mainMigs = await mainMigrations();
  if (mainMigs) {
    errs.push(...validateForwardOnly(mainMigs, head));
  } else {
    console.log(
      "ℹ check:migrations — origin/main not available; ran HEAD-internal checks only (in CI use actions/checkout with fetch-depth: 0).",
    );
  }

  if (errs.length > 0) {
    console.error(
      "✖ migration ladder is not forward-only / well-formed:\n" +
        errs.map((e) => `  • ${e}`).join("\n"),
    );
    process.exit(1);
  }
  console.log(
    `✓ check:migrations — ${head.length} migrations, forward-only ${mainMigs ? "vs origin/main" : "(HEAD-only)"} OK`,
  );
}

main().catch((err) => {
  console.error("✖ check:migrations failed:", err);
  process.exit(1);
});
