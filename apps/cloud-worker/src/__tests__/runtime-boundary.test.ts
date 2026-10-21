import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { expect, it } from "vitest";

it("keeps the shipped worker independent of the Local engine and UI", async () => {
  const violations: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "__tests__") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (path.endsWith(".ts")) {
        const text = await readFile(path, "utf8");
        if (/(?:from\s+|import\s*\(|require\s*\()["'][^"']*(?:desktop|engine\/|renderer\/)/.test(text)) violations.push(path);
      }
    }
  }
  await visit(fileURLToPath(new URL("../", import.meta.url)));
  expect(violations).toEqual([]);
});
