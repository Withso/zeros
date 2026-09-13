import { readFileSync } from "node:fs";
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
});
