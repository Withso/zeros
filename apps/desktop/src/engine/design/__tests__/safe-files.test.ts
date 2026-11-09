import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { captureDesignDependencies, captureDurableDesignDependencies } from "../dependency-read-set";
import { createDesignReadScope, designReadScopeValue, inspectSafeRegularFile, readSafeRegularFile, withDesignReadScope } from "../safe-files";

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

    const read = await readSafeRegularFile(root, safe, 4);
    expect(read).toMatchObject({
      body: Buffer.from("safe"),
      size: 4,
    });
    expect(read?.body.buffer.byteLength).toBe(read?.body.byteLength);
    await expect(readSafeRegularFile(root, safe, 3)).resolves.toBeNull();
    await expect(
      readSafeRegularFile(root, path.join(root, "escape.css"), 100),
    ).resolves.toBeNull();
    await expect(
      inspectSafeRegularFile(root, path.join(root, "escape.css"), 100),
    ).resolves.toBeNull();
  });

  it("reads and inspects each file once per scope, and every capture still records what it read", async () => {
    temporary = await mkdtemp(path.join(tmpdir(), "zeros-safe-design-"));
    const root = path.join(temporary, "root");
    await mkdir(root);
    const sheet = path.join(root, "sheet.css");
    await writeFile(sheet, "first");
    const captured = await withDesignReadScope(async () => {
      const first = await captureDurableDesignDependencies(() => readSafeRegularFile(root, sheet, 64));
      const before = await inspectSafeRegularFile(root, sheet, 64);
      await writeFile(sheet, "second!");
      // The same request keeps what it read; a later one reads again.
      const second = await captureDurableDesignDependencies(() => readSafeRegularFile(root, sheet, 64));
      expect(await inspectSafeRegularFile(root, sheet, 64)).toEqual(before);
      return [first, second];
    });
    expect(captured.map(({ value }) => value?.body.toString())).toEqual(["first", "first"]);
    expect(captured[1]!.durable).toEqual(captured[0]!.durable);
    expect(captured[0]!.durable?.[0]).toMatchObject({ target: sheet, limit: 64, fingerprint: expect.any(String) });
    expect((await readSafeRegularFile(root, sheet, 64))?.body.toString()).toBe("second!");
    expect(await inspectSafeRegularFile(root, sheet, 64)).toMatchObject({ size: 7 });
  });

  it("never serves a movement guard from a scope, and retains nothing past its budget", async () => {
    temporary = await mkdtemp(path.join(tmpdir(), "zeros-safe-design-"));
    const root = path.join(temporary, "root");
    await mkdir(root);
    const sheet = path.join(root, "sheet.css");
    await writeFile(sheet, "first");
    await withDesignReadScope(async () => {
      expect((await readSafeRegularFile(root, sheet, 64))?.body.toString()).toBe("first");
      await writeFile(sheet, "moved");
      // A guard fails its operation when a dependency changed, so it reads for itself.
      let read: string | undefined;
      const guard = await captureDesignDependencies(async () => { read = (await readSafeRegularFile(root, sheet, 64))?.body.toString(); });
      expect(read).toBe("moved");
      expect(() => guard.assertCurrent()).not.toThrow();
    });
    await writeFile(sheet, "0123456789");
    await withDesignReadScope(async () => {
      expect((await readSafeRegularFile(root, sheet, 64))?.body.toString()).toBe("0123456789");
      await writeFile(sheet, "abcdefghij");
      expect((await readSafeRegularFile(root, sheet, 64))?.body.toString()).toBe("abcdefghij");
    }, createDesignReadScope({ budgetBytes: 8 }));
  });

  it("computes a scope value once per scope, and every time outside one", async () => {
    let computed = 0;
    const value = () => designReadScopeValue("key", async () => ++computed);
    expect(await withDesignReadScope(async () => [await value(), await value()])).toEqual([1, 1]);
    expect([await value(), await value()]).toEqual([2, 3]);
  });
});

