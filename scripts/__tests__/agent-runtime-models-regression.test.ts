import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
describe("explicit complete discovery", () => {
  it("cannot report success when all dedicated provider credentials are absent", () => {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/models-verify.mjs",
        "--require-complete",
        "--bundled",
        "--json",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
        timeout: 15_000,
      },
    );
    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(
      report.discovery.every((source: any) => source.status === "unavailable"),
    ).toBe(true);
  });
});
