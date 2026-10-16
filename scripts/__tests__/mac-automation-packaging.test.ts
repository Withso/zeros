import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const builder = readFileSync("electron-builder.yml", "utf8");

describe("macOS automation packaging", () => {
  it("lets signed app and helper processes request Apple Events consent", () => {
    const entitlementPaths = [
      ...builder.matchAll(/^  entitlements(?:Inherit)?:\s*(.+)$/gm),
    ].map((match) => match[1].trim().replace(/^["']|["']$/g, ""));
    expect(entitlementPaths).toHaveLength(2);
    for (const file of entitlementPaths) {
      const plist = readFileSync(file, "utf8").replace(/<!--[\s\S]*?-->/g, "");
      expect(plist, file).toMatch(
        /<key>com\.apple\.security\.automation\.apple-events<\/key>\s*<true\s*\/>/,
      );
    }
  });

  it("includes a user-facing reason in the packaged app's Info.plist", () => {
    expect(builder).toMatch(/^    NSAppleEventsUsageDescription:\s*\S.*$/m);
  });

  it("says why it saves simulator captures to Downloads", () => {
    expect(builder).toMatch(
      /^    NSDownloadsFolderUsageDescription:\s*\S.*Downloads.*$/m,
    );
  });

  it("passes the packaging path check before beforePack stages binaries/", () => {
    // CI runs check:packaging-paths on a fresh checkout, where the gitignored
    // binaries/ directory has not been staged yet.
    const root = resolve(".");
    const checkout = mkdtempSync(join(tmpdir(), "zeros-unstaged-checkout-"));
    try {
      for (const entry of readdirSync(root)) {
        if (entry !== "binaries")
          symlinkSync(join(root, entry), join(checkout, entry));
      }
      const result = spawnSync(
        process.execPath,
        ["scripts/check-packaging-paths.mjs"],
        { cwd: checkout, encoding: "utf8" },
      );
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    } finally {
      // Unlink each symlink rather than removing recursively, so cleanup can
      // never follow a link into the real checkout.
      for (const entry of readdirSync(checkout))
        unlinkSync(join(checkout, entry));
      rmdirSync(checkout);
    }
  });
});
