import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../shared/ui/primitives/dialog", () => {
  const Part = ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children);
  return Object.fromEntries([
    "Dialog", "DialogContent", "DialogHeader", "DialogBody", "DialogTitle",
    "DialogDescription", "DialogFooter",
  ].map(name => [name, Part]));
});

import { ProviderConnectionDialog } from "../provider-connection-dialog";

describe("connected provider feedback", () => {
  function render(method: "cli" | "apiKey", connected: boolean, connectedIdentity?: string) {
    return renderToStaticMarkup(React.createElement(ProviderConnectionDialog, {
      provider: "codex", name: "Codex", open: true, onOpenChange: () => {},
      method, onMethodChange: () => {}, connected, connectedIdentity,
      busy: false, children: "Connection actions",
    }));
  }

  it("identifies an already authenticated CLI without asking it to sign in again", () => {
    const markup = render("cli", true, "cli@example.test");
    expect(markup).toContain("cli@example.test is connected");
    expect(markup).not.toContain("Connect your subscription using the inline terminal.");
  });

  it.each(["cli", "apiKey"] as const)("does not claim a disconnected %s identity is connected", method => {
    const markup = render(method, false, "previous@example.test");
    expect(markup).not.toContain("previous@example.test");
    expect(markup).not.toContain("is connected");
  });

  it.each([["cli", "CLI"], ["apiKey", "API key"]] as const)(
    "uses an honest %s fallback when the provider does not disclose an identity",
    (method, label) => {
      expect(render(method, true)).toContain(`${label} is connected`);
      expect(render(method, true, "  ")).toContain(`${label} is connected`);
    },
  );

  it("identifies a named cloud API connection from its own metadata", () => {
    expect(render("apiKey", true, "cloud@example.test")).toContain("cloud@example.test is connected");
  });
});
