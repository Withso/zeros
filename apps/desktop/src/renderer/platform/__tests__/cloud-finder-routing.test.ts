import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { revealInFinder } from "../app";
import { openPathWithApp } from "../open-apps";
import { cloudWorkspaceKey } from "../bridge/cloud-workspace-key";
const folder = cloudWorkspaceKey({
  organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
});
afterEach(() => vi.unstubAllGlobals());
it("cloud paths never reach a native Finder or other local app handler", async () => {
  const invoke = vi.fn(async () => undefined);
  vi.stubGlobal("window", { __ZEROS_NATIVE__: { invoke } });
  await revealInFinder(`${folder}/src/file.ts`);
  for (const app of ["finder", "terminal", "editor"])
    await openPathWithApp(app, folder);
  expect(invoke).not.toHaveBeenCalled();
  await revealInFinder("/local/src/file.ts");
  await openPathWithApp("finder", "/local");
  expect(invoke.mock.calls).toEqual([
    ["reveal_in_finder", { path: "/local/src/file.ts" }],
    ["reveal_in_finder", { path: "/local" }],
  ]);
});
it("Files and the shared Open in menus gate local app actions by placement", () => {
  const tree = readFileSync(
    new URL(
      "../../shell/workbench/tabs/workspace-file-tree.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  const menus = readFileSync(
    new URL(
      "../../shell/conversation/conversation-header.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  expect(tree).toMatch(/onReveal=\{[\s\S]{0,120}canOpenPathLocally\(cwd\)/);
  expect(menus).toContain("disabled={!menu.canOpenLocally}");
});
