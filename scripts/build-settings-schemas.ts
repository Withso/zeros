// Build the published settings JSON-schema artifacts from the zod source of
// truth (src/engine/settings/schema.ts). Output is committed into the
// marketing site so the files serve from zeros.build/schemas/ — the URLs
// every settings.toml references via "$schema".
//
//   pnpm schemas:build        (runs under tsx — no bun required, Node-portable)
//
// Re-run whenever the zod schemas change; CI/diff review catches drift.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  repoSettingsSchema,
  SCHEMA_URL_REPO,
  SCHEMA_URL_USER,
  userSettingsSchema,
} from "../src/engine/settings/schema";

// `import.meta.dir` is bun-only; derive the script dir portably so this runs
// under tsx/node too.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, "..", "website", "marketing", "public", "schemas");

function emit(fileName: string, schema: z.ZodType, id: string, title: string, description: string) {
  const json = z.toJSONSchema(schema, { target: "draft-7", io: "input" }) as Record<string, unknown>;
  const out = {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: id,
    title,
    description,
    ...json,
  };
  delete (out as Record<string, unknown>)["$defs"]; // zod emits none here; keep output minimal if it appears empty
  const file = path.join(OUT_DIR, fileName);
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
}

mkdirSync(OUT_DIR, { recursive: true });
emit(
  "settings.repo.schema.json",
  repoSettingsSchema,
  SCHEMA_URL_REPO,
  "Zeros repository settings",
  "Shared per-repository Zeros settings (<repo>/.zeros/settings.toml — commit this file). Also validates <repo>/.zeros/settings.local.toml (personal, gitignored).",
);
emit(
  "settings.schema.json",
  userSettingsSchema,
  SCHEMA_URL_USER,
  "Zeros user settings",
  "User-wide Zeros settings (~/.zeros/settings.toml). Includes user-only keys (models, workspaces, tool approvals) that repository settings may not set.",
);
