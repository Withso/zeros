import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// @ts-expect-error — the packaging helper is an ESM script without declarations.
import {
  STAGED_RUNTIME_DIR,
  STAGED_VERSION_FILE,
  codexTargetFor,
  resolveCodexRuntimeSource,
} from "../stage-codex-cli.mjs";

describe("stage Codex CLI", () => {
  it("maps supported Electron targets to Codex platform triples", () => {
    expect(codexTargetFor("darwin", "arm64")).toEqual({
      packageName: "@openai/codex-darwin-arm64",
      triple: "aarch64-apple-darwin",
    });
    expect(codexTargetFor("linux", "x64")).toEqual({
      packageName: "@openai/codex-linux-x64",
      triple: "x86_64-unknown-linux-musl",
    });
    expect(codexTargetFor("win32", "arm64")).toEqual({
      packageName: "@openai/codex-win32-arm64",
      triple: "aarch64-pc-windows-msvc",
    });
    expect(() => codexTargetFor("freebsd", "x64")).toThrow(
      /unsupported Codex target/i,
    );
  });

  it("resolves the complete pinned runtime, including sandbox resources", () => {
    const source = resolveCodexRuntimeSource();
    const wrapperPackage = JSON.parse(
      readFileSync("node_modules/@openai/codex/package.json", "utf8"),
    ) as { version: string };
    const relativePaths = source.files.map(
      (file: { relativePath: string }) => file.relativePath,
    );
    const executable = process.platform === "win32" ? "codex.exe" : "codex";
    const host =
      process.platform === "win32"
        ? "codex-code-mode-host.exe"
        : "codex-code-mode-host";
    const rg = process.platform === "win32" ? "rg.exe" : "rg";
    const prefix = path.join("vendor", source.triple);

    expect(source.version).toBe(wrapperPackage.version);
    expect(relativePaths).toEqual(
      expect.arrayContaining([
        "package.json",
        path.join(prefix, "bin", executable),
        path.join(prefix, "bin", host),
        path.join(prefix, "codex-path", rg),
        path.join(prefix, "codex-package.json"),
      ]),
    );
    // Linux sandboxing needs the bundled bwrap + zsh assets. This assertion is
    // intentionally platform-local: other Codex packages may ship a different
    // resource set, but every file they do ship must be staged below.
    if (process.platform === "linux") {
      expect(relativePaths).toEqual(
        expect.arrayContaining([
          path.join(prefix, "codex-resources", "bwrap"),
          path.join(prefix, "codex-resources", "zsh", "bin", "zsh"),
        ]),
      );
    }
    for (const file of source.files) expect(existsSync(file.source)).toBe(true);
  });

  it("keeps stable electron-builder resource names", () => {
    expect(STAGED_RUNTIME_DIR).toBe("binaries/codex-runtime");
    expect(STAGED_VERSION_FILE).toBe("binaries/codex-cli-version.txt");
  });
});
