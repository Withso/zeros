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
  it("maps supported Electron targets to the same triples as the Codex wrapper", () => {
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

  it("resolves the installed platform runtime and its complete executable set", () => {
    const source = resolveCodexRuntimeSource();
    const wrapperPackage = JSON.parse(
      readFileSync("node_modules/@openai/codex/package.json", "utf8"),
    ) as { version: string };

    expect(source.version).toBe(wrapperPackage.version);
    expect(source.files.map((file: { relativePath: string }) => file.relativePath))
      .toEqual(
        expect.arrayContaining([
          path.join("vendor", source.triple, "bin", process.platform === "win32" ? "codex.exe" : "codex"),
          path.join(
            "vendor",
            source.triple,
            "bin",
            process.platform === "win32"
              ? "codex-code-mode-host.exe"
              : "codex-code-mode-host",
          ),
          path.join(
            "vendor",
            source.triple,
            "codex-path",
            process.platform === "win32" ? "rg.exe" : "rg",
          ),
          path.join("vendor", source.triple, "codex-package.json"),
        ]),
      );
    for (const file of source.files) expect(existsSync(file.source)).toBe(true);
  });

  it("keeps stable electron-builder resource names", () => {
    expect(STAGED_RUNTIME_DIR).toBe("binaries/codex-runtime");
    expect(STAGED_VERSION_FILE).toBe("binaries/codex-cli-version.txt");
  });
});
