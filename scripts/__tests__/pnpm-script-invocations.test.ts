import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// `pnpm <name>` runs a package script only when <name> is not a pnpm command.
// For these commands pnpm runs its own built-in and never the script, so a
// same-named script must be invoked as `pnpm run <name>`. (pnpm's test, start,
// stop and restart commands do run the script, so they are not listed.)
const PNPM_BUILT_INS = new Set([
  "add", "approve-builds", "audit", "bin", "cat-file", "cat-index", "ci",
  "config", "create", "dedupe", "deploy", "dlx", "doctor", "env", "exec",
  "fetch", "find-hash", "help", "i", "ignored-builds", "import", "init",
  "install", "install-test", "licenses", "link", "list", "ln", "ls",
  "outdated", "pack", "patch", "patch-commit", "patch-remove", "prune",
  "publish", "rebuild", "remove", "rm", "root", "sbom", "self-update",
  "server", "setup", "store", "un", "uninstall", "unlink", "up", "update",
  "upgrade", "why",
]);
const GUIDANCE = /^(?:agents|docs|scripts|\.claude|\.agents|\.cursor)\/|^[A-Z][A-Z-]*\.md$/;
const TEXT = /\.(?:md|mdc|mjs|cjs|js|ts|sh|ya?ml|toml)$/;

const scripts = Object.keys(
  (JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> }).scripts,
);
const shadowed = scripts.filter((name) => PNPM_BUILT_INS.has(name));

/** 1-based lines that invoke one of `names` without `run`, including a command
 * a shell continuation splits across lines. */
function shadowedInvocations(text: string, names: readonly string[]): number[] {
  // `pnpm licenses:generate` names a different script, so `:`, `.` and `-`
  // continue the name.
  const invocation = new RegExp(`\\bpnpm\\s+(?:${names.join("|")})(?![\\w:.-])`);
  const lines = text.split("\n");
  return lines.flatMap((line, index) => {
    let command = line;
    for (let next = index; command.endsWith("\\") && next + 1 < lines.length; next++)
      command = command.slice(0, -1) + " " + lines[next + 1]!;
    return invocation.test(command) ? [index + 1] : [];
  });
}

describe("package scripts named like pnpm commands", () => {
  it("finds an invocation a shell continuation splits", () => {
    const name = shadowed[0]!;
    expect(shadowedInvocations(`pnpm \\\n  ${name} --flag`, [name])).toEqual([1]);
    expect(shadowedInvocations(`pnpm run ${name}\npnpm ${name}-like`, [name])).toEqual([]);
  });

  it("are always invoked with pnpm run", () => {
    expect(shadowed.length).toBeGreaterThan(0);
    const files = execFileSync("git", ["ls-files"], { encoding: "utf8" })
      .split("\n")
      // A tracked symlink can point outside the checkout; it is not guidance.
      .filter((file) => GUIDANCE.test(file) && TEXT.test(file) && lstatSync(file).isFile());
    const offenders = files.flatMap((file) =>
      shadowedInvocations(readFileSync(file, "utf8"), shadowed).map((line) => `${file}:${line}`),
    );
    expect(offenders).toEqual([]);
  });
});
