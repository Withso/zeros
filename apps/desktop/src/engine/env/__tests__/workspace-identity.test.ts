import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { workspaceScriptIdentity } from "../workspace-identity";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it("binds a canonical workspace to its root even in a terminal subdirectory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-identity-")); roots.push(root);
  const child = path.join(root, "src"); fs.mkdirSync(child);
  const workspace = { path: root, canonicalId: "11111111-1111-4111-8111-111111111111" };
  expect(workspaceScriptIdentity(child, workspace)).toEqual({
    ZEROS_WORKSPACE_CANONICAL_ID: workspace.canonicalId, ZEROS_WORKSPACE_ROOT: fs.realpathSync(root),
  });
  expect(workspaceScriptIdentity(os.tmpdir(), workspace)).toEqual({});
  expect(workspaceScriptIdentity(root, { ...workspace, canonicalId: "local-main" })).toEqual({});
  expect(workspaceScriptIdentity(root)).toEqual({});
  fs.symlinkSync(os.tmpdir(), path.join(root, "outside"));
  expect(workspaceScriptIdentity(path.join(root, "outside"), workspace)).toEqual({});
});
