import { beforeEach, expect, it, vi } from "vitest";
import { listSkills, type Skill } from "../app";
import { fetchSkillCatalog, loadSkillCatalog, skillCatalog, skillCatalogKey } from "../skill-catalog";
import { readSkillSource } from "../skill-source";

vi.mock("../app", () => ({ listSkills: vi.fn() }));
const list = vi.mocked(listSkills);
const skill: Skill = { id: "review", name: "review", description: "Review", icon: "FileText", body: "Body", path: "/library/review/SKILL.md", content: "---\nname: review\n---\nBody" };
const source = { agentId: "claude" as const, path: skill.path, name: skill.name };
const cloud = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
beforeEach(() => { skillCatalog.clear(); list.mockReset(); });

it.each(["/personal/repo", "/organization/repo", cloud])("shares discovery and source reads in %s without sharing another owner or provider", async cwd => {
  let resolve!: (skills: Skill[]) => void;
  const pending = new Promise<Skill[]>(done => { resolve = done; });
  list.mockReturnValueOnce(pending);
  const first = loadSkillCatalog(cwd, "claude");
  const second = loadSkillCatalog(cwd, "claude");
  const read = readSkillSource(cwd, source);
  resolve([skill]);
  expect(await first).toBe(await second);
  expect(await read).toMatchObject({ content: skill.content, path: skill.path });
  expect(list).toHaveBeenCalledTimes(1);
  list.mockResolvedValue([]);
  await loadSkillCatalog(`${cwd}/other`, "claude");
  await loadSkillCatalog(cwd, "codex");
  expect(list).toHaveBeenCalledTimes(3);
  expect(skillCatalog.getSnapshot(skillCatalogKey(cwd, "claude")).data).toEqual([skill]);
  expect(skillCatalog.getSnapshot(skillCatalogKey(cwd, "codex")).data).toEqual([]);
});

it("retains exact-key data after failed refresh and rejects superseded responses", async () => {
  const key = skillCatalogKey("/repo", "claude");
  list.mockResolvedValue([skill]);
  const confirmed = await loadSkillCatalog("/repo", "claude");
  list.mockRejectedValueOnce(new Error("offline"));
  await expect(skillCatalog.load(key, () => fetchSkillCatalog(key), { force: true })).rejects.toThrow("offline");
  expect(skillCatalog.getSnapshot(key).data).toBe(confirmed);
  let resolve!: (skills: Skill[]) => void;
  const pending = new Promise<Skill[]>(done => { resolve = done; });
  list.mockReturnValueOnce(pending);
  const stale = skillCatalog.load(key, () => fetchSkillCatalog(key), { force: true });
  skillCatalog.invalidate(key);
  resolve([]);
  await stale;
  expect(skillCatalog.getSnapshot(key).data).toBe(confirmed);
});

it("keeps stable catalog references and bounds inactive owners", async () => {
  list.mockImplementation(async () => [{ ...skill }]);
  const key = skillCatalogKey("/repo", "claude");
  const first = await loadSkillCatalog("/repo", "claude");
  await skillCatalog.load(key, () => fetchSkillCatalog(key), { force: true });
  expect(skillCatalog.getSnapshot(key).data).toBe(first);
  for (let i = 0; i < 40; i++) await loadSkillCatalog(`/repo-${i}`, "claude");
  expect([...skillCatalog.keys()].length).toBeLessThanOrEqual(32);
});

it("requires the exact discovered source, including full source on older runtimes", async () => {
  list.mockResolvedValue([{ ...skill, content: undefined }]);
  await expect(readSkillSource("/repo", source)).rejects.toThrow("no longer available");
  await expect(readSkillSource("/repo", { ...source, path: "/credentials" })).rejects.toThrow("no longer available");
  expect(list).toHaveBeenCalledExactlyOnceWith("/repo", "claude");
});
