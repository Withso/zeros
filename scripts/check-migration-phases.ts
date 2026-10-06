import { applyReviewedExpandExceptions } from "./migration-expand-exceptions.js";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  expandMigrationViolations,
  migrationPhase,
} from "../apps/control-plane/src/migration-phase.js";

export function lintMigrationPhase(file: string, sql: string): string[] {
  try {
    const declaration = migrationPhase(file, sql);
    return declaration.phase === "expand"
      ? expandMigrationViolations(applyReviewedExpandExceptions(file, sql)).map(
          (statement) =>
            `${file}: expand migrations may not contain ${statement}.`,
        )
      : [];
  } catch (error) {
    return [
      error instanceof Error
        ? error.message
        : `Invalid migration phase in ${file}.`,
    ];
  }
}

async function main() {
  const directory = "apps/control-plane/migrations";
  const files = (await readdir(directory))
    .filter((file) => /^\d{4}_[a-z0-9_]+\.sql$/.test(file))
    .sort();
  const errors = (
    await Promise.all(
      files.map(async (file) =>
        lintMigrationPhase(
          file,
          await readFile(path.join(directory, file), "utf8"),
        ),
      ),
    )
  ).flat();
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else
    console.log(
      `Migration phases verified (${files.filter((file) => Number(file.slice(0, 4)) >= 122).length} phased migrations; 0001–0121 remain legacy).`,
    );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  void main().catch(() => {
    console.error(
      "Migration phase lint could not read the migration directory.",
    );
    process.exitCode = 1;
  });
