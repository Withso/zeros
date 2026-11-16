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
//   3. On a release/X.Y.Z branch the ladder must instead be an identical PREFIX
//      of main's. A branch cut before main appended a migration is valid, and a
//      fix cherry-picked from main is checkable. A migration that never landed on
//      main is refused: a later release built from main would number a different
//      migration the same and existing users would skip it.
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

export function validateInternal(migs: Migration[]): string[] {
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

export function validateForwardOnly(main: Migration[], head: Migration[]): string[] {
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

export function validateReleasePrefix(main: Migration[], head: Migration[]): string[] {
  const mainByVersion = new Map(main.map((m) => [m.version, m]));
  return head.flatMap((h) => {
    const m = mainByVersion.get(h.version);
    if (!m) {
      return [
        `migration ${h.version} ("${h.name}") is not on origin/main — land a migration on main first, then cherry-pick it onto the release branch in order`,
      ];
    }
    return m.name === h.name && m.up === h.up
      ? []
      : [
          `migration ${h.version} ("${h.name}") differs from origin/main's copy — a release branch may only carry main's migrations byte-for-byte`,
        ];
  });
}

const RELEASE_BRANCH = /^release\/[0-9]+\.[0-9]+\.[0-9]+$/;

/** The release branch this check runs for, or null on main and feature branches. */
export function releaseBranchOf(
  env: Partial<Record<"GITHUB_BASE_REF" | "GITHUB_REF_NAME", string>>,
  localBranch: string | null,
): string | null {
  // A pull request's base decides, so a PR back into main is checked as main.
  const branch = env.GITHUB_BASE_REF || env.GITHUB_REF_NAME || localBranch || "";
  return RELEASE_BRANCH.test(branch) ? branch : null;
}

function localBranch(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const head = await headMigrations();
  const errs = validateInternal(head);

  const mainMigs = await mainMigrations();
  const release = releaseBranchOf(process.env, localBranch());
  if (mainMigs) {
    errs.push(...(release ? validateReleasePrefix(mainMigs, head) : validateForwardOnly(mainMigs, head)));
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
    `✓ check:migrations — ${head.length} migrations, ${
      !mainMigs ? "forward-only (HEAD-only)" : release ? `${release} is a prefix of origin/main` : "forward-only vs origin/main"
    } OK`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("✖ check:migrations failed:", err);
    process.exit(1);
  });
}
