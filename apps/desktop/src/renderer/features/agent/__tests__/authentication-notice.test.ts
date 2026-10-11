import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AuthenticationNotice } from "../authentication-notice";

describe("chat authentication notice", () => {
  it("keeps the organization refusal explanation with the existing Sign in action", () => {
    const message = "Your organization's Claude settings were refused for this sign-in. Sign in again or ask your administrator.";
    const html = renderToStaticMarkup(createElement(AuthenticationNotice, { name: "Claude Code", message, onSignIn: () => {} }));
    expect(html).toContain("settings were refused");
    expect(html).toContain("lucide-log-in");
    expect(html).not.toContain("send a new message");
    expect(html).not.toContain("Retry");
  });
  it("does not turn a registry credential hint into a connected claim or a retry action", () => {
    const html = renderToStaticMarkup(
      createElement(AuthenticationNotice, {
        name: "Claude Code",
        onSignIn: () => {},
        // A stale positive from the old caller must never change this notice.
        ...{ connected: true, onContinue: () => {} },
      }),
    );
    expect(html).not.toContain("is connected");
    expect(html).not.toContain("lucide-arrow-right");
    expect(html).toContain("Sign in");
    expect(html).toContain("send a new message");
  });
});
