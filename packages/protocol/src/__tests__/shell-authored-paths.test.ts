import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { authoredPathsFromShellCommand } from "../shell-authored-paths";

describe("shell command-name normalization", () => {
  it.each(["touch", "(((touch)))", "(((/usr/bin/touch)))", "touch)))"])(
    "retains named mutations for %s",
    (command) => {
      expect(authoredPathsFromShellCommand(`${command} edited.txt`, "/repo", "/repo"))
        .toEqual([{ path: "edited.txt", kind: "edit" }]);
    },
  );

  it("does not infer mutations from empty or unknown command names", () => {
    expect(authoredPathsFromShellCommand("((())) ignored.txt; unknown))) ignored.txt", "/repo", "/repo"))
      .toEqual([]);
  });

  it("bounds parsing of long non-matching parenthesis runs without losing later edits", () => {
    // Isolate the parser so a backtracking regression cannot hang the Vitest
    // worker. This generous process deadline includes cold TypeScript loading;
    // it is not a sub-millisecond benchmark of ordinary input.
    const moduleUrl = new URL("../shell-authored-paths.ts", import.meta.url).href;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { authoredPathsFromShellCommand } from ${JSON.stringify(moduleUrl)};
      const command = ")".repeat(500_000) + "x ignored.txt; touch edited.txt";
      process.stdout.write(JSON.stringify(authoredPathsFromShellCommand(command, "/repo", "/repo")));
    `], { encoding: "utf8", timeout: 8_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([{ path: "edited.txt", kind: "edit" }]);
  });
});
