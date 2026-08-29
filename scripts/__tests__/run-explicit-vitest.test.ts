import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { validateExplicitTestFiles } from "../run-explicit-vitest.mjs";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("explicit Vitest runner", () => {
  it("accepts only present, physical test files beneath the repository root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-vitest-files-"));
    cleanup.push(root);
    const testFile = path.join(root, "present.test.ts");
    const alias = path.join(root, "alias.test.ts");
    await writeFile(testFile, "export {};\n");
    await symlink(testFile, alias);

    expect(validateExplicitTestFiles(["present.test.ts"], root)).toEqual([
      "present.test.ts",
    ]);
    expect(() => validateExplicitTestFiles(["missing.test.ts"], root)).toThrow(
      /missing explicit Vitest file/i,
    );
    expect(() => validateExplicitTestFiles(["alias.test.ts"], root)).toThrow(
      /physical regular file/i,
    );
    expect(() => validateExplicitTestFiles([], root)).toThrow(
      /at least one explicit Vitest file/i,
    );
  });
});
