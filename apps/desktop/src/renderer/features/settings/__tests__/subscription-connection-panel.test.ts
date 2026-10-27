import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserSubscriptionProvider } from "@zeros/protocol/provider-auth";

const fixture = vi.hoisted(() => ({ state: "expired", email: undefined as string | undefined, readError: null as Error | null }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useLayoutEffect: () => {} }));

vi.mock("../../../platform/runtime", () => ({
  useNativeRuntime: () => ({ ready: true }),
}));
vi.mock("../../../state/use-cached-read", () => ({
  useCachedRead: () => ({
    error: fixture.readError,
    data: {
      state: fixture.state,
      email: fixture.email,
      plan: "Pro",
      activeAccountId: "00000000-0000-4000-8000-000000000001",
      accounts: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          email: "saved@example.test",
          state: fixture.state,
        },
      ],
    },
    refresh: vi.fn(),
  }),
}));
vi.mock("../subscription-connection", () => ({
  isSubscriptionProvider: (provider: string) => ["claude", "codex", "cursor"].includes(provider),
  subscriptionCache: {},
  readSubscription: vi.fn(),
  connectSubscription: vi.fn(),
  cancelSubscription: vi.fn(),
  changeSubscriptionAccount: vi.fn(),
  submitSubscriptionCode: vi.fn(),
}));
import { SubscriptionConnectionPanel } from "../subscription-connection-panel";

beforeEach(() => {
  fixture.state = "expired";
  fixture.email = undefined;
  fixture.readError = null;
});

describe("saved account recovery controls", () => {
  it("keeps a saved account visible without a transient native status error", () => {
    fixture.state = "connected";
    fixture.email = "saved@example.test";
    fixture.readError = new Error("temporary status failure");
    const html = renderToStaticMarkup(React.createElement(SubscriptionConnectionPanel, { provider: "claude", surfaceActive: true }));
    expect(html).toContain("saved@example.test is connected");
    expect(html).not.toContain("temporary status failure");
    expect(html).not.toContain("Could not check the connection");
  });
  it.each(["claude", "codex", "cursor"] as BrowserSubscriptionProvider[])(
    "shows one simple connected-account sentence for %s",
    provider => {
      fixture.state = "connected";
      fixture.email = "saved@example.test";
      const markup = renderToStaticMarkup(React.createElement(SubscriptionConnectionPanel, {
        provider, surfaceActive: true,
      }));
      expect(markup).toContain('role="status">saved@example.test is connected</p>');
      expect(markup).not.toContain("Connected as");
    },
  );
  it.each(["claude", "codex", "cursor"] as BrowserSubscriptionProvider[])(
    "offers a working sign-in action for an expired %s account",
    (provider) => {
      const markup = renderToStaticMarkup(
        React.createElement(SubscriptionConnectionPanel, {
          provider,
          surfaceActive: true,
        }),
      );
      expect(markup).toContain('aria-label="Sign in to saved@example.test"');
      expect(markup).toContain("Sign in required");
    },
  );
});
