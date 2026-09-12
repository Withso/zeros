import path from "node:path";

import { describe, expect, it } from "vitest";

import { electronAtomicTemporaryPath } from "../ipc/commands/atomic-file-write";

describe("electronAtomicTemporaryPath", () => {
  it("uses a same-directory namespace that Design recovery never reclaims", () => {
    const target = path.join("/workspace", "Zeros Design", "tokens.css");
    const temporary = electronAtomicTemporaryPath(target);

    expect(path.dirname(temporary)).toBe(path.dirname(target));
    expect(temporary).not.toMatch(/\.zeros-tmp$/);
    expect(temporary).toContain(".zeros-electron-tmp-");
    expect(electronAtomicTemporaryPath(target)).not.toBe(temporary);
  });
});
