import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

describe("package scripts named like pnpm commands", () => {
  it("are always invoked with pnpm run", () => {
    expect(shadowed.length).toBeGreaterThan(0);
    const invocation = new RegExp(`\\bpnpm\\s+(?:${shadowed.join("|")})\\b`);
    const files = execFileSync("git", ["ls-files"], { encoding: "utf8" })
      .split("\n")
      .filter((file) => GUIDANCE.test(file) && TEXT.test(file));
    const offenders = files.flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line, index) => (invocation.test(line) ? [`${file}:${index + 1}`] : [])),
    );
    expect(offenders).toEqual([]);
  });
});
