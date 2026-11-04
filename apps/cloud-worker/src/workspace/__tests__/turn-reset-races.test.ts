import { readFile, readdir, readlink, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CheckedFiles } from "../checked-files";
import { turnResetHost } from "../turn-reset";
import { repositoryFixture } from "./repository-fixture";

afterEach(() => vi.restoreAllMocks());
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };

it.each(["restore", "delete", "merge"] as const)("preserves a replacement published after the %s content check", async action => {
  const f = await repositoryFixture();
  const tree = (await f.git("rev-parse", "HEAD^{tree}")).trim();
  await writeFile(join(f.root, "readme.txt"), "turn edit\n");
  const expected = (await f.git("hash-object", "readme.txt")).trim();
  const host = turnResetHost(f.scope, async () => null), entered = gate(), hold = gate();
  const assert = CheckedFiles.prototype.assertDescriptor;
  let read = false, held = false;
  vi.spyOn(CheckedFiles.prototype, "assertDescriptor").mockImplementation(async function (this: CheckedFiles, handle) {
    await assert.call(this, handle);
    if ((await handle.stat()).isFile()) read = true;
    else if (read && !held) { held = true; entered.release(); await hold.promise; }
  });
  const operation = action === "merge" ? host.publishMerge("readme.txt", "merged\n", "turn edit\n")
    : host.restore("readme.txt", action === "restore" ? tree : null, expected);
  const outcome = operation.then(value => ({ value }), error => ({ error }));
  try {
    await entered.promise;
    await writeFile(join(f.root, "replacement"), "another actor\n");
    await rename(join(f.root, "replacement"), join(f.root, "readme.txt"));
  } finally { hold.release(); }
  await outcome;
  expect(await readFile(join(f.root, "readme.txt"), "utf8")).toBe("another actor\n");
});


it.each(["restore", "merge"] as const)("retains both versions when a newer file wins the %s publication", async action => {
  const f = await repositoryFixture();
  const tree = (await f.git("rev-parse", "HEAD^{tree}")).trim();
  await writeFile(join(f.root, "readme.txt"), "turn edit\n");
  const expected = (await f.git("hash-object", "readme.txt")).trim();
  const host = turnResetHost(f.scope, async () => null), entered = gate(), hold = gate();
  const assert = CheckedFiles.prototype.assertDescriptor;
  let capturedRead = false, held = false;
  vi.spyOn(CheckedFiles.prototype, "assertDescriptor").mockImplementation(async function (this: CheckedFiles, handle) {
    await assert.call(this, handle);
    if ((await handle.stat()).isFile()) capturedRead ||= /\/\.zeros-reset-[^/]+\/original$/.test(await readlink(`/proc/self/fd/${handle.fd}`));
    else if (capturedRead && !held) { held = true; entered.release(); await hold.promise; }
  });
  const operation = action === "merge" ? host.publishMerge("readme.txt", "merged\n", "turn edit\n")
    : host.restore("readme.txt", tree, expected);
  const outcome = operation.then(value => ({ value }), error => ({ error }));
  try {
    await entered.promise;
    await writeFile(join(f.root, "readme.txt"), "newer publication\n", { flag: "wx" });
  } finally { hold.release(); }
  const result = await outcome;
  expect(result).toMatchObject(action === "merge" ? { value: false } : { error: { code: "FILE_CHANGED" } });
  expect(await readFile(join(f.root, "readme.txt"), "utf8")).toBe("newer publication\n");
  const [retained] = (await readdir(f.root)).filter(name => name.startsWith(".zeros-reset-"));
  expect(retained).toBeDefined();
  expect(await readFile(join(f.root, retained!, "original"), "utf8")).toBe("turn edit\n");
});
