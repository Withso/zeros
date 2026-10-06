// The selector must never attest to a skipped lane from incomplete evidence.
// Temporary repositories exercise the same argv-array Git reads as the CLI.
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { CONTROL_PLANE_DATABASE_INPUTS } from "../ci/control-plane-scope.mjs";
import {
  canonicalJson,
  collectLocalChanges,
  collectPrChanges,
  createLedger,
  decideScope,
  loadPolicy,
  matchesGlob,
  parseLabels,
  parseNameStatus,
  policyDigest,
  runCli,
  selectChecks,
  validatePolicy,
} from "../ci/scope.mjs";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const SCOPE = path.join(ROOT, "scripts/ci/scope.mjs");
const POLICY_PATH = path.join(ROOT, "scripts/ci/scope-rules.json");
const POLICY = loadPolicy(POLICY_PATH);
const SHA = "0123456789abcdef0123456789abcdef01234567";
const change = (file: string, status = "M", oldPath?: string) => ({
  path: file,
  status,
  ...(oldPath ? { oldPath } : {}),
});
const selected = (decision: ReturnType<typeof decideScope>): string[] =>
  Object.keys(decision.lanes)
    .filter((lane) => decision.lanes[lane])
    .sort();
const allPrLanes = POLICY.lane_names
  .filter((lane: string) => lane !== "ui-smoke")
  .sort();
const decide = (changes: ReturnType<typeof change>[], labels: string[] = []) =>
  decideScope({ policy: POLICY, changes, labels });

describe("CI scope globs", () => {
  it.each([
    ["docs/**/*.md", "docs/ci.md", true],
    ["docs/**/*.md", "docs/cloud-workspace/architecture.md", true],
    ["docs/**/*.md", "Docs/ci.md", false],
    ["docs/**/*.md", "other/docs/ci.md", false],
    ["docs/**/*.md", "docs/ci.md\n", false],
    ["scripts/check-*", "scripts/check-ui.mjs", true],
    ["scripts/check-*", "scripts/check-tools/check-ui.mjs", false],
    ["**/.npmrc", ".npmrc", true],
    ["**/.npmrc", "apps/web/.npmrc", true],
    ["apps/?eb/**", "apps/web/.hidden/file.ts", true],
    ["apps/?eb/**", "apps/longweb/file.ts", false],
    ["file?.ts", "file\u{1f600}.ts", true],
    ["literal[1].ts", "literal[1].ts", true],
    ["literal[1].ts", "literal1.ts", false],
    ["{a,b}.ts", "a.ts", false],
    ["!file.ts", "file.ts", false],
    ["apps/**", "apps/web/line\nname.ts", true],
  ])("matches %s against %s as %s", (glob, file, expected) => {
    expect(matchesGlob(file, glob)).toBe(expected);
  });
});

describe("CI scope path ownership", () => {
  it("unions every matching rule and every changed path", () => {
    const renderer = decide([
      change("apps/desktop/src/renderer/app-shell.tsx"),
    ]);
    const web = decide([change("apps/web/functions/health.ts")]);
    const combined = decide([
      change("apps/web/functions/health.ts"),
      change("apps/desktop/src/renderer/app-shell.tsx"),
    ]);
    expect(selected(combined)).toEqual(
      [...new Set([...selected(renderer), ...selected(web)])].sort(),
    );
    expect(renderer.full).toBe(false);
    expect(renderer.lanes["desktop-engine"]).toBe(false);
    expect(renderer.lanes["runtime-bundle"]).toBe(true);
    expect(selected(decide([change("styles/zeros-tokens.css")]))).toEqual([
      "desktop-renderer",
      "marketing",
      "web",
    ]);
  });

  it("retains both rename owners and the owner of a deletion or type change", () => {
    const oldPath = "apps/web/functions/example.ts";
    const newPath = "apps/desktop/src/renderer/example.ts";
    const renamed = decide([change(newPath, "R100", oldPath)]);
    expect(selected(renamed)).toEqual(
      selected(decide([change(oldPath, "D"), change(newPath, "A")])),
    );
    expect(renamed.full).toBe(false);
    for (const status of ["D", "T"]) {
      expect(selected(decide([change(oldPath, status)]))).toEqual(
        selected(decide([change(oldPath)])),
      );
    }
    expect(decide([change(newPath, "R100", "unknown/old.ts")]).full).toBe(true);
    expect(decide([change(newPath, "R100", "package.json")]).full).toBe(true);
  });

  it("uses the documentation allowlist only for audited modifications", () => {
    expect(selected(decide([change("docs/local-development.md")]))).toEqual([
      "docs-only",
    ]);
    expect(
      selected(decide([change("docs/local-development.md", "D")])),
    ).toEqual(["repository-contracts"]);
    expect(selected(decide([change("docs/new-guide.md", "A")]))).toEqual([
      "repository-contracts",
    ]);
    expect(decide([change("docs/new-guide.md")]).full).toBe(true);
    expect(selected(decide([change("docs/design-system.md")]))).toEqual([
      "desktop-renderer",
      "repository-contracts",
    ]);
  });

  it("derives database ownership from the existing input list", () => {
    for (const input of CONTROL_PLANE_DATABASE_INPUTS) {
      const file = input.endsWith("/") ? `${input}scope-input.ts` : input;
      expect(decide([change(file)]).lanes["control-plane-db"], file).toBe(true);
    }
    expect(
      decide([change("packages/protocol/src/design-runtime.ts")]).lanes[
        "control-plane-db"
      ],
    ).toBe(false);
    expect(
      decide([change("apps/desktop/src/engine/git/diff.ts")]).lanes[
        "control-plane-db"
      ],
    ).toBe(false);
    expect(
      decide([change("docs/deployment-environments.md")]).lanes[
        "control-plane-db"
      ],
    ).toBe(true);
    for (const rule of POLICY.path_rules) {
      if (rule.lanes.includes("control-plane-db")) {
        expect(rule.input_source).toBe("control-plane-database");
      }
    }
  });

  it.each([
    "scripts/ui-smoke-composer.mjs",
    "scripts/ui-smoke/new-scenario.mjs",
    "scripts/ui-smoke-new-harness.ts",
    "apps/desktop/src/renderer/harnesses/harness-tools.tsx",
  ])(
    "selects the Linux runtime bundle for %s without composer smoke",
    (file) => {
      const decision = decide([change(file)]);
      expect(decision.full).toBe(false);
      expect(decision.lanes["smoke-harness"]).toBe(true);
      expect(decision.lanes["runtime-bundle"]).toBe(true);
      expect(decision.lanes["ui-smoke"]).toBe(false);
      expect(selectChecks(POLICY, decision)).toContain("linux-runtime-bundle");
      expect(selectChecks(POLICY, decision)).not.toContain("composer-full");
    },
  );

  it("fails closed for global, unknown, empty, oversized or unreadable changes", () => {
    for (const changes of [
      [change("package.json")],
      [change("scripts/ci/scope-rules.json")],
      [change("unknown/new-owner.ts")],
      [],
      Array.from({ length: 301 }, (_, index) =>
        change(`apps/web/file-${index}.ts`),
      ),
      null,
    ]) {
      const decision = decideScope({ policy: POLICY, changes });
      expect(decision.full).toBe(true);
      expect(selected(decision)).toEqual(allPrLanes);
      expect(decision.reasons.length).toBeGreaterThan(0);
      expect(selectChecks(POLICY, decision)).not.toContain("composer-full");
    }
    const threeHundred = Array.from({ length: 300 }, (_, index) =>
      change(`apps/web/file-${index}.ts`),
    );
    expect(decide([...threeHundred, threeHundred[0]!]).full).toBe(false);
    expect(
      decideScope({ policy: POLICY, changes: [change("apps/web/a.ts", "U")] })
        .full,
    ).toBe(true);
  });

  it("keeps force-full in PR mode separate from explicit composer requests", () => {
    const decision = decideScope({
      policy: POLICY,
      changes: [],
      forceFull: true,
    });
    expect(selected(decision)).toEqual(allPrLanes);
    expect(decision.lanes["ui-smoke"]).toBe(false);
  });

  it("selects every lane in full mode without reading paths", () => {
    const decision = decideScope({
      policy: POLICY,
      mode: "full",
      changes: null,
    });
    expect(decision.full).toBe(true);
    expect(Object.values(decision.lanes).every((value) => value === true)).toBe(
      true,
    );
    expect(selectChecks(POLICY, decision)).toContain("composer-full");
  });

  it("uses offline web checks and has no deployed Pages probe", () => {
    expect(canonicalJson(POLICY)).not.toContain("check:web-deploy");
    const checks = selectChecks(
      POLICY,
      decide([change("apps/web/functions/health.ts")]),
    );
    const commands = checks.flatMap((id: string) => POLICY.checks[id].commands);
    expect(commands).toContain("npm --prefix apps/web run typecheck");
    expect(commands).toContain("npm --prefix apps/web test");
    expect(commands).toContain("npm --prefix apps/web run build:standalone");
    expect(commands).toContain("pnpm check:deep-link-schemes");
  });
});

describe("CI scope additive requests", () => {
  it.each([
    ["ci:ui-smoke", "ui-smoke"],
    ["ci:macos", "macos"],
    ["ci:control-plane-db", "control-plane-db"],
    ["ci:packaging", "packaging"],
    ["ci:web", "web"],
  ])("adds %s without removing floor lanes", (label, lane) => {
    const changes = [change("apps/desktop/src/renderer/app-shell.tsx")];
    const floor = decide(changes);
    const requested = decide(changes, [label]);
    expect(requested.lanes[lane]).toBe(true);
    for (const owner of selected(floor))
      expect(requested.lanes[owner]).toBe(true);
    expect(decide(changes).lanes).toEqual(floor.lanes);
    expect(requested.requests).toEqual([label]);
  });

  it("allows only ci:full or ci:ui-smoke to add full composer smoke", () => {
    const full = decide([change("docs/local-development.md")], ["ci:full"]);
    expect(Object.values(full.lanes).every((value) => value === true)).toBe(
      true,
    );
    expect(full.full).toBe(true);
    expect(
      decide([change("package.json")], ["ci:ui-smoke"]).lanes["ui-smoke"],
    ).toBe(true);
    for (const label of [
      "ci:macos",
      "ci:control-plane-db",
      "ci:packaging",
      "ci:web",
    ]) {
      expect(
        decide([change("docs/local-development.md")], [label]).lanes[
          "ui-smoke"
        ],
      ).toBe(false);
    }
  });

  it("selects macOS checks when requested above a documentation floor", () => {
    const decision = decide(
      [change("docs/local-development.md")],
      ["ci:macos"],
    );
    expect(selectChecks(POLICY, decision)).toContain("source-sync-macos");
  });

  it("parses GitHub label objects, ignores other labels and deduplicates requests", () => {
    expect(
      parseLabels('[{"name":"ci:web"}, {"name":"bug"}, "ci:macos", "ci:web"]'),
    ).toEqual(["ci:macos", "ci:web"]);
    expect(decide([change("apps/web/a.ts")], ["bug"]).requests).toEqual([]);
  });

  it("rejects unknown ci:* labels and malformed label input with an actionable error", () => {
    expect(() => parseLabels('["ci:weeb"]')).toThrow(/ci:weeb.*ci:web/);
    expect(() => decide([change("apps/web/a.ts")], ["ci:skip"])).toThrow(
      /Unknown CI label/,
    );
    for (const raw of ["{", "{}", "[42]", '[{"color":"blue"}]']) {
      expect(() => parseLabels(raw)).toThrow(/LABELS_JSON/);
    }
  });
});

describe("CI scope policy and ledger", () => {
  it("rejects malformed policy instead of trusting partial false outputs", () => {
    for (const patch of [
      { schema_version: 2 },
      { max_paths: 301 },
      { lane_names: ["Bad_Lane"] },
      { path_rules: [{ id: "bad", include: ["**"], lanes: ["ui-smoke"] }] },
      { path_rules: [{ id: "bad", include: ["**"], lanes: ["unknown"] }] },
      {
        path_rules: [
          { id: "bad", include: ["**"], lanes: ["control-plane-db"] },
        ],
      },
      {
        checks: {
          bad: {
            when: { always: "false", full: true, any_lanes: [] },
            commands: [],
          },
        },
      },
    ]) {
      expect(() => validatePolicy({ ...POLICY, ...patch })).toThrow(/policy/i);
    }
    expect(() => loadPolicy(`${POLICY_PATH}.missing`)).toThrow(/policy/i);
  });

  it("has a deterministic digest independent of JSON key order", () => {
    const reordered = Object.fromEntries(Object.entries(POLICY).reverse());
    expect(policyDigest(reordered)).toBe(policyDigest(POLICY));
    expect(policyDigest(POLICY)).toMatch(/^[a-f0-9]{64}$/);
    expect(canonicalJson({ z: { b: false, a: true }, a: 1 })).toBe(
      '{"a":1,"z":{"a":true,"b":false}}',
    );
  });

  it("emits the canonical, bounded v1 ledger with boolean lane values", () => {
    const decision = decide([change("apps/web/a.ts")], ["ci:macos", "ci:web"]);
    decision.reasons.push(
      ...Array.from(
        { length: 400 },
        (_, index) => `${index}: ${"\u{1f600}".repeat(20_000)}`,
      ),
    );
    const ledger = createLedger({
      decision,
      policy: POLICY,
      event: "pull_request",
      mode: "pr",
      baseSha: SHA,
      sourceSha: SHA,
      testedSha: SHA,
    });
    expect(ledger.schema).toBe("zeros.ci-selection/v1");
    expect(Object.keys(ledger)).toEqual(Object.keys(ledger).sort());
    expect(Object.keys(ledger.lanes)).toEqual([...POLICY.lane_names].sort());
    expect(
      Object.values(ledger.lanes).every((value) => typeof value === "boolean"),
    ).toBe(true);
    expect(ledger.requests).toEqual(["ci:macos", "ci:web"]);
    expect(Buffer.byteLength(canonicalJson(ledger))).toBeLessThanOrEqual(
      64 * 1024,
    );
    expect(JSON.parse(canonicalJson(ledger))).toEqual(ledger);
    expect(() =>
      createLedger({
        decision: { ...decision, lanes: { ...decision.lanes, web: "false" } },
        policy: POLICY,
        event: "push",
        mode: "pr",
      }),
    ).toThrow(/boolean/);
  });

  it("retains fallback and request diagnostics when many path reasons are bounded", () => {
    const changes = [
      ...Array.from({ length: 100 }, (_, index) =>
        change(`apps/web/file-${index}.ts`),
      ),
      change("unknown/file.ts"),
    ];
    const decision = decide(changes, ["ci:ui-smoke"]);
    expect(decision.full).toBe(true);
    expect(
      decision.reasons.some((reason: string) =>
        reason.startsWith("unknown-path:"),
      ),
    ).toBe(true);
    expect(
      decision.reasons.some((reason: string) =>
        reason.startsWith("label-request:"),
      ),
    ).toBe(true);
    expect(
      decision.reasons.some((reason: string) =>
        reason.startsWith("additional-reasons:"),
      ),
    ).toBe(true);
  });

  it("makes selection and its ledger independent of path and label order", () => {
    const changes = [
      change("apps/web/a.ts"),
      change("apps/desktop/src/engine/git/diff.ts"),
    ];
    const labels = ["ci:macos", "ci:web"];
    const first = decide(changes, labels);
    const second = decide([...changes].reverse(), [...labels].reverse());
    expect(first).toEqual(second);
    expect(
      canonicalJson(
        createLedger({
          decision: first,
          policy: POLICY,
          event: "pull_request",
          mode: "pr",
        }),
      ),
    ).toBe(
      canonicalJson(
        createLedger({
          decision: second,
          policy: POLICY,
          event: "pull_request",
          mode: "pr",
        }),
      ),
    );
  });
});

describe("CI scope Git evidence and CLI", () => {
  const repositories: string[] = [];
  afterEach(() => {
    for (const cwd of repositories.splice(0))
      rmSync(cwd, { recursive: true, force: true });
  });
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const put = (cwd: string, file: string, text = "export {};\n") => {
    mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    writeFileSync(path.join(cwd, file), text);
  };
  const commit = (cwd: string) => {
    git(cwd, "add", "-A");
    git(cwd, "commit", "--quiet", "-m", "scope test change");
    return git(cwd, "rev-parse", "HEAD");
  };
  function repository() {
    const cwd = mkdtempSync(path.join(tmpdir(), "ci-scope-"));
    repositories.push(cwd);
    git(cwd, "init", "--quiet");
    git(cwd, "config", "user.name", "CI Scope Test");
    git(cwd, "config", "user.email", "ci-scope@invalid.example");
    put(cwd, "apps/web/moved.ts");
    put(cwd, "apps/web/deleted.ts");
    const base = commit(cwd);
    git(cwd, "update-ref", "refs/remotes/origin/main", base);
    return { cwd, base };
  }
  const env = (base: string, head: string) => ({
    EVENT_NAME: "pull_request",
    PULL_REQUEST_BASE_SHA: base,
    PULL_REQUEST_HEAD_SHA: head,
    GITHUB_SHA: head,
  });
  const cli = (cwd: string, environment: Record<string, string>, mode = "pr") =>
    spawnSync(process.execPath, [SCOPE, "--mode", mode], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        EVENT_NAME: "",
        PULL_REQUEST_BASE_SHA: "",
        PULL_REQUEST_HEAD_SHA: "",
        MERGE_GROUP_BASE_SHA: "",
        PUSH_BEFORE_SHA: "",
        GITHUB_SHA: "",
        LABELS_JSON: "[]",
        FORCE_FULL: "false",
        GITHUB_STEP_SUMMARY: "",
        ...environment,
      },
    });

  it("parses strict UTF-8, NUL-delimited names including both rename owners", () => {
    expect(
      parseNameStatus(
        Buffer.from(
          "R100\0apps/web/a.ts\0apps/desktop/src/engine/a.ts\0D\0apps/web/b.ts\0",
        ),
      ),
    ).toEqual([
      change("apps/desktop/src/engine/a.ts", "R100", "apps/web/a.ts"),
      change("apps/web/b.ts", "D"),
    ]);
    expect(parseNameStatus(Buffer.from("M\0apps/web/line\nname.ts\0"))).toEqual(
      [change("apps/web/line\nname.ts")],
    );
    for (const malformed of [
      Buffer.from("M\0apps/web/a.ts"),
      Buffer.from("U\0apps/web/a.ts\0"),
      Buffer.from([77, 0, 255, 0]),
      Buffer.from("M\0../web.ts\0"),
    ]) {
      expect(() => parseNameStatus(malformed)).toThrow();
    }
  });

  it("reports deletions and both rename paths without a full-set fallback", () => {
    const { cwd, base } = repository();
    mkdirSync(path.join(cwd, "apps/desktop/src/renderer"), { recursive: true });
    renameSync(
      path.join(cwd, "apps/web/moved.ts"),
      path.join(cwd, "apps/desktop/src/renderer/moved.ts"),
    );
    rmSync(path.join(cwd, "apps/web/deleted.ts"));
    const head = commit(cwd);
    const comparison = collectPrChanges({ cwd, env: env(base, head) });
    expect(comparison.reason).toBeNull();
    expect(comparison.changes).toEqual([
      change("apps/desktop/src/renderer/moved.ts", "A"),
      change("apps/web/deleted.ts", "D"),
      change("apps/web/moved.ts", "D"),
    ]);
    expect(
      decideScope({ policy: POLICY, changes: comparison.changes }).full,
    ).toBe(false);
  });

  it("fails closed for missing, zero, absent, non-ancestor or shallow bases", () => {
    const { cwd, base } = repository();
    put(cwd, "apps/web/change.ts");
    const head = commit(cwd);
    for (const badBase of ["", "0".repeat(40), SHA, "--output=unsafe"]) {
      const comparison = collectPrChanges({ cwd, env: env(badBase, head) });
      expect(comparison.changes).toBeNull();
      expect(comparison.reason).toBeTruthy();
      const result = cli(cwd, env(badBase, head));
      expect(result.status).toBe(0);
      expect(
        JSON.parse(result.stdout.split("\n")[0]!.slice(7)).lanes["ui-smoke"],
      ).toBe(false);
    }
    git(cwd, "checkout", "--quiet", "-b", "other", base);
    put(cwd, "apps/web/other.ts");
    const other = commit(cwd);
    git(cwd, "checkout", "--quiet", "--detach", head);
    expect(collectPrChanges({ cwd, env: env(other, head) }).reason).toMatch(
      /non-ancestor/,
    );

    const shallow = mkdtempSync(path.join(tmpdir(), "ci-scope-shallow-"));
    repositories.push(shallow);
    git(shallow, "clone", "--quiet", "--depth=1", `file://${cwd}`, ".");
    expect(
      collectPrChanges({ cwd: shallow, env: env(base, head) }).reason,
    ).toMatch(/shallow/);
  });

  it("validates source and tested identity and event-specific bases", () => {
    const { cwd, base } = repository();
    put(cwd, "apps/web/change.ts");
    const head = commit(cwd);
    for (const environment of [
      {
        EVENT_NAME: "merge_group",
        MERGE_GROUP_BASE_SHA: base,
        GITHUB_SHA: head,
      },
      { EVENT_NAME: "push", PUSH_BEFORE_SHA: base, GITHUB_SHA: head },
    ]) {
      expect(collectPrChanges({ cwd, env: environment }).reason).toBeNull();
      const mismatch = collectPrChanges({
        cwd,
        env: { ...environment, GITHUB_SHA: base },
      });
      expect(mismatch.reason).toMatch(/tested-sha/);
      expect(mismatch.sourceSha).toBe(base);
      expect(mismatch.testedSha).toBe(head);
    }
    expect(
      collectPrChanges({ cwd, env: { ...env(base, head), GITHUB_SHA: base } })
        .reason,
    ).toMatch(/tested-sha/);
    expect(
      collectPrChanges({
        cwd,
        env: { ...env(base, head), PULL_REQUEST_HEAD_SHA: SHA },
      }).reason,
    ).toMatch(/source/);
    expect(
      collectPrChanges({ cwd, env: { EVENT_NAME: "workflow_dispatch" } })
        .reason,
    ).toMatch(/unsupported-event/);
    const missingRepo = mkdtempSync(path.join(tmpdir(), "ci-scope-not-git-"));
    repositories.push(missingRepo);
    expect(
      collectPrChanges({ cwd: missingRepo, env: env(base, head) }).reason,
    ).toMatch(/diff-error/);
    expect(
      collectPrChanges({ cwd: missingRepo, env: env(base, head) }).testedSha,
    ).toBeNull();
  });

  it("records a PR source separately from its synthetic merge checkout", () => {
    const { cwd, base } = repository();
    git(cwd, "checkout", "--quiet", "-b", "source");
    put(cwd, "apps/web/source.ts");
    const source = commit(cwd);
    git(cwd, "checkout", "--quiet", "-b", "target", base);
    put(cwd, "apps/desktop/src/engine/later-base.ts");
    const laterBase = commit(cwd);
    git(cwd, "merge", "--quiet", "--no-ff", "-m", "synthetic merge", "source");
    const tested = git(cwd, "rev-parse", "HEAD");
    const comparison = collectPrChanges({
      cwd,
      env: { ...env(laterBase, source), GITHUB_SHA: tested },
    });
    expect(comparison).toEqual({
      baseSha: laterBase,
      sourceSha: source,
      testedSha: tested,
      changes: [change("apps/web/source.ts", "A")],
      reason: null,
    });
    expect(
      decideScope({ policy: POLICY, changes: comparison.changes }).full,
    ).toBe(false);
  });

  it("unions committed, staged, unstaged and untracked local work from origin/main", () => {
    const { cwd, base } = repository();
    put(cwd, "apps/desktop/src/renderer/committed.ts");
    const head = commit(cwd);
    put(cwd, "apps/control-plane/src/staged.ts");
    git(cwd, "add", "apps/control-plane/src/staged.ts");
    put(cwd, "apps/web/moved.ts", "export const changed = true;\n");
    put(cwd, "catalogs/untracked.json", "{}\n");
    const comparison = collectLocalChanges({ cwd });
    expect(comparison.baseSha).toBe(base);
    expect(comparison.testedSha).toBe(head);
    expect(
      comparison.changes
        .map((entry: ReturnType<typeof change>) => entry.path)
        .sort(),
    ).toEqual([
      "apps/control-plane/src/staged.ts",
      "apps/desktop/src/renderer/committed.ts",
      "apps/web/moved.ts",
      "catalogs/untracked.json",
    ]);
    const result = cli(cwd, {}, "local");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Base SHA: ${base}`);
    expect(result.stdout).toMatch(/Lane\s+Selected\s+Reasons/);
    expect(result.stdout).toContain("ci:ui-smoke");
    expect(result.stdout).toContain("ci:full");
  });

  it("emits complete GitHub outputs and matching step-summary diagnostics", () => {
    const { cwd, base } = repository();
    put(cwd, "apps/web/change.ts");
    const head = commit(cwd);
    const summary = path.join(cwd, "summary.md");
    const result = cli(cwd, {
      ...env(base, head),
      GITHUB_STEP_SUMMARY: summary,
    });
    expect(result.status).toBe(0);
    const [ledgerLine, ...lines] = result.stdout.trim().split("\n");
    expect(ledgerLine).toMatch(/^ledger=/);
    const ledger = JSON.parse(ledgerLine!.slice(7));
    expect(ledger.base_sha).toBe(base);
    expect(ledger.source_sha).toBe(head);
    expect(ledger.tested_sha).toBe(head);
    expect(ledger.mode).toBe("pr");
    expect(ledger.event).toBe("pull_request");
    expect(ledgerLine!.slice(7)).toBe(canonicalJson(ledger));
    expect(lines).toEqual(
      Object.keys(ledger.lanes).map((lane) => `${lane}=${ledger.lanes[lane]}`),
    );
    for (const reason of ledger.reasons) {
      expect(result.stderr).toContain(reason);
      expect(readFileSync(summary, "utf8")).toContain(reason);
    }
  });

  it("ignores diff evidence in full mode but rejects unknown labels before output", () => {
    const { cwd } = repository();
    const result = cli(
      cwd,
      { EVENT_NAME: "push", PUSH_BEFORE_SHA: SHA },
      "full",
    );
    expect(result.status).toBe(0);
    expect(
      Object.values(
        JSON.parse(result.stdout.split("\n")[0]!.slice(7)).lanes,
      ).every((value) => value === true),
    ).toBe(true);
    const pushWithStalePr = cli(
      cwd,
      {
        EVENT_NAME: "push",
        PULL_REQUEST_HEAD_SHA: SHA,
      },
      "full",
    );
    const pushLedger = JSON.parse(
      pushWithStalePr.stdout.split("\n")[0]!.slice(7),
    );
    expect(pushLedger.source_sha).toBe(pushLedger.tested_sha);
    const badLabel = cli(cwd, { LABELS_JSON: '["ci:skip"]' }, "full");
    expect(badLabel.status).not.toBe(0);
    expect(badLabel.stdout).toBe("");
    expect(badLabel.stderr).toMatch(/Unknown CI label.*ci:skip/);
    expect(cli(cwd, { FORCE_FULL: "maybe" }).status).not.toBe(0);
  });

  it("returns a nonzero CLI result for malformed policy with no partial output", () => {
    const { cwd } = repository();
    const policyPath = path.join(cwd, "bad-policy.json");
    writeFileSync(policyPath, "{\n");
    let stdout = "";
    let stderr = "";
    const status = runCli({
      argv: ["--mode", "pr"],
      env: {},
      cwd,
      policyPath,
      stdout: {
        write: (text: string) => {
          stdout += text;
        },
      },
      stderr: {
        write: (text: string) => {
          stderr += text;
        },
      },
    });
    expect(status).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toMatch(/policy/i);
  });

  it("preserves declared event source identity in full mode independently of the checkout", () => {
    const { cwd, base } = repository();
    for (const environment of [
      { EVENT_NAME: "push", GITHUB_SHA: SHA },
      { EVENT_NAME: "merge_group", GITHUB_SHA: SHA },
      { EVENT_NAME: "pull_request", PULL_REQUEST_HEAD_SHA: SHA },
    ]) {
      const result = cli(cwd, environment, "full");
      expect(result.status).toBe(0);
      const ledger = JSON.parse(result.stdout.split("\n")[0]!.slice(7));
      expect(ledger.source_sha).toBe(SHA);
      expect(ledger.tested_sha).toBe(base);
      expect(Object.values(ledger.lanes).every((value) => value === true)).toBe(
        true,
      );
    }
    const missingRepo = mkdtempSync(
      path.join(tmpdir(), "ci-scope-full-not-git-"),
    );
    repositories.push(missingRepo);
    const result = cli(
      missingRepo,
      { EVENT_NAME: "push", GITHUB_SHA: SHA },
      "full",
    );
    expect(result.status).toBe(0);
    const ledger = JSON.parse(result.stdout.split("\n")[0]!.slice(7));
    expect(ledger.source_sha).toBe(SHA);
    expect(ledger.tested_sha).toBeNull();
  });
});
