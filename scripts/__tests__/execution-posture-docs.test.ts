import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(file, "utf8");

describe("Local execution guidance", () => {
  it("retains Local capture isolation and persisted preview URL compatibility", () => {
    const design = read("docs/design-mode-roadmap.md");
    expect(design).not.toMatch(/pinned ZSR supervisor|check:zsr/);
    expect(design).toContain("nonpersistent session");
    expect(design).toContain("sandbox/context isolation");
    expect(design).toContain("__zsr_cap");
  });

  it("uses neutral current development and release commands", () => {
    expect(read("docs/local-development.md")).not.toContain("builds ZSR");
    expect(read("docs/local-development.md")).toContain("pinned ripgrep");
    expect(read("docs/deployment-environments.md")).not.toMatch(
      /shipping-kernel ZSR qualification|ZSR kernel/,
    );
  });

});
