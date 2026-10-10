import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveProductRipgrepPath } from "../ripgrep-runtime-asset";

const packaged = { packaged: true, resourcesPath: "/app/Resources", repoRoot: "/repo", env: {}, platform: "darwin" as const, arch: "arm64" };
describe("product-owned Cursor search runtime", () => {
  it("resolves the packaged neutral asset without a package or sandbox dependency", () => {
    const resolveModule = vi.fn(() => { throw new Error("unavailable"); });
    expect(resolveProductRipgrepPath(packaged, { exists: file => file === "/app/Resources/rg", resolveModule })).toBe("/app/Resources/rg");
    expect(resolveModule).not.toHaveBeenCalled();
  });
  it("keeps the legacy explicit courier path readable with identical bytes", () => {
    const file = "/old/Resources/zsr-rg";
    expect(resolveProductRipgrepPath({ ...packaged, env: { ZEROS_ZSR_RIPGREP_PATH: file } }, { exists: value => value === file })).toBe(file);
  });
  it("prefers the neutral explicit courier to the old name", () => {
    expect(resolveProductRipgrepPath({ ...packaged, env: { ZEROS_RIPGREP_PATH: "/new/rg", ZEROS_ZSR_RIPGREP_PATH: "/old/rg" } }, { exists: () => true })).toBe("/new/rg");
  });
  it("does not substitute a different binary for a missing explicit artifact", () => {
    expect(resolveProductRipgrepPath({ ...packaged, env: { ZEROS_RIPGREP_PATH: "/missing" } }, { exists: file => file === "/app/Resources/rg" })).toBeNull();
  });
  it("uses the same development staging output before package resolution", () => {
    expect(resolveProductRipgrepPath({ ...packaged, packaged: false }, { exists: file => file === path.join("/repo", "binaries", "rg") })).toBe(path.join("/repo", "binaries", "rg"));
  });
  it("resolves the pinned development platform package exactly as before", () => {
    const resolveModule = vi.fn((specifier: string) => specifier === "@vscode/ripgrep" ? "/dep/index.js" : "/dep/platform/bin/rg");
    expect(resolveProductRipgrepPath({ ...packaged, packaged: false }, { exists: file => file === "/dep/platform/bin/rg", resolveModule })).toBe("/dep/platform/bin/rg");
    expect(resolveModule.mock.calls).toEqual([["@vscode/ripgrep", undefined], ["@vscode/ripgrep-darwin-arm64/bin/rg", "/dep/index.js"]]);
  });
  it("keeps the platform executable spelling on Windows", () => {
    expect(resolveProductRipgrepPath({ ...packaged, platform: "win32" }, { exists: file => file.endsWith("rg.exe") })).toBe(path.join("/app/Resources", "rg.exe"));
  });
});
