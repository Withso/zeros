import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { openSqlite } from "../../apps/desktop/src/engine/db/sqlite";
import { readDesignFrame, readDesignWorkspaceSnapshot } from "../../apps/desktop/src/engine/design/document";

const run = (args: string[]) => promisify(execFile)(process.execPath,
  ["--import", "tsx", "scripts/design-owner-compatibility-fixture.ts", ...args], { timeout: 30_000 });

it("prepares distinct authored owners in a fresh migrated database without staging files", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "zeros-owner-fixture-"));
  try {
    const root = path.join(parent, "fixture");
    await run(["--output", root]);
    const fixture = JSON.parse(await fs.readFile(path.join(root, "fixture.json"), "utf8"));
    expect(fixture.syntheticOrganizationId).toBe(true);
    const db = openSqlite(path.join(root, "profile", "zeros.db"), { readonly: true, fileMustExist: true });
    try {
      const rows = db.prepare("SELECT id, organization_id, placement, path, view_mode FROM workspaces ORDER BY organization_id").all();
      expect(rows).toEqual([
        { id: fixture.workspaces[0].id, organization_id: null, placement: "local", path: fixture.workspaces[0].path, view_mode: "design" },
        { id: fixture.workspaces[1].id, organization_id: fixture.organizationId, placement: "local", path: fixture.workspaces[1].path, view_mode: "design" },
      ]);
      expect(db.prepare("SELECT count(*) AS n FROM repos").get()).toEqual({ n: 2 });
    } finally { db.close(); }
    for (const workspace of fixture.workspaces) {
      const snapshot = await readDesignWorkspaceSnapshot(workspace.path);
      expect(snapshot.frames.map(frame => frame.kind)).toEqual(["frame", "text"]);
      const frame = await readDesignFrame(workspace.path, workspace.frames[0]);
      expect(frame.srcDoc).toContain(workspace.marker);
      const staged = await promisify(execFile)("git", ["-C", workspace.path, "diff", "--cached", "--name-only"]);
      expect(staged.stdout).toBe("");
    }
    expect(await fs.readdir(path.join(root, "profile"))).not.toContain("secrets.json");
  } finally { await fs.rm(parent, { recursive: true, force: true }); }
}, 35_000);

it("refuses existing destinations and symlinks without touching their contents", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "zeros-owner-existing-"));
  try {
    const existing = path.join(parent, "existing");
    await fs.mkdir(existing); await fs.writeFile(path.join(existing, "keep"), "unchanged");
    const linked = path.join(parent, "link"); await fs.symlink(existing, linked, "dir");
    for (const output of [existing, linked]) await expect(run(["--output", output])).rejects.toThrow();
    expect(await fs.readdir(existing)).toEqual(["keep"]);
    expect(await fs.readFile(path.join(existing, "keep"), "utf8")).toBe("unchanged");
  } finally { await fs.rm(parent, { recursive: true, force: true }); }
}, 35_000);

it("rejects an invalid owner before creating fixture files", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "zeros-owner-invalid-"));
  try {
    const output = path.join(parent, "fixture");
    await expect(run(["--output", output, "--organization-id", "invalid-owner"])).rejects.toThrow(/valid organization UUID/);
    expect(await fs.readdir(parent)).toEqual([]);
  } finally { await fs.rm(parent, { recursive: true, force: true }); }
});
