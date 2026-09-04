import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FIRST_USE_DESIGN_DIRECTORY_SUFFIX,
  assertSafeProspectiveDesignDirectory,
  firstUseDesignDirectoryName,
} from "../directory";
import { DEFAULT_DESIGN_DIRECTORY_NAME } from "../directory-registry";

describe("first-use Design directory naming", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("names the folder after the repository", () => {
    expect(firstUseDesignDirectoryName("Odocs")).toBe("Odocs - Design");
  });

  it("turns path separators and control whitespace into a safe leaf name", () => {
    expect(firstUseDesignDirectoryName("  team/repo\nname  ")).toBe(
      "team repo name - Design",
    );
  });

  it("falls back to the compatibility default when no usable name remains", () => {
    expect(firstUseDesignDirectoryName(" ... ")).toBe(
      DEFAULT_DESIGN_DIRECTORY_NAME,
    );
  });

  it("keeps multibyte names within a portable filesystem leaf limit", () => {
    const name = firstUseDesignDirectoryName("🪷".repeat(100));

    expect(name.endsWith(FIRST_USE_DESIGN_DIRECTORY_SUFFIX)).toBe(true);
    expect(Buffer.byteLength(name, "utf8")).toBeLessThanOrEqual(255);
  });

  it.runIf(process.platform !== "win32")(
    "validates child segments against the physical root behind a workspace alias",
    async () => {
      const physical = await realpath(
        await mkdtemp(path.join(tmpdir(), "zeros-design-physical-")),
      );
      const aliasParent = await realpath(
        await mkdtemp(path.join(tmpdir(), "zeros-design-alias-")),
      );
      roots.push(physical, aliasParent);
      const workspaceAlias = path.join(aliasParent, "workspace");
      await symlink(physical, workspaceAlias, "dir");
      await mkdir(path.join(physical, "Future Design"));

      await expect(
        assertSafeProspectiveDesignDirectory(workspaceAlias, "Future Design"),
      ).resolves.toBeUndefined();
    },
  );
});
