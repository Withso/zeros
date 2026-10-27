import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { Project } from "../../../state/projects-store";

vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useLayoutEffect: () => {} }));
vi.mock("../../../platform/bridge/use-bridge", () => ({ useBridgeStatus: () => "connected" }));
vi.mock("../../../state/use-cached-read", () => ({
  useCachedRead: () => ({ data: undefined, error: new Error("temporary source read failure"), loading: false, refreshing: false, refresh: () => {} }),
}));
vi.mock("../../../shared/ui/primitives/popover", () => {
  const content = ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children);
  return { Popover: content, PopoverContent: content, PopoverTrigger: content };
});
import { CreateFromSource } from "../create-from-source";
it.each(["/personal/repo", "/organization/repo"])("does not flash a source error when opening Create for %s", repoRoot => {
  const project = { id: repoRoot, repoRoot, repoSlug: "repo", name: "Repository", originUrl: null } as Project;
  const html = renderToStaticMarkup(React.createElement(CreateFromSource, { project, value: null, onChange: () => {} }));
  expect(html).not.toContain("temporary source read failure");
});
