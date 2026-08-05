import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("shared hosted-page shell", () => {
  it("keeps hidden controls out of layout even when their component sets display", async () => {
    const source = await readFile(
      new URL("./page.ts", import.meta.url),
      "utf8",
    );

    assert.match(
      source,
      /\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/,
    );
  });
});
