import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { inspectSafeRegularFile, readSafeRegularFile } from "../safe-files";

describe("design safe file reads", () => {
  let temporary: string | null = null;

  afterEach(async () => {
    if (temporary) await rm(temporary, { recursive: true, force: true });
    temporary = null;
  });

  it("reads through one verified descriptor and rejects symlinks and oversized files", async () => {
    temporary = await mkdtemp(path.join(tmpdir(), "zeros-safe-design-"));
    const root = path.join(temporary, "root");
    await mkdir(root);
    const safe = path.join(root, "safe.css");
    const outside = path.join(temporary, "outside.css");
    await writeFile(safe, "safe");
    await writeFile(outside, "secret");
    await symlink(outside, path.join(root, "escape.css"));

    await expect(readSafeRegularFile(root, safe, 4)).resolves.toMatchObject({
      body: Buffer.from("safe"),
      size: 4,
    });
    await expect(readSafeRegularFile(root, safe, 3)).resolves.toBeNull();
    await expect(
      readSafeRegularFile(root, path.join(root, "escape.css"), 100),
    ).resolves.toBeNull();
    await expect(
      inspectSafeRegularFile(root, path.join(root, "escape.css"), 100),
    ).resolves.toBeNull();
  });
});
