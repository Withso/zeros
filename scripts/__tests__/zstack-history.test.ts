import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mineHistory, runCli } from "../zstack/history.mjs";

const roots: string[] = [];
const script = path.resolve("scripts/zstack/history.mjs");
const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
const cleanEnv = () => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  return env;
};
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
function temporary() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "zstack-history-")));
  roots.push(root);
  return root;
}
function repository() {
  const root = temporary();
  const git = (...args: string[]) => execFileSync(realGit, args, { cwd: root, env: cleanEnv(), encoding: "utf8", stdio: "pipe" }).trim();
  const write = (file: string, content: string) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  };
  git("init", "-q", "--initial-branch=main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  const commit = (subject: string, files: Record<string, string> = {}, body?: string) => {
    for (const [file, content] of Object.entries(files)) write(file, content);
    git("add", ".");
    git("commit", "-q", "--allow-empty", "-m", subject, ...(body ? ["-m", body] : []));
    return git("rev-parse", "HEAD");
  };
  const entry = (id: string, area = "zstack", fixedBy = "pr:10") => ({
    id, kind: "replay", area, fixedBy, symptom: "Repeated fixture mistake", rule: "A held boundary", check: "pnpm test:git scripts/__tests__/fixture.test.ts",
  });
  const pack = {
    "agents/zstack/evals/cases.json": JSON.stringify({ schema: "zeros.zstack-evals/v1", cases: [entry("first-case"), entry("third-case", "scripts")] }),
    "agents/zstack/evals/cases/second-case.json": JSON.stringify(entry("second-case", "zstack", "pr:11")),
    "agents/zstack/principles.md": "# Principles\n\n## Identity\n\n1. **Fence the owner.** Keep identity.\n   Cases: `first-case`,\n   `second-case`, `first-case`.\n\n2. **No prose-only closure.** Use an enforcer.\n",
    "agents/zstack/enforcement.md": "# Enforcement\n\n| Rule | Enforcers | Scope |\n| --- | --- | --- |\n| [A1](../../AGENTS.md#working-method) First rule. <!-- rule:AGENTS.md:1111111111111111 --> | judgment only | Review |\n| [A2](../../AGENTS.md#working-method) Second rule. <!-- rule:AGENTS.md:2222222222222222 --> | judgment only | Review |\n| [R1](../../RULES.md#tests) Test rule. <!-- rule:RULES.md:3333333333333333 --> | `existing.test.ts` | Tested |\n",
    "src/cache.ts": "export const value = 0;\n",
  };
  const initial = commit("Initial fixture", pack);
  return { root, git, write, commit, entry, initial, pack };
}
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("zstack history miner", () => {
  it("groups real Git, eval and rule evidence deterministically at one revision", () => {
    const repo = repository();
    const first = repo.commit("fix(cache): keep owner (#10)", { "src/cache.ts": "export const value = 1;\n" }, "BODY_MUST_NEVER_APPEAR");
    repo.commit("docs: clarify use", { "README.md": "fixture\n" });
    const second = repo.commit("Fix a late cache response (#11)", { "src/cache.ts": "export const value = 2;\n" });
    const reverted = repo.commit('Revert "Fix a late cache response (#11)"', { "src/cache.ts": "export const value = 1;\n" });
    const report = mineHistory(repo.root, { limit: 100 });
    expect(report).toEqual(mineHistory(repo.root, { limit: 100 }));
    expect(report.revision).toBe(reverted);
    expect(report.coverage).toMatchObject({ historyCommits: 5, historyTruncated: false, shallow: false, cases: 3, uncitedCases: 1, judgmentRules: 2 });
    const area = report.clusters.find((cluster: { id: string }) => cluster.id === "area:zstack");
    expect(area.evidence.caseIds).toEqual(["first-case", "second-case"]);
    expect(area.evidence.commits.map((commit: { sha: string }) => commit.sha).sort()).toEqual([first, second].sort());
    const principle = report.clusters.find((cluster: { id: string }) => cluster.id === "principle:1");
    expect(principle.evidence.caseIds).toEqual(["first-case", "second-case"]);
    const judgment = report.clusters.find((cluster: { id: string }) => cluster.id === "judgment:AGENTS.md#working-method");
    expect(judgment.evidence.ruleIds).toEqual(["A1", "A2"]);
    expect(judgment.evidence.ruleFingerprints).toContain("AGENTS.md:1111111111111111");
    const history = report.clusters.find((cluster: { id: string }) => cluster.id === "history:src/cache.ts");
    expect(history.evidence.commits.map((commit: { sha: string }) => commit.sha)).toEqual([reverted, second, first]);
    expect(history.evidence.commits.map((commit: { kind: string }) => commit.kind)).toEqual(["revert", "fix", "fix"]);
    expect(history.evidence.files).toEqual(["src/cache.ts"]);
    expect(JSON.stringify(report)).not.toContain("BODY_MUST_NEVER_APPEAR");
    expect(JSON.stringify(report)).not.toContain("export const value");
    expect(report.clusters.map((cluster: { score: number }) => cluster.score)).toEqual(report.clusters.map((cluster: { score: number }) => cluster.score).sort((a: number, b: number) => b - a));
  });

  it("uses committed pack bytes, ignores foreign Git routing and stays read-only", () => {
    const repo = repository(), foreign = repository();
    const before = mineHistory(repo.root, { limit: 100 });
    repo.write("agents/zstack/principles.md", "uncommitted and invalid");
    repo.write("agents/zstack/evals/cases/uncommitted.json", "invalid");
    const status = repo.git("status", "--porcelain");
    const refs = repo.git("show-ref");
    vi.stubEnv("GIT_DIR", path.join(foreign.root, ".git"));
    vi.stubEnv("GIT_WORK_TREE", foreign.root);
    vi.stubEnv("GIT_INDEX_FILE", path.join(foreign.root, ".git/index"));
    expect(mineHistory(repo.root, { limit: 100 })).toEqual(before);
    expect(repo.git("status", "--porcelain")).toBe(status);
    expect(repo.git("show-ref")).toBe(refs);
    mkdirSync(path.join(repo.root, "subdir"));
    expect(mineHistory(path.join(repo.root, "subdir"), { limit: 100 })).toEqual(before);
  });

  it("reports bounded history, display truncation and unresolved fix references", () => {
    const repo = repository();
    repo.commit("fix: first (#10)", { "src/cache.ts": "one" });
    const head = repo.commit("fix: second (#11)", { "src/cache.ts": "two" });
    const report = mineHistory(repo.root, { maxCommits: 1, limit: 1 });
    expect(report.revision).toBe(head);
    expect(report.coverage).toMatchObject({ historyCommits: 1, historyTruncated: true, unresolvedFixRefs: ["pr:10"] });
    expect(report.clusters).toHaveLength(1);
    expect(report.totalClusters).toBeGreaterThan(1);
    expect(mineHistory(repo.root, { revision: repo.initial }).revision).toBe(repo.initial);
  });

  it("keeps deterministic order for equal scores and deduplicates one commit's paths", () => {
    const repo = repository();
    repo.commit("fix: one", { "src/z.ts": "one", "src/a.ts": "one" });
    repo.commit("fix: two", { "src/z.ts": "two", "src/a.ts": "two" });
    const report = mineHistory(repo.root, { limit: 100 });
    const peers = report.clusters.filter((cluster: { id: string }) => cluster.id.startsWith("history:"));
    expect(peers.map((cluster: { id: string }) => cluster.id)).toEqual(["history:src/a.ts", "history:src/z.ts"]);
    expect(peers[0].evidence.commits).toHaveLength(2);
  });

  it("uses first-parent changes for merge fixes and does not count branch commits twice", () => {
    const repo = repository();
    repo.git("checkout", "-qb", "topic");
    const branch = repo.commit("fix: topic", { "src/cache.ts": "topic" });
    repo.git("checkout", "-q", "main");
    repo.commit("docs: main", { "README.md": "main" });
    repo.git("merge", "--no-ff", "topic", "-m", "fix: integrate topic");
    const merged = repo.git("rev-parse", "HEAD");
    const next = repo.commit("fix: follow-up", { "src/cache.ts": "follow-up" });
    const history = mineHistory(repo.root, { limit: 100 }).clusters.find((cluster: { id: string }) => cluster.id === "history:src/cache.ts");
    expect(history.evidence.commits.map((commit: { sha: string }) => commit.sha)).toEqual([next, merged]);
    expect(JSON.stringify(history)).not.toContain(branch);
  });

  it("redacts subjects and does not disclose bodies, unsafe paths or credentials", () => {
    const repo = repository();
    const secret = "opaque-fixture-" + "q".repeat(40);
    repo.commit(`fix: token=${secret}`, { "src/cache.ts": "one", ".env.private-fixture": "NEVER_READ_THIS_FIXTURE", "src/odd\nname.ts": "one" }, `BODY_ONLY_${secret}`);
    repo.commit("fix: handle \u202ehttps://name:password@example.invalid/private\u0007", { "src/cache.ts": "two", "src/odd\nname.ts": "two" });
    const out = JSON.stringify(mineHistory(repo.root, { limit: 100 }));
    for (const value of [secret, "BODY_ONLY", "NEVER_READ", "name:password", "odd\\nname", ".env.private"]) expect(out).not.toContain(value);
    expect(out).toContain("[redacted]");
    expect(out).not.toMatch(/[\p{Cc}\p{Cf}]/u);
  });

  it.each(["PASSWORD=", "DATABASE_PASSWORD=", "API_KEY=", "FOO_TOKEN=", "--password ", "'--password' ", "\"--token\" ", "curl --user fixture:"])("omits short credential values introduced by %s in a subject", prefix => {
    const repo = repository(), secret = ["subject", "canary"].join("-");
    repo.commit(`fix: ${prefix}${secret} (#10)`, { "src/cache.ts": "one" });
    expect(JSON.stringify(mineHistory(repo.root))).not.toContain(secret);
  });

  it.each([
    ["agents/zstack/evals/cases/bad.json", "{}"],
    ["agents/zstack/principles.md", "1. **Unknown case.**\n   Cases: `not-a-case`.\n"],
    ["agents/zstack/enforcement.md", "| Rule | Enforcers | Scope |\n| --- | --- | --- |\n| missing identity | judgment only | review |\n"],
  ])("refuses incomplete pack evidence in %s", (file, contents) => {
    const repo = repository(); repo.commit("Change pack", { [file]: contents });
    expect(() => mineHistory(repo.root)).toThrow("zstack_history_pack_invalid");
  });

  it("refuses pack symlinks without reading their targets", () => {
    const repo = repository(), secret = path.join(temporary(), "private");
    writeFileSync(secret, "PRIVATE_FIXTURE_NOT_FOR_OUTPUT");
    rmSync(path.join(repo.root, "agents/zstack/principles.md"));
    symlinkSync(secret, path.join(repo.root, "agents/zstack/principles.md"));
    repo.commit("Link pack");
    expect(() => mineHistory(repo.root)).toThrow("zstack_history_pack_invalid");
  });

  it("does not fetch a missing promisor blob, even with a reachable file remote", () => {
    const repo = repository(), store = temporary(), marker = path.join(temporary(), "remote-accessed");
    repo.git("clone", "-q", "--bare", repo.root, store);
    const upload = path.join(temporary(), "upload");
    writeFileSync(upload, `#!/bin/sh\nprintf touched > ${quote(marker)}\nexec ${quote(realGit)} upload-pack "$@"\n`, { mode: 0o755 });
    repo.git("remote", "add", "origin", `file://${store}`);
    repo.git("config", "remote.origin.promisor", "true");
    repo.git("config", "remote.origin.partialclonefilter", "blob:none");
    repo.git("config", "remote.origin.uploadpack", upload);
    const oid = repo.git("rev-parse", "HEAD:agents/zstack/principles.md");
    rmSync(path.join(repo.root, ".git/objects", oid.slice(0, 2), oid.slice(2)));
    expect(() => mineHistory(repo.root)).toThrow("zstack_history_git_unavailable");
    expect(() => readFileSync(marker)).toThrow();
  });

  it("supports old Git on a full clone but refuses an old promisor reader", () => {
    const repo = repository(), bin = temporary();
    writeFileSync(path.join(bin, "git"), `#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = --no-lazy-fetch ]; then exit 129; fi\ndone\nexec ${quote(realGit)} "$@"\n`, { mode: 0o755 });
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
    expect(mineHistory(repo.root).revision).toBe(repo.initial);
    repo.git("config", "remote.origin.promisor", "false");
    expect(mineHistory(repo.root).revision).toBe(repo.initial);
    repo.git("config", "remote.origin.promisor", "true");
    expect(() => mineHistory(repo.root)).toThrow("zstack_history_git_version");
    repo.git("config", "--unset", "remote.origin.promisor");
    repo.git("config", "extensions.partialclone", "origin");
    expect(() => mineHistory(repo.root)).toThrow("zstack_history_git_version");
  });

  it("marks a shallow clone rather than claiming all history", () => {
    const repo = repository(), shallow = temporary();
    repo.commit("fix: one", { "src/cache.ts": "one" });
    repo.git("clone", "-q", "--depth=1", `file://${repo.root}`, shallow);
    expect(mineHistory(shallow).coverage).toMatchObject({ shallow: true, historyCommits: 1 });
  });

  it("does not invent file retouches for empty fixes or resolve ambiguous PR titles", () => {
    const repo = repository();
    repo.commit("fix: empty one (#10)");
    repo.commit("fix: empty two (#10)");
    const report = mineHistory(repo.root, { limit: 100 });
    expect(report.coverage.unresolvedFixRefs).toContain("pr:10");
    expect(report.clusters.some((cluster: { kind: string }) => cluster.kind === "history")).toBe(false);
    expect(report.clusters.find((cluster: { id: string }) => cluster.id === "area:zstack").evidence.commits).toEqual([]);
  });

  it("keeps judgment gaps reachable when repeated file fixes dominate the ranking", () => {
    const repo = repository();
    for (let step = 0; step < 3; step++) repo.commit(`fix: bulk ${step}`, Object.fromEntries(
      Array.from({ length: 120 }, (_, i) => [`src/file-${i}.ts`, String(step)])));
    const report = mineHistory(repo.root, { kind: "judgment", limit: 100 });
    expect(report.selection).toEqual({ kind: "judgment", limit: 100 });
    expect(report.totalClusters).toBe(1);
    expect(report.clusters.map((cluster: { id: string }) => cluster.id)).toEqual(["judgment:AGENTS.md#working-method"]);
    expect(report.clusters[0].evidence.ruleIds).toEqual(["A1", "A2"]);
  });

  it("excludes lesson records and generated skills from file-retouch clusters", () => {
    const repo = repository();
    const records = ["agents/zstack/changes/lesson.md", "agents/zstack/records/measurement.md", "agents/zstack/playbooks/bug-fix.md",
      ".agents/skills/zstack/SKILL.md", ".claude/skills/zstack/SKILL.md", ".cursor/rules/zstack.mdc",
      "CHANGELOG.md", "packages/fixture/CHANGELOG.v1.md"];
    for (let step = 0; step < 3; step++) repo.commit(`fix: incident ${step} (#${10 + step})`, {
      ...Object.fromEntries(records.map(file => [file, String(step)])),
      [`src/unrelated-${step}.ts`]: String(step),
      ...(step < 2 ? { "src/cache.ts": String(step) } : {}),
    });
    const report = mineHistory(repo.root, { limit: 100 });
    expect(report.clusters.filter((cluster: { kind: string }) => cluster.kind === "history")
      .map((cluster: { id: string }) => cluster.id)).toEqual(["history:src/cache.ts"]);
    expect(report.coverage.ignoredRecordPaths).toBe(records.length);
    for (const kind of ["area", "principle", "judgment"])
      expect(report.clusters.some((cluster: { kind: string }) => cluster.kind === kind)).toBe(true);
  });

  it("recognizes a case's exact fixing SHA even without a fix-prefixed subject", () => {
    const repo = repository();
    const fixed = repo.commit("Fence the owner", { "src/cache.ts": "one" });
    const next = repo.commit("fix: second boundary", { "src/cache.ts": "two",
      "agents/zstack/evals/cases.json": JSON.stringify({ schema: "zeros.zstack-evals/v1", cases: [repo.entry("first-case", "zstack", fixed)] }) });
    const report = mineHistory(repo.root, { kind: "history" });
    const history = report.clusters.find((cluster: { id: string }) => cluster.id === "history:src/cache.ts");
    expect(history.evidence.commits.map((commit: { sha: string }) => commit.sha)).toEqual([next, fixed]);
    expect(history.evidence.caseIds).toEqual(["first-case"]);
    expect(report.coverage.unresolvedFixRefs).not.toContain(fixed);
  });

  it("bounds the legacy case population as well as the one-file-per-case directory", () => {
    const repo = repository();
    repo.commit("Many cases", { "agents/zstack/evals/cases.json": JSON.stringify({ schema: "zeros.zstack-evals/v1",
      cases: Array.from({ length: 4097 }, (_, i) => repo.entry(`case-${i}`)) }) });
    expect(() => mineHistory(repo.root)).toThrow("zstack_history_pack_limit");
  });

  it("prints a human table and machine evidence through the real CLI", () => {
    const repo = repository();
    const execute = (args: string[]) => spawnSync(process.execPath, [script, ...args], { cwd: repo.root, env: cleanEnv(), encoding: "utf8", timeout: 20_000 });
    const json = execute(["--json", "--limit", "100"]);
    expect(json.status, json.stderr).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual(mineHistory(repo.root, { limit: 100 }));
    const table = execute([]);
    expect(table.status, table.stderr).toBe(0);
    for (const text of ["Rank", "Score", "area:zstack", "first-case", "A1"]) expect(table.stdout).toContain(text);
    expect(table.stdout).toContain(repo.initial);
    const filtered = execute(["--kind", "judgment", "--json"]);
    expect(filtered.status, filtered.stderr).toBe(0);
    expect(JSON.parse(filtered.stdout).clusters.map((cluster: { kind: string }) => cluster.kind)).toEqual(["judgment"]);
  });

  it.each([["--shell", "echo no"], ["--limit", "0"], ["--max-commits", "2001"], ["--json", "--json"], ["--revision"], ["--revision", "--all"], ["--kind", "everything"]])("rejects invalid options %j without raw diagnostics", (...argv) => {
    let output = "", error = "";
    expect(runCli({ argv, cwd: temporary(), stdout: { write: (value: string) => { output += value; } }, stderr: { write: (value: string) => { error += value; } } })).toBe(1);
    expect(output).toBe("");
    expect(error).toBe("zstack_history_arguments_invalid\n");
  });
});
