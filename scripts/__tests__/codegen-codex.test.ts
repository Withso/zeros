import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

// @ts-expect-error — the codegen helper is an ESM script without declarations.
import {
  codexAppServerExportArgs,
  replaceDirectoryTransactionally,
} from "../codegen-codex-lib.mjs";

describe("Codex protocol codegen", () => {
  it("uses the current Codex app-server schema generators", () => {
    expect(codexAppServerExportArgs("/tmp/generated")).toEqual([
      [
        "app-server",
        "generate-ts",
        "--out",
        "/tmp/generated",
        "--experimental",
      ],
      [
        "app-server",
        "generate-json-schema",
        "--out",
        "/tmp/generated",
        "--experimental",
      ],
    ]);
  });

  it("keeps the last good generated tree when regeneration fails", () => {
    const fixture = mkdtempSync(path.join(tmpdir(), "zeros-codex-codegen-"));
    const generated = path.join(fixture, "generated");
    mkdirSync(generated);
    writeFileSync(path.join(generated, ".version"), "old\n", "utf8");

    try {
      expect(() =>
        replaceDirectoryTransactionally(generated, (stagingDir: string) => {
          writeFileSync(path.join(stagingDir, ".version"), "partial\n", "utf8");
          throw new Error("export failed");
        }),
      ).toThrow(/export failed/);

      expect(readFileSync(path.join(generated, ".version"), "utf8")).toBe(
        "old\n",
      );
      expect(existsSync(`${generated}.next`)).toBe(false);
      expect(existsSync(`${generated}.previous`)).toBe(false);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("replaces the generated tree only after regeneration succeeds", () => {
    const fixture = mkdtempSync(path.join(tmpdir(), "zeros-codex-codegen-"));
    const generated = path.join(fixture, "generated");
    mkdirSync(generated);
    writeFileSync(path.join(generated, "retired.ts"), "old\n", "utf8");

    try {
      replaceDirectoryTransactionally(generated, (stagingDir: string) => {
        writeFileSync(path.join(stagingDir, ".version"), "new\n", "utf8");
      });

      expect(readFileSync(path.join(generated, ".version"), "utf8")).toBe(
        "new\n",
      );
      expect(existsSync(path.join(generated, "retired.ts"))).toBe(false);
      expect(existsSync(`${generated}.next`)).toBe(false);
      expect(existsSync(`${generated}.previous`)).toBe(false);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
