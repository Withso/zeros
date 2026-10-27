import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { Workspace } from "../../../platform/git";

const f = vi.hoisted(() => ({ effects: [] as Array<() => unknown>, status: vi.fn(), counts: vi.fn() }));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(), useLayoutEffect: () => {},
  useEffect: (effect: () => unknown) => { f.effects.push(effect); },
}));
vi.mock("../../../platform/bridge/use-bridge", () => ({ useBridgeStatus: () => "connecting" }));
vi.mock("../../../state/use-document-active", () => ({ useDocumentActive: (active: boolean) => active }));
vi.mock("../../use-git-refresh-key", () => ({ useGitRefreshKey: () => 1 }));
vi.mock("../../git-status-reads", () => ({ statusForGeneration: f.status, changeCountsForGeneration: f.counts }));
import { useSummaryGitStatus } from "../summary-git-status-data";
it("waits for the Local engine before reading Summary Git", async () => {
  function Probe() { useSummaryGitStatus({ id: "startup", path: "/local", repoRoot: "/local", prNumber: null } as Workspace, true); return null; }
  renderToStaticMarkup(createElement(Probe));
  for (const effect of f.effects) effect();
  await Promise.resolve(); await Promise.resolve();
  expect(f.status).not.toHaveBeenCalled();
  expect(f.counts).not.toHaveBeenCalled();
});
