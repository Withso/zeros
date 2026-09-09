import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { resolveConfig } from "vitest/node";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

describe("root Vitest configuration", () => {
  it("caps the filesystem-heavy suite at four fork workers", async () => {
    const { vitestConfig } = await resolveConfig({
      root: ROOT,
      config: "vitest.config.ts",
    });

    expect(vitestConfig.pool).toBe("forks");
    expect(vitestConfig.maxWorkers).toBe(4);
    expect(vitestConfig).not.toHaveProperty("poolOptions");
  });
});
