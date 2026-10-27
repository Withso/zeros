import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useLayoutEffect: () => {} }));
vi.mock("../../../platform/runtime", async original => ({ ...await original<typeof import("../../../platform/runtime")>(), useNativeRuntime: () => ({ ready: true }), isNativeRuntime: () => true }));
vi.mock("../../../platform/bridge/use-bridge", () => ({ useBridgeStatus: () => "connected" }));
vi.mock("../../../state/use-cached-read", () => ({
  useCachedRead: () => ({ data: undefined, error: new Error("temporary read failure"), loading: false, refreshing: false, refresh: () => {} }),
}));
import { ProviderInformation } from "../provider-information";
import { CloudGithubSection } from "../cloud-github-section";
import { GitHubSection } from "../github-section";

it.each(["claude", "codex", "cursor"] as const)("keeps the first %s usage failure quiet while recovery is pending", provider => {
  const html = renderToStaticMarkup(createElement(ProviderInformation, {
    provider, connected: true, method: "account", status: undefined, surfaceActive: true,
  }));
  expect(html).not.toContain("Usage is unavailable right now");
  expect(html).toContain("Loading usage limits");
});
it("does not flash a GitHub integration error for an organization's first failed refresh", () => {
  const html = renderToStaticMarkup(createElement(CloudGithubSection, {
    userId: "member", organizationId: "organization", surfaceActive: true,
  }));
  expect(html).not.toContain("temporary read failure");
  expect(html).not.toContain('role="alert"');
});
it("does not flash a Local GitHub connection error on the first failed refresh", () => {
  const html = renderToStaticMarkup(createElement(GitHubSection));
  expect(html).not.toContain("Couldn’t load GitHub authentication settings");
});
