import { afterEach, describe, expect, it } from "vitest";

import { resolveCodexBinary } from "../binary-resolver";

const originalStagedPath = process.env.ZEROS_CODEX_CLI_PATH;

afterEach(() => {
  if (originalStagedPath === undefined) {
    delete process.env.ZEROS_CODEX_CLI_PATH;
  } else {
    process.env.ZEROS_CODEX_CLI_PATH = originalStagedPath;
  }
});

describe("resolveCodexBinary", () => {
  it("keeps an explicit packaged-runtime path authoritative when the file is missing", async () => {
    const staged = "/__zeros_missing_codex_runtime__/bin/codex";
    process.env.ZEROS_CODEX_CLI_PATH = staged;

    await expect(resolveCodexBinary()).resolves.toEqual({
      path: staged,
      source: "bundled",
    });
  });
});
