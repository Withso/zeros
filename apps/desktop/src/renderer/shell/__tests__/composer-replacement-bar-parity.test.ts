import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { Workspace } from "../../platform/git";

vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useLayoutEffect: () => {} }));
vi.mock("../../platform/bridge/use-bridge", () => ({ useBridgeStatus: () => "connected" }));
vi.mock("../../state/use-cached-read", () => ({ useCachedRead: () => ({ data: undefined, error: undefined, loading: false, refreshing: false, refresh: () => {} }) }));
vi.mock("../../state/organization-roster", () => ({ memberName: () => "Alex", useOrganizationRoster: () => null }));
import { WorkspaceHistoryBar } from "../workspace-history-bar";
import { TeamSharingReadOnlyBar } from "../team-sharing-read-only-bar";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8").trimEnd();

// The no-Creator bar reuses the archived bar's frame: the archived and read-only bars render byte for byte as before.
it("keeps the archived and read-only composer replacements unchanged", () => {
  expect(renderToStaticMarkup(createElement(WorkspaceHistoryBar, { workspace: { id: "w", path: "/organization/a", repoRoot: "/a", present: true, archivedAt: 1 } as Workspace })))
    .toBe(fixture("archived-bar.html"));
  expect(renderToStaticMarkup(createElement(TeamSharingReadOnlyBar, { folder: "/local", surfaceActive: false }))).toBe(fixture("read-only-bar.html"));
});
