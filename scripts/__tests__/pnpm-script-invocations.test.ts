import { execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
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

/** A tracked symlink can point outside the checkout and is not guidance: open
 * without following links and read through the validated descriptor. */
function readRegularFile(file: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    return fstatSync(fd).isFile() ? readFileSync(fd, "utf8") : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") return null;
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

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
      .filter((file) => GUIDANCE.test(file) && TEXT.test(file));
    const offenders = files.flatMap((file) => {
      const text = readRegularFile(file);
      return text === null ? [] : shadowedInvocations(text, shadowed).map((line) => `${file}:${line}`);
    });
    expect(offenders).toEqual([]);
  });
});
