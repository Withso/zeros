import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// The macOS updater ZIP is first built inside the release: PR packaging checks
// produce only an unpacked `--dir` app. electron-builder 26.15.0 moved to
// 7-Zip 24.09, which follows symlinks unless told `-snl`, so every framework's
// `Versions/Current` became a real directory and codesign refused the ZIP
// ("bundle format is ambiguous"), blocking the Alpha feed. This keeps the
// archive step that builds that ZIP storing symlinks as links.
const root = path.resolve(__dirname, "../..");
const builder = createRequire(createRequire(path.join(root, "package.json")).resolve("electron-builder/package.json"));
const lib = (name: string) => builder.resolve(`app-builder-lib/out/${name}`);

/** A fresh copy of electron-builder's archive code, with its 7-Zip lookup cache unset. */
function archiveModule() {
  for (const name of ["targets/archive.js", "toolsets/7zip.js"]) delete builder.cache[lib(name)];
  return builder(lib("targets/archive.js")) as {
    archive(format: string, outFile: string, dir: string, options: Record<string, unknown>): Promise<string>;
    shouldPreserveSymlinks?: (platform: unknown) => boolean;
  };
}
const { Platform } = builder("app-builder-lib") as { Platform: { MAC: unknown; LINUX: unknown; WINDOWS: unknown } };

const roots: string[] = [];
const previous = process.env.ELECTRON_BUILDER_7ZIP_PATH;
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (previous === undefined) delete process.env.ELECTRON_BUILDER_7ZIP_PATH;
  else process.env.ELECTRON_BUILDER_7ZIP_PATH = previous;
});

/** Runs the real archive step for a framework-shaped app with a 7za that only records its arguments. */
async function archiveArgs(platform: unknown): Promise<string[]> {
  const dir = mkdtempSync(path.join(tmpdir(), "zeros-mac-zip-"));
  roots.push(dir);
  const framework = path.join(dir, "Zeros.app/Contents/Frameworks/ReactiveObjC.framework");
  mkdirSync(path.join(framework, "Versions/A"), { recursive: true });
  writeFileSync(path.join(framework, "Versions/A/ReactiveObjC"), "binary");
  symlinkSync("A", path.join(framework, "Versions/Current"));
  symlinkSync("Versions/Current/ReactiveObjC", path.join(framework, "ReactiveObjC"));
  const recorded = path.join(dir, "args"), fake = path.join(dir, "7za");
  writeFileSync(fake, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > '${recorded}'\n`);
  chmodSync(fake, 0o755);
  process.env.ELECTRON_BUILDER_7ZIP_PATH = fake;
  const { archive, shouldPreserveSymlinks } = archiveModule();
  expect(shouldPreserveSymlinks, "electron-builder no longer decides which targets keep symlinks").toBeTypeOf("function");
  await archive("zip", path.join(dir, "Zeros-mac.zip"), path.join(dir, "Zeros.app"), { preserveSymlinks: shouldPreserveSymlinks!(platform) });
  return readFileSync(recorded, "utf8").split("\n").filter(Boolean);
}

describe("electron-builder macOS updater ZIP", () => {
  it("stores symlinks as links for macOS and Linux targets", async () => {
    expect(await archiveArgs(Platform.MAC)).toContain("-snl");
    expect(await archiveArgs(Platform.LINUX)).toContain("-snl");
  });

  it("still dereferences for Windows targets, where restoring a link needs elevation", async () => {
    expect(await archiveArgs(Platform.WINDOWS)).not.toContain("-snl");
  });

  it("passes the target platform's choice from every archive target", () => {
    // ArchiveTarget builds the mac ZIP; it must ask per target platform, not per build host.
    expect(readFileSync(lib("targets/ArchiveTarget.js"), "utf8")).toMatch(/preserveSymlinks:\s*\(0, archive_1\.shouldPreserveSymlinks\)\(packager\.platform\)/);
  });
});
