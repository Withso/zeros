import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CloudProviderExecution } from "../../../cloud-provider-execution";
import { cloudCursorInstructions } from "../cloud-instructions";

const execution = (cwd: string) => ({ cwd }) as CloudProviderExecution;

describe.runIf(process.platform === "linux")("bounded cloud Cursor instructions", () => {
  it("bounds fixed markdown discovery and never reads config, nested rules, or symlinked files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-cursor-instructions-"));
    try {
      await mkdir(path.join(root, ".cursor/rules/nested"), { recursive: true });
      await writeFile(path.join(root, "AGENTS.md"), "ROOT_GUIDANCE");
      for (let i = 0; i < 20; i++) await writeFile(path.join(root, `.cursor/rules/r${String(i).padStart(2, "0")}.mdc`), `RULE_${String(i).padStart(2, "0")}_GUIDANCE`);
      await writeFile(path.join(root, ".cursor/settings.json"), "CONFIG_SENTINEL");
      await writeFile(path.join(root, ".cursor/rules/nested/rule.mdc"), "NESTED_SENTINEL");
      await symlink(path.join(root, ".cursor/settings.json"), path.join(root, ".cursor/rules/aa.mdc"));
      const text = cloudCursorInstructions(execution(root))!;
      expect(text).toContain("ROOT_GUIDANCE");
      expect(text).toContain("RULE_14_GUIDANCE");
      expect(text).not.toContain("RULE_15_GUIDANCE");
      expect(text).not.toContain("CONFIG_SENTINEL");
      expect(text).not.toContain("NESTED_SENTINEL");
      expect(text.split("Repository instructions (")).toHaveLength(17);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("does not follow a rules-directory escape or read beyond the per-file and aggregate byte bounds", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-cursor-instructions-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "zeros-cursor-instructions-outside-"));
    try {
      await mkdir(path.join(root, ".cursor"));
      await writeFile(path.join(outside, "rule.mdc"), "OUTSIDE_SENTINEL");
      await symlink(outside, path.join(root, ".cursor/rules"));
      await writeFile(path.join(root, "AGENTS.md"), "ADMITTED_ROOT");
      expect(cloudCursorInstructions(execution(root))).toContain("ADMITTED_ROOT");
      expect(cloudCursorInstructions(execution(root))).not.toContain("OUTSIDE_SENTINEL");
      await rm(path.join(root, ".cursor/rules"));
      await mkdir(path.join(root, ".cursor/rules"));
      await writeFile(path.join(root, "AGENTS.md"), "a".repeat(64 * 1024));
      for (const file of ["a.mdc", "b.mdc", "c.mdc"]) await writeFile(path.join(root, ".cursor/rules", file), "b".repeat(64 * 1024));
      expect(Buffer.byteLength(cloudCursorInstructions(execution(root))!)).toBeLessThan(129 * 1024);
      await writeFile(path.join(root, "AGENTS.md"), "a".repeat(64 * 1024 + 1));
      await rm(path.join(root, ".cursor/rules"), { recursive: true });
      expect(cloudCursorInstructions(execution(root))).toBeUndefined();
    } finally { await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]); }
  });
});
