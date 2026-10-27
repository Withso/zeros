import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { config } from "../../__tests__/worker-fixtures";
import { WorkspaceScope } from "../scope";
import { listWorkspaceSkills } from "../skills";

const home = vi.hoisted(() => ({ path: "" }));
vi.mock("node:os", async importOriginal => ({ ...await importOriginal<typeof import("node:os")>(), homedir: () => home.path }));
let directory: string, root: string, scope: WorkspaceScope;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "worker-skills-"));
  root = join(directory, "repo"); home.path = join(directory, "home");
  await mkdir(root); await mkdir(home.path);
  scope = new WorkspaceScope({ ...config.workspace, checkoutPath: root });
  vi.stubEnv("CODEX_HOME", "");
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });
async function skill(base: string, id: string, content = `---\nname: ${id}\n---\nBody\n`) {
  const dir = join(base, id); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), content);
  return join(dir, "SKILL.md");
}

it.each(["claude", "codex", "cursor"])("discovers %s VM sources with full content and project precedence", async agent => {
  await skill(join(home.path, `.${agent}`, "skills"), "review", "---\nname: review\n---\nHome");
  const content = "---\r\nname: 'review'\r\ndescription: \"Review files\"\r\n---\r\nProject\r\n";
  const path = await skill(join(root, `.${agent}`, "skills"), "review", content);
  await skill(join(root, ".agents", "skills"), "shared");
  await skill(join(root, "skills"), "legacy");
  const result = await listWorkspaceSkills(scope, agent);
  expect(result.skills.map(s => s.name)).toEqual(["legacy", "review", "shared"]);
  expect(result.skills.find(s => s.name === "review")).toMatchObject({ path, content, body: "Project\r\n", description: "Review files" });
});

it("does not follow repository roots/files into another owner or Git metadata", async () => {
  const outside = await skill(join(home.path, "private"), "private");
  await mkdir(join(root, ".claude"));
  await symlink(join(home.path, "private"), join(root, ".claude", "skills"));
  await mkdir(join(root, "skills", "link"), { recursive: true });
  await symlink(outside, join(root, "skills", "link", "SKILL.md"));
  const metadata = await skill(join(root, ".git"), "internal");
  await mkdir(join(root, "skills", "metadata"));
  await symlink(metadata, join(root, "skills", "metadata", "SKILL.md"));
  expect(await listWorkspaceSkills(scope, "claude")).toEqual({ skills: [] });
});

it("narrows a home source to its library instead of exposing adjacent provider credentials", async () => {
  const provider = join(home.path, ".claude");
  await mkdir(join(provider, "skills", "link"), { recursive: true });
  await writeFile(join(provider, "private.md"), "fixture private data");
  await symlink(join(provider, "private.md"), join(provider, "skills", "link", "SKILL.md"));
  expect(await listWorkspaceSkills(scope, "claude")).toEqual({ skills: [] });
});

it("bounds source bytes, count and aggregate payload and tolerates invalid UTF-8", async () => {
  const base = join(root, "skills");
  await skill(base, "huge", "x".repeat(256 * 1024 + 1));
  await skill(base, "invalid");
  await writeFile(join(base, "invalid", "SKILL.md"), Buffer.from([0xff]));
  for (let i = 0; i < 20; i++) await skill(base, `large-${i}`, "x".repeat(120_000));
  const out = await listWorkspaceSkills(scope, "codex");
  expect(out.skills.some(s => s.id === "huge" || s.id === "invalid")).toBe(false);
  expect(out.skills.length).toBeGreaterThan(0);
  expect(out.skills.length).toBeLessThanOrEqual(256);
  expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThanOrEqual(2 * 1024 * 1024);
});

it("validates providers and returns empty for a missing catalog", async () => {
  await expect(listWorkspaceSkills(scope, "foreign")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  expect(await listWorkspaceSkills(scope, null)).toEqual({ skills: [] });
  expect(await listWorkspaceSkills(scope, "claude")).toEqual({ skills: [] });
});

it("discovers bundled system skills in the VM's custom Codex home", async () => {
  const provider = join(home.path, "codex-home");
  vi.stubEnv("CODEX_HOME", provider);
  await skill(join(provider, "skills", ".system"), "review");
  expect((await listWorkspaceSkills(scope, "codex")).skills.map(s => s.id)).toEqual(["review"]);
});
