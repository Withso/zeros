import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const workflows = readdirSync(path.join(root, ".github/workflows"))
  .filter((name) => name.endsWith(".yml"))
  .map((name) => ({
    file: `.github/workflows/${name}`,
    text: read(`.github/workflows/${name}`),
  }));

type Renovate = {
  enabledManagers: string[];
  customManagers?: { managerFilePatterns: string[]; matchStrings: string[] }[];
  packageRules: Record<string, unknown>[];
};
const renovate = JSON.parse(read("renovate.json")) as Renovate;
const customManagers = renovate.customManagers ?? [];
const filePattern = (pattern: string) => new RegExp(pattern.slice(1, -1));

describe("Renovate coverage of pinned toolchain", () => {
  it("pins every setup-bun step to one exact Bun release", () => {
    const pins = workflows.flatMap(({ file, text }) =>
      [
        ...text.matchAll(/uses: oven-sh\/setup-bun@\S+.*\n((?:\s+.*\n){0,6})/g),
      ].map((match) => ({
        file,
        version: /^\s+bun-version: (\S+)/m.exec(match[1] ?? "")?.[1],
      })),
    );
    expect(pins.length).toBeGreaterThan(0);
    for (const pin of pins)
      expect(pin.version, pin.file).toMatch(/^\d+\.\d+\.\d+$/);
    expect(new Set(pins.map((pin) => pin.version)).size).toBe(1);
  });

  it("tracks every digest-pinned container outside uses: docker://", () => {
    expect(renovate.enabledManagers.includes("custom.regex")).toBe(
      customManagers.length > 0,
    );
    for (const { file, text } of workflows) {
      for (const line of text.split("\n")) {
        if (!/@sha256:[a-f0-9]{64}/.test(line) || /^\s*#/.test(line)) continue;
        if (/^\s*(?:-\s+)?uses: docker:\/\//.test(line)) continue;
        const tracked = customManagers.some(
          (manager) =>
            manager.managerFilePatterns.some((pattern) =>
              filePattern(pattern).test(file),
            ) &&
            manager.matchStrings.some((pattern) =>
              new RegExp(pattern).test(line),
            ),
        );
        expect(tracked, `${file}: ${line.trim().slice(0, 80)}`).toBe(true);
      }
    }
  });

  it("enables only same-major Electron releases and never automerges them", () => {
    const electron = renovate.packageRules.filter((rule) =>
      (rule.matchPackageNames as string[] | undefined)?.includes("electron"),
    );
    expect(electron.filter((rule) => rule.enabled === true)).toEqual([
      expect.objectContaining({ matchUpdateTypes: ["minor", "patch"] }),
    ]);
    expect(electron.some((rule) => rule.automerge === true)).toBe(false);
  });
});
