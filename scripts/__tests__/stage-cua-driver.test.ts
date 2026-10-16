import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertNpmPackagesPinned,
  CUA_DRIVER_VERSION,
} from "../stage-cua-driver.mjs";

const manifest = (optionalDependencies?: Record<string, string>) => ({
  dependencies: { "@trycua/cua-driver": CUA_DRIVER_VERSION },
  ...(optionalDependencies ? { optionalDependencies } : {}),
});

describe("Cua driver staging", () => {
  it("finds the SDK and its macOS platform package pinned in package.json", () => {
    // electron-builder only packs a pnpm package's optional dependency when it
    // is linked at the repository root. Without the root entry the packaged
    // app silently lacks the SDK's native library and computer use fails.
    const root = JSON.parse(readFileSync("package.json", "utf8"));
    expect(() => assertNpmPackagesPinned(root)).not.toThrow();
  });

  it("refuses to stage when the platform package is not declared at the root", () => {
    expect(() => assertNpmPackagesPinned(manifest())).toThrow(
      /@trycua\/cua-driver-darwin-arm64/,
    );
  });

  it("refuses to stage when the platform package's version drifts from the SDK", () => {
    expect(() =>
      assertNpmPackagesPinned(
        manifest({ "@trycua/cua-driver-darwin-arm64": "0.0.1" }),
      ),
    ).toThrow(/@trycua\/cua-driver-darwin-arm64/);
    expect(() =>
      assertNpmPackagesPinned(
        manifest({ "@trycua/cua-driver-darwin-arm64": CUA_DRIVER_VERSION }),
      ),
    ).not.toThrow();
  });
});
