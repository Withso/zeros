import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readEvalCases } from "../zstack/evals.mjs";
import { zstackSkills } from "../zstack/render.mjs";

const root = process.cwd();
const pack = join(root, "agents/zstack");
const tokens = (file: string) => Math.ceil(readFileSync(file, "utf8").length / 4);

// Approximate tokens (characters / 4). A failing budget means fold or cut text.
const SKILL_BUDGETS: Record<string, number> = {
  zstack: 1800,
  "zstack-verify": 2000,
  "zstack-review": 1700,
  "zstack-eval": 1500,
  "zstack-learn": 800,
};
const PLAYBOOK_BUDGETS: Record<string, number> = {
  "alpha-operator": 1300,
  "ci-red": 1700,
  "integrate-pr": 1700,
  performance: 2000,
};
const REFERENCE_BUDGETS: Record<string, number> = {
  "principles.md": 3200,
  "gotchas.md": 3600,
  "tools.md": 2400,
  "README.md": 1300,
};
const DEFAULT_SKILL_BUDGET = 1800;
const DEFAULT_PLAYBOOK_BUDGET = 1200;
const MAX_WAITING_FRAGMENTS = 40;
const MAX_FRAGMENT_CHARACTERS = 2000;

const overBudget = (entries: Array<[string, string, number]>) =>
  entries
    .map(([name, file, budget]) => ({ name, size: tokens(file), budget }))
    .filter(({ size, budget }) => size > budget);

describe("zstack pack size", () => {
  it("keeps every canonical skill within its budget", () => {
    const entries = zstackSkills(root).map(({ name, file }): [string, string, number] =>
      [name, join(root, file), SKILL_BUDGETS[name] ?? DEFAULT_SKILL_BUDGET]);
    expect(entries.length).toBeGreaterThan(0);
    expect(overBudget(entries)).toEqual([]);
  });

  it("keeps every playbook within its budget", () => {
    const dir = join(pack, "playbooks");
    const entries = readdirSync(dir).filter((name) => name.endsWith(".md")).map((name): [string, string, number] => {
      const id = name.slice(0, -3);
      return [id, join(dir, name), PLAYBOOK_BUDGETS[id] ?? DEFAULT_PLAYBOOK_BUDGET];
    });
    expect(entries.length).toBeGreaterThan(0);
    expect(overBudget(entries)).toEqual([]);
  });

  it("keeps the shared references within their budgets", () => {
    const entries = Object.entries(REFERENCE_BUDGETS).map(([name, budget]): [string, string, number] =>
      [name, join(pack, name), budget]);
    expect(overBudget(entries)).toEqual([]);
  });

  it("folds lesson fragments before they pile up", () => {
    const dir = join(pack, "changes");
    const fragments = readdirSync(dir).filter((name) => name.endsWith(".md") && name !== "README.md");
    expect(fragments.length).toBeLessThanOrEqual(MAX_WAITING_FRAGMENTS);
    const long = fragments.filter((name) => readFileSync(join(dir, name), "utf8").length > MAX_FRAGMENT_CHARACTERS);
    expect(long).toEqual([]);
  });
});

describe("zstack principles", () => {
  const principles = () => readFileSync(join(pack, "principles.md"), "utf8");

  it("numbers its principles consecutively", () => {
    const text = principles();
    const numbers = [...text.matchAll(/^(\d+)\. \*\*/gm)].map((match) => Number(match[1]));
    expect(numbers.length).toBeGreaterThan(0);
    expect(numbers).toEqual(numbers.map((_, index) => index + 1));
  });

  it("cites only eval cases that exist", () => {
    const known = new Set(readEvalCases(root).cases.map((entry: { id: string }) => entry.id));
    const cited = [...principles().matchAll(/Cases:([\s\S]*?)(?=\n\n|\n\d+\. |\n## |$)/g)]
      .flatMap((match) => [...match[1].matchAll(/`([a-z0-9-]+)`/g)].map((id) => id[1]));
    expect(cited.length).toBeGreaterThan(0);
    expect(cited.filter((id) => !known.has(id))).toEqual([]);
  });

  it("is referenced by the router skill", () => {
    expect(readFileSync(join(pack, "skills/zstack/SKILL.md"), "utf8")).toContain("agents/zstack/principles.md");
    expect(existsSync(join(pack, "gotchas.md"))).toBe(true);
    expect(readFileSync(join(pack, "skills/zstack-verify/SKILL.md"), "utf8")).toContain("agents/zstack/gotchas.md");
  });
});
