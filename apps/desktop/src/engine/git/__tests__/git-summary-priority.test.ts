import { afterEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../types";

vi.mock("../worktree", () => ({ resolveRepoForGitOp: async (id: string): Promise<Workspace> => ({
  id, path: `/fixture/summary-priority/${id}`, repoRoot: `/fixture/summary-priority/${id}`, repoSlug: id,
  branch: "feature", baseBranch: "main", createdAt: 1, archivedAt: null, stashRef: null, status: "in-progress",
  prNumber: null, prState: null, prUrl: null, agentId: null, lastActiveAt: null, placement: "local", organizationId: null,
}) }));
vi.mock("../../settings/repo-git", () => ({ resolveRepoGit: () => ({ remote: "origin" }) }));
import { changeLineCounts, status } from "../diff";

afterEach(() => { vi.unstubAllGlobals(); });

describe("Local summary foreground priority", () => {
  it.each(["sixth", "queued"])("starts foreground status for a %s workspace immediately without duplicating status", async (target) => {
    const finish: Array<() => void> = [];
    const statuses: string[] = [];
    let ready!: () => void;
    const held = new Promise<void>((resolve) => { ready = resolve; });
    let released = false;
    vi.stubGlobal("Bun", { spawn: (command: string[], options: { cwd: string }) => {
      const isStatus = command.includes("status");
      const id = options.cwd.split("/").at(-1)!;
      if (isStatus) statuses.push(id);
      const block = isStatus && !released && Number(id.split("-").at(-1)) < 4;
      return {
        stdout: new Response(isStatus ? `# branch.oid ${"2".repeat(40)}\0# branch.head feature\0` : command.includes("diff") ? "" : "1".repeat(40)).body,
        stderr: new Response("").body, signalCode: null, killed: false, kill: vi.fn(),
        exited: block ? new Promise<number>((resolve) => {
          finish.push(() => resolve(0));
          if (finish.length === 4) ready();
        }) : Promise.resolve(0),
      };
    } });
    const background = Promise.all(Array.from({ length: 5 }, (_, index) => changeLineCounts(`background-${index}`)));
    await held;
    const foregroundId = target === "queued" ? "background-4" : "foreground-sixth";
    const foreground = status(foregroundId, { includeTracking: false });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(statuses.filter((id) => id === foregroundId)).toHaveLength(1);
      expect(statuses.filter((id) => id.startsWith("background-") && id !== foregroundId)).toHaveLength(4);
    } finally {
      released = true;
      finish.forEach((resolve) => resolve());
      await Promise.all([background, foreground]);
    }
    expect(statuses.filter((id) => id === foregroundId)).toHaveLength(1);
  });
});
