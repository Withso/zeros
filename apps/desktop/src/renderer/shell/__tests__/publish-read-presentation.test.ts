import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useLayoutEffect: () => {} }));
vi.mock("../../platform/bridge/use-bridge", () => ({ useBridgeStatus: () => "connected" }));
vi.mock("../../state/use-cached-read", () => ({
  useCachedRead: () => ({ data: undefined, error: new Error("temporary GitHub read failure"), loading: false, refreshing: false, refresh: () => {} }),
}));
vi.mock("../../shared/ui/primitives/dialog", () => {
  const content = ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children);
  return { Dialog: content, DialogContent: content, DialogHeader: content, DialogTitle: content, DialogDescription: content, DialogBody: content, DialogFooter: content };
});
import { PublishToGithubDialog } from "../dialogs/publish-to-github";
it("does not mistake a transient owner read for a GitHub sign-in failure", () => {
  const html = renderToStaticMarkup(React.createElement(PublishToGithubDialog, { open: true, onOpenChange: () => {}, repoRoot: "/personal/repo" }));
  expect(html).not.toContain("temporary GitHub read failure");
  expect(html).not.toContain("Sign in to GitHub in Settings first");
});
