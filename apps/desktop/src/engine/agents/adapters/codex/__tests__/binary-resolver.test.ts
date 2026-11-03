import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  resolveCodexBinary,
  resolveExecutableFromPath,
} from "../binary-resolver";

const originalStagedPath = process.env.ZEROS_CODEX_CLI_PATH;
const roots: string[] = [];
const fixture = vi.hoisted(() => ({ unpackaged: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    access: (file: Parameters<typeof actual.access>[0], mode?: number) => {
      if (fixture.unpackaged && String(file).includes("/node_modules/"))
        return Promise.reject(Object.assign(new Error("unpackaged runtime"), { code: "ENOENT" }));
      return actual.access(file, mode);
    },
  };
});

afterEach(async () => {
  fixture.unpackaged = false;
  if (originalStagedPath === undefined) {
    delete process.env.ZEROS_CODEX_CLI_PATH;
  } else {
    process.env.ZEROS_CODEX_CLI_PATH = originalStagedPath;
  }
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("resolveCodexBinary", () => {
  it("uses the recovered session PATH for the unpackaged fallback", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codex-session-path-"));
    roots.push(root);
    const binary = path.join(root, "codex");
    await writeFile(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    delete process.env.ZEROS_CODEX_CLI_PATH;
    fixture.unpackaged = true;

    await expect(resolveCodexBinary({ pathValue: root })).resolves.toEqual({
      path: binary, source: "fallback",
    });
  });

  it("identifies a missing fallback as an executable ENOENT", async () => {
    delete process.env.ZEROS_CODEX_CLI_PATH;
    fixture.unpackaged = true;
    await expect(resolveCodexBinary({ pathValue: "/__zeros_absent_codex_path__" })).rejects.toMatchObject({
      code: "ENOENT", syscall: "spawn codex", path: "codex",
    });
  });

  it("reports the bundled native runtime root needed by provider sandboxing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codex-staged-runtime-"));
    roots.push(root);
    const runtimeRoot = path.join(
      root,
      "vendor",
      "x86_64-unknown-linux-musl",
    );
    const binary = path.join(runtimeRoot, "bin", "codex");
    await mkdir(path.dirname(binary), { recursive: true });
    await writeFile(binary, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    process.env.ZEROS_CODEX_CLI_PATH = binary;

    await expect(resolveCodexBinary()).resolves.toEqual({
      path: binary,
      source: "bundled",
      sandboxRuntimeRoot: runtimeRoot,
    });
  });

  it("keeps an explicit packaged-runtime path authoritative when the file is missing", async () => {
    const staged = "/__zeros_missing_codex_runtime__/bin/codex";
    process.env.ZEROS_CODEX_CLI_PATH = staged;

    await expect(resolveCodexBinary()).resolves.toEqual({
      path: staged,
      source: "bundled",
    });
  });

  it("canonicalizes a PATH fallback before runtime launch", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codex-path-fallback-"));
    roots.push(root);
    const native = path.join(root, "codex-native");
    const shim = path.join(root, "codex");
    await writeFile(native, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await chmod(native, 0o700);
    await symlink(native, shim);

    await expect(resolveExecutableFromPath("codex", root)).resolves.toBe(
      native,
    );
  });
});
