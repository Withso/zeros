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
