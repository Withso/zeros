// Parse + schema validity for the hand-maintained static configs the app/build
// reads at runtime. These are edited by hand (no compiler), several load at
// startup, so a trailing comma or a shape regression is a silent runtime break.
// `models:verify` covers models-v1 structurally but NEVER touches providers-v1 —
// this closes that gap and adds a JSON-parse smoke for the other committed configs.

import { describe, it, expect } from "vitest";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const read = (rel: string): unknown =>
  JSON.parse(readFileSync(path.join(ROOT, rel), "utf8"));

function schemaErrors(schemaRel: string, dataRel: string) {
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(read(schemaRel) as object);
  validate(read(dataRel));
  return validate.errors ?? [];
}

describe("static config validity (parse + schema)", () => {
  it("catalogs/providers-v1.json matches its schema (models:verify never checks providers)", () => {
    expect(
      schemaErrors("catalogs/providers-v1.schema.json", "catalogs/providers-v1.json"),
    ).toEqual([]);
  });

  it("catalogs/models-v1.json matches its schema", () => {
    expect(
      schemaErrors("catalogs/models-v1.schema.json", "catalogs/models-v1.json"),
    ).toEqual([]);
  });

  // providers-v1.json is PUBLISHED (its schema $id points at
  // withso.github.io/zeros/catalogs/), but nothing imports it — the values the
  // app actually enforces are the hardcoded ones in registry.ts. That is a
  // one-way drift with no compiler and no reader to notice it, and it had
  // already happened: the catalog advertised codex minCliVersion 0.8.0 long
  // after the app-server rewrite moved the real floor to 0.131.0, so the public
  // catalog told integrators a version the app refuses to talk to.
  it("providers-v1 minCliVersion agrees with the floors registry.ts enforces", () => {
    const registry = readFileSync(
      path.join(ROOT, "src/engine/agents/registry.ts"),
      "utf8",
    );
    const catalog = read("catalogs/providers-v1.json") as {
      providers: Record<string, { cliBinary?: string; minCliVersion?: string }>;
    };

    // registry.ts declares one `minCliVersion: "x.y.z"` per agent, in the same
    // order the providers appear in the catalog (claude, codex, cursor).
    const enforced = [...registry.matchAll(/minCliVersion:\s*"([^"]+)"/g)].map(
      (m) => m[1],
    );
    const advertised = Object.entries(catalog.providers)
      .filter(([, p]) => typeof p.minCliVersion === "string")
      .map(([, p]) => p.minCliVersion as string);

    expect(
      advertised.every((v) => enforced.includes(v)),
      `providers-v1.json advertises minCliVersion ${JSON.stringify(advertised)} ` +
        `but registry.ts enforces ${JSON.stringify(enforced)}. The published ` +
        `catalog must not promise a floor the app does not honour.`,
    ).toBe(true);
  });

  it("every hand-maintained JSON config parses (a trailing comma is a silent runtime break)", () => {
    for (const rel of [
      "renovate.json",
      "catalogs/models-v1.json",
      "catalogs/providers-v1.json",
      "website/marketing/public/schemas/settings.schema.json",
      "website/marketing/public/schemas/settings.repo.schema.json",
    ]) {
      expect(() => read(rel), `${rel} must be valid JSON`).not.toThrow();
    }
  });
});
