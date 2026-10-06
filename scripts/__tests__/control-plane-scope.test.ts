// The control-plane database suites are skipped when none of their inputs
// changed. That is only safe while CONTROL_PLANE_DATABASE_INPUTS covers every
// file those suites can reach, so this derives the reach from the sources
// themselves instead of trusting the list.
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build, type Plugin } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";

import {
  CONTROL_PLANE_DATABASE_INPUTS,
  changedFilesSince,
  comparisonBase,
  decideControlPlaneScope,
  isControlPlaneDatabaseInput,
} from "../ci/control-plane-scope.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PACKAGE = "apps/control-plane/";
const SCOPE = path.join(ROOT, "scripts/ci/control-plane-scope.mjs");
const BASE = "0123456789abcdef0123456789abcdef01234567";

function controlPlaneSources(): string[] {
  return readdirSync(path.join(ROOT, PACKAGE, "src"), { recursive: true })
    .map((file) => `${PACKAGE}src/${String(file).split(path.sep).join("/")}`)
    .filter((file) => file.endsWith(".ts"));
}

/** Resolve workspace sources, but stop at installed third-party packages. */
const thirdPartyExternal: Plugin = {
  name: "third-party-external",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^[^./]/ }, async (args) => {
      if (args.pluginData?.resolving) return undefined;
      const resolved = await pluginBuild.resolve(args.path, {
        kind: args.kind,
        importer: args.importer,
        resolveDir: args.resolveDir,
        pluginData: { resolving: true },
      });
      return resolved.errors.length ||
        resolved.path.split(path.sep).includes("node_modules")
        ? { path: args.path, external: true }
        : resolved;
    });
  },
};

async function importedRepositoryFiles(): Promise<string[]> {
  const result = await build({
    absWorkingDir: ROOT,
    entryPoints: controlPlaneSources(),
    bundle: true,
    write: false,
    metafile: true,
    platform: "node",
    format: "esm",
    outdir: path.join(tmpdir(), "control-plane-scope"),
    logLevel: "silent",
    plugins: [thirdPartyExternal],
  });
  return Object.keys(result.metafile.inputs).map((file) =>
    file.split(path.sep).join("/"),
  );
}

/** package.json and tsconfig.json files that govern how `file` resolves. */
function governingConfigs(file: string): string[] {
  const configs: string[] = [];
  for (let dir = path.posix.dirname(file); ; dir = path.posix.dirname(dir)) {
    for (const name of ["package.json", "tsconfig.json"]) {
      const candidate = dir === "." ? name : `${dir}/${name}`;
      if (existsSync(path.join(ROOT, candidate))) configs.push(candidate);
    }
    if (dir === ".") return configs;
  }
}

describe("control-plane database scope inputs", () => {
  it("covers every repository file the control-plane sources import", async () => {
    const outside = (await importedRepositoryFiles()).filter(
      (file) => !file.startsWith(PACKAGE),
    );
    // The admission contracts reach into the desktop clients and protocol.
    expect(outside).toContain("apps/desktop/src/engine/cloud-runtime-registration.ts");
    const required = [
      ...outside,
      ...outside.flatMap(governingConfigs),
    ];
    expect(required.filter((file) => !isControlPlaneDatabaseInput(file))).toEqual([]);
  });

  it("covers every repository path the control-plane sources name", () => {
    const named = controlPlaneSources().flatMap((file) => [
      ...readFileSync(path.join(ROOT, file), "utf8").matchAll(
        /["'`]((?:apps|docs|packages|scripts)\/[\w./-]+\.[a-z]+)["'`]/g,
      ),
    ]).map((match) => match[1]!);
    expect(named).toContain("docs/deployment-environments.md");
    expect(named.filter((file) => !isControlPlaneDatabaseInput(file))).toEqual([]);
  });

  it("lists only paths that exist", () => {
    for (const input of CONTROL_PLANE_DATABASE_INPUTS) {
      expect(existsSync(path.join(ROOT, input)), input).toBe(true);
    }
  });

  it("keeps the workflow's shard count, matrix and reports in step", () => {
    const workflow = readFileSync(
      path.join(ROOT, ".github/workflows/preflight.yml"),
      "utf8",
    );
    const matrix = /^ {8}shard: \[([\d, ]+)\]$/m.exec(workflow)?.[1];
    const shards = matrix?.split(",").map((value) => Number(value.trim()));
    expect(shards).toEqual([1, 2, 3, 4]);
    expect(workflow).toContain(`--shard="\${SHARD}/${shards!.length}"`);
    expect(workflow).toContain(`DATABASE_SHARDS: ${shards!.length}`);
    expect(workflow).toContain(
      "if: needs.control-plane-scope.outputs.database == 'true'",
    );
    expect(workflow).toContain(
      'run: node scripts/ci/control-plane-scope.mjs >> "$GITHUB_OUTPUT"',
    );
    // The skip-guard re-run is gone; its evidence comes from the reports.
    expect(workflow).not.toContain("src/migrations.test.ts --reporter=json");
  });
});

describe("control-plane database scope decision", () => {
  it("measures each event from the base it is merged onto", () => {
    expect(
      comparisonBase({ EVENT_NAME: "pull_request", PULL_REQUEST_BASE_SHA: BASE }),
    ).toBe(BASE);
    expect(
      comparisonBase({ EVENT_NAME: "merge_group", MERGE_GROUP_BASE_SHA: BASE }),
    ).toBe(BASE);
    expect(comparisonBase({ EVENT_NAME: "push", PUSH_BEFORE_SHA: BASE })).toBe(BASE);
  });

  it("has no base for a new branch, an unknown event or a missing SHA", () => {
    expect(
      comparisonBase({ EVENT_NAME: "push", PUSH_BEFORE_SHA: "0".repeat(40) }),
    ).toBeNull();
    expect(
      comparisonBase({ EVENT_NAME: "workflow_dispatch", PUSH_BEFORE_SHA: BASE }),
    ).toBeNull();
    expect(comparisonBase({ EVENT_NAME: "pull_request" })).toBeNull();
  });

  it("runs every database suite when the change cannot be measured", () => {
    expect(decideControlPlaneScope({ base: null, changedFiles: [] }).database).toBe(true);
    expect(decideControlPlaneScope({ base: BASE, changedFiles: null }).database).toBe(true);
  });

  it("runs every database suite for a main push even when only docs changed", () => {
    expect(decideControlPlaneScope({
      base: BASE,
      changedFiles: ["README.md"],
      eventName: "push",
      ref: "refs/heads/main",
    })).toEqual({ database: true, reason: "main pushes always run the database suites" });
  });

  it.each([
    ["push", "refs/heads/release/1.2.3"],
    ["pull_request", "refs/pull/123/merge"],
    ["merge_group", "refs/heads/gh-readonly-queue/main/pr-123"],
    ["pull_request", "refs/heads/main"],
  ])("preserves input-based scope for %s on %s", (eventName, ref) => {
    expect(decideControlPlaneScope({ base: BASE, changedFiles: ["README.md"], eventName, ref }).database).toBe(false);
    expect(decideControlPlaneScope({ base: BASE, changedFiles: ["apps/control-plane/src/index.ts"], eventName, ref }).database).toBe(true);
  });

  it.each(["ci.yml", "preflight.yml"])("passes the event ref to the scope in %s", (file) => {
    const workflow = readFileSync(path.join(ROOT, ".github/workflows", file), "utf8");
    expect(workflow).toContain("GITHUB_REF: ${{ github.ref }}");
  });

  it("skips the database suites when no input changed", () => {
    expect(
      decideControlPlaneScope({
        base: BASE,
        changedFiles: [
          "apps/desktop/src/renderer/app-shell.tsx",
          "apps/desktop/src/engine/git/diff.ts",
          "packages/protocol/src/design-runtime.ts",
          "docs/ui-interaction-performance.md",
          "apps/control-plane-notes.md",
        ],
      }),
    ).toMatchObject({ database: false });
    expect(decideControlPlaneScope({ base: BASE, changedFiles: [] }).database).toBe(false);
  });

  it.each([
    "apps/control-plane/migrations/0105_example.sql",
    "apps/control-plane/pnpm-lock.yaml",
    "apps/desktop/src/engine/cloud-runtime-registration.ts",
    "packages/protocol/src/cloud-actors.ts",
    "pnpm-lock.yaml",
    "patches/ssh2@1.17.0.patch",
    "docs/deployment-environments.md",
    ".github/workflows/preflight.yml",
    "scripts/ci/control-plane-results.mjs",
  ])("runs the database suites when %s changes", (file) => {
    expect(
      decideControlPlaneScope({
        base: BASE,
        changedFiles: ["README.md", file],
      }),
    ).toMatchObject({ database: true, reason: expect.stringContaining(file) });
  });
});

describe("control-plane database scope diff", () => {
  const repositories: string[] = [];
  afterEach(() => {
    for (const repository of repositories.splice(0)) {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

  function repository(): { cwd: string; base: string } {
    const cwd = mkdtempSync(path.join(tmpdir(), "control-plane-scope-"));
    repositories.push(cwd);
    git(cwd, "init", "--quiet");
    git(cwd, "config", "user.name", "Control Plane Scope Test");
    git(cwd, "config", "user.email", "control-plane-scope@invalid.example");
    mkdirSync(path.join(cwd, "apps/control-plane/src"), { recursive: true });
    writeFileSync(path.join(cwd, "apps/control-plane/src/moved.ts"), "export {};\n");
    writeFileSync(path.join(cwd, "apps/control-plane/src/deleted.ts"), "export {};\n");
    writeFileSync(path.join(cwd, "README.md"), "base\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "--quiet", "-m", "base");
    return { cwd, base: git(cwd, "rev-parse", "HEAD") };
  }

  it("reports both sides of a rename and every deletion", () => {
    const { cwd, base } = repository();
    mkdirSync(path.join(cwd, "tools"));
    renameSync(
      path.join(cwd, "apps/control-plane/src/moved.ts"),
      path.join(cwd, "tools/moved.ts"),
    );
    rmSync(path.join(cwd, "apps/control-plane/src/deleted.ts"));
    git(cwd, "add", "-A");
    git(cwd, "commit", "--quiet", "-m", "move out of the service");

    const changed = changedFilesSince(base, { cwd });
    expect(changed?.sort()).toEqual([
      "apps/control-plane/src/deleted.ts",
      "apps/control-plane/src/moved.ts",
      "tools/moved.ts",
    ]);
    expect(decideControlPlaneScope({ base, changedFiles: changed }).database).toBe(true);
  });

  it("ignores base-branch commits made after the change forked", () => {
    const { cwd, base } = repository();
    git(cwd, "checkout", "--quiet", "-b", "change");
    writeFileSync(path.join(cwd, "README.md"), "change\n");
    git(cwd, "commit", "--quiet", "-am", "docs only");
    git(cwd, "checkout", "--quiet", "-");
    writeFileSync(path.join(cwd, "apps/control-plane/src/deleted.ts"), "export const later = 1;\n");
    git(cwd, "commit", "--quiet", "-am", "later service change on the base");
    const laterBase = git(cwd, "rev-parse", "HEAD");
    git(cwd, "checkout", "--quiet", "change");

    expect(changedFilesSince(laterBase, { cwd })).toEqual(["README.md"]);
    expect(changedFilesSince(base, { cwd })).toEqual(["README.md"]);
  });

  it("falls back to running the suites when the base is not in the checkout", () => {
    const { cwd } = repository();
    const result = spawnSync(process.execPath, [SCOPE], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, EVENT_NAME: "push", GITHUB_REF: "refs/heads/release/1.2.3", PUSH_BEFORE_SHA: BASE, GITHUB_STEP_SUMMARY: "" },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("database=true\n");
    expect(result.stderr).toContain(`Could not diff against ${BASE}`);
  });

  it("does not let a docs-only main push skip database validation after an earlier service change", () => {
    const { cwd } = repository();
    writeFileSync(path.join(cwd, "apps/control-plane/src/deleted.ts"), "export const previousChange = 1;\n");
    git(cwd, "commit", "--quiet", "-am", "earlier service change");
    const before = git(cwd, "rev-parse", "HEAD");
    writeFileSync(path.join(cwd, "README.md"), "later docs only\n");
    git(cwd, "commit", "--quiet", "-am", "docs only");
    const result = spawnSync(process.execPath, [SCOPE], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, EVENT_NAME: "push", GITHUB_REF: "refs/heads/main", PUSH_BEFORE_SHA: before, GITHUB_STEP_SUMMARY: "" },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("database=true\n");
    expect(result.stderr.trim()).toBe("main pushes always run the database suites");
  });
});
