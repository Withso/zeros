import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { BrowserSubscriptionProvider } from "@zeros/protocol/provider-auth";

vi.mock("../../../platform/runtime", () => ({
  useNativeRuntime: () => ({ ready: true }),
}));
vi.mock("../../../state/use-cached-read", () => ({
  useCachedRead: () => ({
    data: {
      state: "expired",
      activeAccountId: "00000000-0000-4000-8000-000000000001",
      accounts: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          email: "saved@example.test",
          state: "expired",
        },
      ],
    },
    refresh: vi.fn(),
  }),
}));
vi.mock("../subscription-connection", () => ({
  subscriptionCache: {},
  readSubscription: vi.fn(),
  connectSubscription: vi.fn(),
  cancelSubscription: vi.fn(),
  changeSubscriptionAccount: vi.fn(),
  submitSubscriptionCode: vi.fn(),
}));
import { SubscriptionConnectionPanel } from "../subscription-connection-panel";

describe("saved account recovery controls", () => {
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
