import { mkdtemp, readFile, rm, stat, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { captureDesignDependencies, designDependencyFingerprint, observeDesignDependencyCheck, observeDesignFileDependency } from "../dependency-read-set";
import { readSafeRegularFile } from "../safe-files";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "zeros-read-set-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it("checks exact cached bytes even when length and modification time are retained", async () => {
  const target = path.join(root, "theme.css");
  await writeFile(target, "red");
  const metadata = await stat(target);
  const fingerprint = designDependencyFingerprint(await readFile(target));
  const captured = await captureDesignDependencies(async () => {
    observeDesignFileDependency(root, { target, limit: 100, fingerprint });
  });
  expect(captured.assertCurrent).not.toThrow();
  await writeFile(target, "tan");
  await utimes(target, metadata.atime, metadata.mtime);
  expect((await stat(target)).size).toBe(metadata.size);
  expect(captured.assertCurrent).toThrow(/changed/);
});

it("captures binary asset bytes without lossy text conversion", async () => {
  const target = path.join(root, "font.woff2");
  await writeFile(target, Buffer.from([255, 128, 0, 65]));
  const captured = await captureDesignDependencies(() => readSafeRegularFile(root, target, 10));
  expect(captured.assertCurrent).not.toThrow();
  await writeFile(target, Buffer.from([254, 128, 0, 65]));
  expect(captured.assertCurrent).toThrow(/changed/);
});

it("refuses a missing dependency that appears before admission", async () => {
  const target = path.join(root, "missing.css");
  const captured = await captureDesignDependencies(() => readSafeRegularFile(root, target, 100));
  expect(captured.assertCurrent).not.toThrow();
  await writeFile(target, "body{color:red}");
  expect(captured.assertCurrent).toThrow(/changed/);
});

it("retains a conflicting observation even if an intermediate CSS reader catches it", async () => {
  const target = path.join(root, "theme.css");
  const captured = await captureDesignDependencies(async () => {
    observeDesignFileDependency(root, { target, limit: 10, fingerprint: "first" });
    expect(() => observeDesignFileDependency(root, { target, limit: 10, fingerprint: "second" })).toThrow(/changed/);
  });
  expect(captured.assertCurrent).toThrow(/changed/);
});

it("refuses a dependency redirected through a symlink after measurement", async () => {
  const target = path.join(root, "theme.css"), replacement = path.join(root, "replacement.css");
  await writeFile(target, "red");
  await writeFile(replacement, "red");
  const captured = await captureDesignDependencies(() => readSafeRegularFile(root, target, 100));
  await unlink(target);
  await symlink(replacement, target);
  expect(captured.assertCurrent).toThrow(/changed/);
});

it("retains every canonical-path policy when the same dependency is read through different consumers", async () => {
  const target = path.join(root, "theme.css");
  await writeFile(target, "red");
  let permitted = true;
  let secondPermitted = true;
  const captured = await captureDesignDependencies(async () => {
    await readSafeRegularFile(root, target, 100, () => permitted);
    await readSafeRegularFile(root, target, 100);
    await readSafeRegularFile(root, target, 100, () => secondPermitted);
    await readSafeRegularFile(root, target, 100);
  });
  expect(captured.assertCurrent).not.toThrow();
  permitted = false;
  expect(captured.assertCurrent).toThrow(/changed/);
  permitted = true;
  secondPermitted = false;
  expect(captured.assertCurrent).toThrow(/changed/);
});

it("isolates concurrent read sets while retaining non-file generation checks", async () => {
  const first = path.join(root, "first.css"), second = path.join(root, "second.css");
  await writeFile(first, "red");
  await writeFile(second, "blue");
  let generation = 1;
  const [a, b] = await Promise.all([
    captureDesignDependencies(() => readSafeRegularFile(root, first, 100)),
    captureDesignDependencies(async () => {
      await readSafeRegularFile(root, second, 100);
      const expected = generation;
      observeDesignDependencyCheck(() => { if (generation !== expected) throw new Error("Font generation changed"); });
    }),
  ]);
  await writeFile(first, "tan");
  expect(a.assertCurrent).toThrow(/changed/);
  expect(b.assertCurrent).not.toThrow();
  generation += 1;
  expect(b.assertCurrent).toThrow(/generation changed/);
});

it("keeps a caught read-set overflow inadmissible", async () => {
  const captured = await captureDesignDependencies(async () => {
    for (let index = 0; index < 2052; index += 1)
      observeDesignFileDependency(root, { target: path.join(root, `${index}.css`), limit: 10, fingerprint: null });
    expect(() => observeDesignFileDependency(root, { target: path.join(root, "overflow.css"), limit: 10, fingerprint: null })).toThrow(/bounded file limit/);
  });
  expect(captured.assertCurrent).toThrow(/bounded file limit/);
});
