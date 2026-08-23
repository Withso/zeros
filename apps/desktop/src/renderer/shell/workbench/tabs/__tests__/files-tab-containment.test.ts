import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("Files tab containment", () => {
  it("clips the unified sidebar and file body to the tab surface", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../files-tab.tsx", import.meta.url)),
      "utf8",
    );

    expect(source).toMatch(
      /data-testid="files-tab"[\s\S]{0,160}className="[^"]*\boverflow-hidden\b[^"]*"/,
    );
  });
});
