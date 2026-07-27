// Regression tests for the "Claude works in dev, AGENT RESPONSE FAILURE in
// Beta/Prod" bug (field report: Zeros 0.0.14, com.zeros / com.zeros.beta).
//
// The packaged engine is a `bun build --compile` single-file binary with no
// node_modules on disk, so the Agent SDK's own
// `createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk-<plat>/claude')`
// ALWAYS fails there and `query()` throws "Native CLI binary for darwin-arm64
// not found". In dev the engine is `bun <repo>/src/cli.ts`, the same lookup
// succeeds, and so does vitest — which is precisely why no test caught this.
//
// So every tier here is exercised with the filesystem + env INJECTED. The
// load-bearing case is `bundled: () => null` (the packaged shape): the resolver
// must still produce a path. A test that relied on the ambient environment would
// pass on any dev machine and prove nothing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CLAUDE_CLI_PATH_ENV,
  CLAUDE_CLI_VERSION_ENV,
  claudeBinaryName,
  claudeCliMissingMessage,
  claudePlatformPackages,
  isPinnedClaudeRuntime,
  resetClaudeCliCacheForTests,
  resolveClaudeCli,
  type ClaudeCliResolverDeps,
} from "../binary-resolver";

const STAGED = "/Applications/Zeros.app/Contents/Resources/claude";
const BUNDLED =
  "/repo/node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-darwin-arm64@0.3.220/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude";
const GLOBAL = "/opt/homebrew/bin/claude";
const ON_PATH = "/usr/local/custom/claude";
const OVERRIDE = "/Users/me/.claude/local/claude";

/** The PACKAGED shape: no node_modules to walk, so the bundled tier is null and
 *  no global install exists. Anything that resolves here does so because the app
 *  handed us a path — never because module resolution happened to work. */
function packagedDeps(
  present: string[],
  env: NodeJS.ProcessEnv = {},
): ClaudeCliResolverDeps {
  const set = new Set(present);
  return {
    env,
    bundled: () => null,
    wellKnown: () => [GLOBAL],
    onPath: () => (set.has(ON_PATH) ? ON_PATH : null),
    isExecutable: (p) => set.has(p),
  };
}

/** The DEV shape: sdk.mjs is a real file, so the bundled tier resolves. */
function devDeps(
  present: string[] = [BUNDLED],
  env: NodeJS.ProcessEnv = {},
): ClaudeCliResolverDeps {
  const set = new Set(present);
  return {
    env,
    bundled: () => (set.has(BUNDLED) ? BUNDLED : null),
    wellKnown: () => [GLOBAL],
    onPath: () => (set.has(ON_PATH) ? ON_PATH : null),
    isExecutable: (p) => set.has(p),
  };
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetClaudeCliCacheForTests();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  resetClaudeCliCacheForTests();
});

describe("resolveClaudeCli — the packaged shape (the actual bug)", () => {
  it("resolves the staged binary when module resolution cannot work", () => {
    // THE regression: bundled === null (bun-compiled, no node_modules) and no
    // global claude. Before the fix there was no staged tier at all, the adapter
    // left pathToClaudeCodeExecutable unset, and the SDK threw.
    const r = resolveClaudeCli(
      {},
      packagedDeps([STAGED], { [CLAUDE_CLI_PATH_ENV]: STAGED }),
    );
    expect(r).toEqual({ path: STAGED, source: "staged" });
    expect(isPinnedClaudeRuntime(r.source)).toBe(true);
  });

  it("reports source 'none' — never throws — when nothing at all resolves", () => {
    // The pre-fix packaged reality. The caller turns this into ONE actionable
    // error instead of the SDK's "reinstall without --omit=optional" advice.
    const r = resolveClaudeCli({}, packagedDeps([]));
    expect(r).toEqual({ path: null, source: "none" });
  });

  it("falls back to a global install when staging went missing", () => {
    // Defence in depth: a packaging regression must not hard-fail every send for
    // a user who has Claude Code installed themselves.
    const r = resolveClaudeCli({}, packagedDeps([GLOBAL]));
    expect(r).toEqual({ path: GLOBAL, source: "well-known" });
    // …but it is NOT the pinned runtime, so version surfaces must not claim it is.
    expect(isPinnedClaudeRuntime(r.source)).toBe(false);
  });

  it("falls back to PATH after well-known locations", () => {
    const r = resolveClaudeCli({}, packagedDeps([ON_PATH]));
    expect(r).toEqual({ path: ON_PATH, source: "path" });
  });

  it("warns and falls through when the staged path is not executable", () => {
    // A 0644 half-copy or a stale env pointing at a deleted bundle. Falling
    // through keeps the app usable; the warning is how we learn staging broke.
    const r = resolveClaudeCli(
      {},
      packagedDeps([GLOBAL], { [CLAUDE_CLI_PATH_ENV]: STAGED }),
    );
    expect(r).toEqual({ path: GLOBAL, source: "well-known" });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("packaged staging regressed"),
    );
  });
});

describe("resolveClaudeCli — tier precedence", () => {
  it("prefers the user's explicit override over everything", () => {
    const r = resolveClaudeCli(
      { override: OVERRIDE },
      packagedDeps([OVERRIDE, STAGED, GLOBAL], {
        [CLAUDE_CLI_PATH_ENV]: STAGED,
      }),
    );
    expect(r).toEqual({ path: OVERRIDE, source: "override" });
  });

  it("prefers the staged binary over a global install", () => {
    const r = resolveClaudeCli(
      {},
      packagedDeps([STAGED, GLOBAL], { [CLAUDE_CLI_PATH_ENV]: STAGED }),
    );
    expect(r.source).toBe("staged");
  });

  it("prefers the staged binary over the bundled package", () => {
    // A packaged app that somehow also has node_modules must still run the
    // binary the build staged and signed, not one it found lying around.
    const r = resolveClaudeCli(
      {},
      devDeps([STAGED, BUNDLED], { [CLAUDE_CLI_PATH_ENV]: STAGED }),
    );
    expect(r.source).toBe("staged");
  });

  it("uses the bundled package in dev, with no env and no override", () => {
    const r = resolveClaudeCli({}, devDeps());
    expect(r).toEqual({ path: BUNDLED, source: "bundled" });
    expect(isPinnedClaudeRuntime(r.source)).toBe(true);
  });

  it("warns and falls through when the override is not executable", () => {
    const r = resolveClaudeCli({ override: "/nope/claude" }, devDeps());
    expect(r).toEqual({ path: BUNDLED, source: "bundled" });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("is not an executable file"),
    );
  });

  it("ignores a blank/whitespace override and env instead of resolving ''", () => {
    // provider-prefs can hand through an empty string; treating it as a path
    // would stat "" and, worse, pass "" to the SDK as an executable.
    const r = resolveClaudeCli(
      { override: "   " },
      devDeps([BUNDLED], { [CLAUDE_CLI_PATH_ENV]: "  " }),
    );
    expect(r).toEqual({ path: BUNDLED, source: "bundled" });
  });
});

describe("platform package candidates — must mirror the SDK's own resolver", () => {
  it("asks for exactly one package on darwin", () => {
    expect(claudePlatformPackages("darwin", "arm64")).toEqual([
      "@anthropic-ai/claude-agent-sdk-darwin-arm64",
    ]);
  });

  it("tries glibc then musl on linux", () => {
    expect(claudePlatformPackages("linux", "x64")).toEqual([
      "@anthropic-ai/claude-agent-sdk-linux-x64",
      "@anthropic-ai/claude-agent-sdk-linux-x64-musl",
    ]);
  });

  it("uses the -android suffix on android", () => {
    expect(claudePlatformPackages("android", "arm64")).toEqual([
      "@anthropic-ai/claude-agent-sdk-linux-arm64-android",
    ]);
  });

  it("appends .exe only on win32", () => {
    expect(claudeBinaryName("win32")).toBe("claude.exe");
    expect(claudeBinaryName("darwin")).toBe("claude");
    expect(claudeBinaryName("linux")).toBe("claude");
  });
});

describe("diagnostics", () => {
  it("names both env vars so a field report can be acted on", () => {
    expect(CLAUDE_CLI_PATH_ENV).toBe("ZEROS_CLAUDE_CLI_PATH");
    expect(CLAUDE_CLI_VERSION_ENV).toBe("ZEROS_CLAUDE_CLI_VERSION");
  });

  it("tells the user what to do instead of repeating the SDK's npm advice", () => {
    const msg = claudeCliMissingMessage();
    expect(msg).toContain("Executable path");
    // The SDK's own text is useless inside a signed .app — do not parrot it.
    expect(msg).not.toContain("--omit=optional");
  });
});
