import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// skills_list scans the per-agent skill-dir hierarchy. Isolate it from the real
// machine: currentRoot() → a temp workspace, and os.homedir() → a temp home so
// the ~/.<agent>/skills roots are deterministic.
const sidecarMock = vi.hoisted(() => ({ root: null as string | null }));
vi.mock("../../../sidecar", () => ({ currentRoot: () => sidecarMock.root }));

const homeMock = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const mocked = { ...actual, homedir: () => homeMock.dir };
  return { ...mocked, default: mocked };
});

import { skillsList } from "../skills";

interface Skill {
  id: string;
  name: string;
  description: string;
  path: string;
  content: string;
}
const call = (args: Record<string, unknown>): Skill[] =>
  (skillsList as unknown as (a: Record<string, unknown>) => Skill[])(args);

const writeSkill = (root: string, name: string, desc: string) => {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n`,
  );
};

describe("skills_list", () => {
  let cwd = "";
  let home = "";
  beforeEach(() => {
    vi.stubEnv("CODEX_HOME", "");
    cwd = mkdtempSync(path.join(tmpdir(), "zeros-skills-cwd-"));
    home = mkdtempSync(path.join(tmpdir(), "zeros-skills-home-"));
    sidecarMock.root = cwd;
    homeMock.dir = home;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    sidecarMock.root = null;
    homeMock.dir = "";
  });

  it("scans ~/.claude/skills/<name>/SKILL.md for the claude agent", () => {
    writeSkill(path.join(home, ".claude", "skills"), "wrangler", "Workers CLI");
    const out = call({ agentId: "claude", cwd });
    expect(out.map((s) => s.name)).toContain("wrangler");
    expect(out.find((s) => s.name === "wrangler")?.description).toBe("Workers CLI");
  });

  it("workspace .claude/skills overrides the home dir on a name clash", () => {
    writeSkill(path.join(home, ".claude", "skills"), "wrangler", "HOME");
    writeSkill(path.join(cwd, ".claude", "skills"), "wrangler", "WORKSPACE");
    const out = call({ agentId: "claude", cwd });
    expect(out.filter((s) => s.name === "wrangler")).toHaveLength(1);
    expect(out.find((s) => s.name === "wrangler")?.description).toBe("WORKSPACE");
  });

  it("routes by agentId: cursor reads ~/.cursor/skills, not ~/.claude/skills", () => {
    writeSkill(path.join(home, ".claude", "skills"), "claude-only", "c");
    writeSkill(path.join(home, ".cursor", "skills"), "cursor-only", "x");
    const out = call({ agentId: "cursor", cwd });
    const names = out.map((s) => s.name);
    expect(names).toContain("cursor-only");
    expect(names).not.toContain("claude-only");
  });

  it("falls back to the directory name when frontmatter omits name", () => {
    const dir = path.join(home, ".codex", "skills", "no-name");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "SKILL.md"), `---\ndescription: d\n---\nbody\n`);
    const out = call({ agentId: "codex", cwd });
    expect(out.find((s) => s.id === "no-name")?.name).toBe("no-name");
  });

  it("also accepts a flat <name>.md file (older convention)", () => {
    const root = path.join(cwd, "skills");
    mkdirSync(root, { recursive: true });
    writeFileSync(
      path.join(root, "flat.md"),
      `---\nname: flat\ndescription: flat skill\n---\nbody\n`,
    );
    const out = call({ agentId: "claude", cwd });
    expect(out.find((s) => s.name === "flat")?.description).toBe("flat skill");
  });

  it("returns [] when no skill dir exists (never throws)", () => {
    expect(call({ agentId: "claude", cwd })).toEqual([]);
  });

  it("discovers bundled Codex system skills inside a custom provider home", () => {
    const codexHome = path.join(home, "codex-home");
    vi.stubEnv("CODEX_HOME", codexHome);
    writeSkill(path.join(codexHome, "skills", ".system"), "review", "bundled");
    expect(call({ agentId: "codex", cwd }).map(s => s.id)).toContain("review");
  });

  it("discovers shared project skills and lets project sources override user libraries", () => {
    writeSkill(path.join(home, ".claude", "skills"), "shared", "HOME");
    writeSkill(path.join(cwd, "skills"), "shared", "PROJECT");
    writeSkill(path.join(cwd, ".agents", "skills"), "shared-agent", "SHARED");
    const out = call({ agentId: "claude", cwd });
    expect(out.find(s => s.id === "shared")?.description).toBe("PROJECT");
    expect(out.find(s => s.id === "shared-agent")?.content).toContain("name: shared-agent");
  });

  it("does not read a repository skill root redirected outside its owner", () => {
    writeSkill(path.join(home, "outside"), "private", "not a project skill");
    mkdirSync(path.join(cwd, ".claude"));
    symlinkSync(path.join(home, "outside"), path.join(cwd, ".claude", "skills"));
    expect(call({ agentId: "claude", cwd })).toEqual([]);
  });

  it("bounds full-source responses and skips symlinks and oversized files", () => {
    const root = path.join(cwd, "skills");
    mkdirSync(root);
    writeFileSync(path.join(root, "huge.md"), "x".repeat(256 * 1024 + 1));
    writeFileSync(path.join(home, "outside.md"), "do not read");
    mkdirSync(path.join(root, "link"));
    symlinkSync(path.join(home, "outside.md"), path.join(root, "link", "SKILL.md"));
    for (let i = 0; i < 20; i++) writeSkill(root, `large-${i}`, "x".repeat(120_000));
    const out = call({ agentId: "claude", cwd });
    expect(out.some(s => s.id === "huge" || s.id === "link")).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(out.length).toBeGreaterThan(0);
  });
});
