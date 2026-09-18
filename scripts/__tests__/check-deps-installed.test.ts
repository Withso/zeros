import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const checker = resolve("scripts/check-deps-installed.mjs");
const trash: string[] = [];

afterEach(() => {
  while (trash.length > 0)
    rmSync(trash.pop()!, { recursive: true, force: true });
});

/** Build a throwaway repo and run a COPY of the checker from inside it. The
 *  script derives its root from its own location (`scripts/..`), so copying it
 *  in — rather than adding a root-override env var only tests would use — is
 *  what lets the real code path run unmodified against a fixture. */
function runAgainst(options: {
  declared: Record<string, string>;
  devDeclared?: Record<string, string>;
  /** Package dirs to actually create under node_modules. */
  present: string[];
  /** Package names to create as symlinks pointing nowhere. */
  dangling?: string[];
  /** Omit node_modules entirely. */
  withoutNodeModules?: boolean;
  /** `null` writes no stamp at all; a string writes that stamp content. */
  installedLock?: string | null;
  lockfile?: string;
  env?: Record<string, string>;
}) {
  const repository = mkdtempSync(join(tmpdir(), "zeros-dep-check-"));
  trash.push(repository);

  mkdirSync(join(repository, "scripts"));
  copyFileSync(
    checker,
    join(repository, "scripts", "check-deps-installed.mjs"),
  );
  writeFileSync(
    join(repository, "package.json"),
    JSON.stringify({
      name: "fixture",
      dependencies: options.declared,
      devDependencies: options.devDeclared ?? {},
    }),
    "utf8",
  );
  writeFileSync(
    join(repository, "pnpm-lock.yaml"),
    options.lockfile ?? "lockfile-contents\n",
    "utf8",
  );

  if (!options.withoutNodeModules) {
    const nodeModules = join(repository, "node_modules");
    mkdirSync(nodeModules);
    for (const name of options.present) {
      mkdirSync(join(nodeModules, name), { recursive: true });
    }
    for (const name of options.dangling ?? []) {
      mkdirSync(join(nodeModules, name, ".."), { recursive: true });
      symlinkSync(join(repository, "no-such-target"), join(nodeModules, name));
    }
    if (options.installedLock !== null) {
      mkdirSync(join(nodeModules, ".pnpm"), { recursive: true });
      writeFileSync(
        join(nodeModules, ".pnpm", "lock.yaml"),
        options.installedLock ?? options.lockfile ?? "lockfile-contents\n",
        "utf8",
      );
    }
  }

  return spawnSync(
    process.execPath,
    [join(repository, "scripts", "check-deps-installed.mjs")],
    {
      cwd: repository,
      encoding: "utf8",
      env: { ...process.env, ...options.env },
    },
  );
}

describe("check-deps-installed", () => {
  it("passes when every declared dependency is on disk", () => {
    const result = runAgainst({
      declared: { react: "^18.0.0" },
      devDeclared: { vitest: "^3.0.0" },
      present: ["react", "vitest"],
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("fails and names a dependency that was never installed", () => {
    const result = runAgainst({
      declared: { react: "^18.0.0", "@radix-ui/react-menu": "2.1.16" },
      present: ["react"],
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("@radix-ui/react-menu");
    expect(result.stderr).toContain("pnpm install");
  });

  it("treats a dangling symlink as missing", () => {
    const result = runAgainst({
      declared: { "playwright-core": "1.59.1" },
      present: [],
      dangling: ["playwright-core"],
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("playwright-core");
  });

  it("warns without failing when only the lockfile stamp drifted", () => {
    const result = runAgainst({
      declared: { react: "^18.0.0" },
      present: ["react"],
      lockfile: "current-lockfile\n",
      installedLock: "older-lockfile\n",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("DIFFERENT pnpm-lock.yaml");
  });

  it("stays silent when no stamp exists but everything resolves", () => {
    const result = runAgainst({
      declared: { react: "^18.0.0" },
      present: ["react"],
      installedLock: null,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("fails when node_modules is absent entirely", () => {
    const result = runAgainst({
      declared: { react: "^18.0.0" },
      present: [],
      withoutNodeModules: true,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("node_modules is missing");
  });

  it("honours the ZEROS_SKIP_DEP_CHECK escape hatch", () => {
    const result = runAgainst({
      declared: { "@radix-ui/react-menu": "2.1.16" },
      present: [],
      env: { ZEROS_SKIP_DEP_CHECK: "1" },
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });
});
