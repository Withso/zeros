import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ localStatus: "connected", status: "connected", error: new Error("transient tool read") as Error | null }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useLayoutEffect: () => {} }));
vi.mock("../../../platform/bridge/use-bridge", () => ({
  useBridge: () => ({ status: state.localStatus }),
  useBridgeStatus: () => state.status,
}));
vi.mock("../../../state/use-cached-read", () => ({
  useCachedRead: () => ({ data: undefined, error: state.error, loading: false, refreshing: false, refresh: () => {} }),
}));
vi.mock("../session-tools-cache", async original => {
  const actual = await original<typeof import("../session-tools-cache")>();
  const resource = { ...actual.createSessionToolsResource(async () => ({})), identity: () => "session", subscribe: () => () => {} };
  return { ...actual, sessionToolsResource: () => resource };
});
vi.mock("../../../shared/ui/primitives", async original => {
  const actual = await original<typeof import("../../../shared/ui/primitives")>();
  const content = ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children);
  return { ...actual, Popover: content, PopoverContent: content, PopoverTrigger: content, Tooltip: content };
});
import { ComposerTools } from "../composer-tools";

afterEach(() => { state.localStatus = state.status = "connected"; state.error = new Error("transient tool read"); });
const render = (workspaceId: string) => renderToStaticMarkup(React.createElement(ComposerTools, {
  agentId: "codex", sessionId: "session", workspaceId, concealed: false,
}));
it.each(["/personal/a", "/organization/a"])("does not flash a tools error for the first read in %s", folder => {
  expect(render(folder)).not.toContain("Could not load tools");
});
it("uses the cloud workspace connection when Local is still connecting", () => {
  state.localStatus = "connecting"; state.error = null;
  expect(render("cloud://org/workspace")).not.toContain("Connect to the workspace");
});
