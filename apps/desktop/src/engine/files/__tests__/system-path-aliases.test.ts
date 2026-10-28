import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import promises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { openBoundedDirectorySync } from "../bounded-read-sync";
import { openLocalDirectory, openLocalFile } from "../../local-orchestration/filesystem";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); syncBuiltinESMExports(); });

it.each(["/var", "/tmp", "/etc"])("permits the macOS system alias %s without following workspace descendants", async prefix => {
  vi.stubGlobal("process", { ...process, platform: "darwin" });
  const realpath = vi.spyOn(fs, "realpathSync").mockImplementation(value => {
    if (String(value) !== prefix) throw new Error("A workspace descendant must not be canonicalized");
    return `/private${prefix}`;
  });
  vi.spyOn(fs, "openSync").mockReturnValue(12);
  vi.spyOn(fs, "closeSync").mockImplementation(() => {});
  const open = vi.spyOn(promises, "open").mockResolvedValue({ close: async () => {} } as Awaited<ReturnType<typeof promises.open>>);
  syncBuiltinESMExports();
  const target = `${prefix}/folders/workspace/source`;
  const expected = `/private${target}`;
  const directory = openBoundedDirectorySync(target);
  expect(directory.path).toBe(`/.nofollow${expected}`);
  directory.close();
  expect((await openLocalDirectory(target)).path).toBe(`/.nofollow${expected}`);
  await openLocalFile(`${target}/file.txt`);
  expect(open.mock.calls.at(-1)?.[0]).toBe(`${expected}/file.txt`);
  expect(realpath.mock.calls.every(call => call[0] === prefix)).toBe(true);
});
