import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("../markdown", () => ({ Markdown: ({ children }: { children: string }) => children }));
import { TurnPromptHeader } from "../turn-container";
import { TooltipProvider } from "../../../shared/ui/primitives";
import { promptSenderLabel } from "../use-prompt-sender";

const me = "11111111-1111-4111-8111-111111111111", alex = "44444444-4444-4444-8444-444444444444";
const roster = [{ id: me, name: "Fixture", avatarUrl: null, role: "member" }, { id: alex, name: "Alex Rivera", avatarUrl: "https://example.test/a.png", role: "admin" }];

describe("who sent a message (team sharing phase 2, slice A)", () => {
  it("names another person's message in a shared workspace, never the viewer's own, and nothing outside sharing or before the answer", () => {
    expect(promptSenderLabel({ shared: true, sender: alex, me, roster })).toEqual({ name: "Alex Rivera", avatarUrl: "https://example.test/a.png" });
    expect(promptSenderLabel({ shared: true, sender: me, me, roster })).toBeNull();
    expect(promptSenderLabel({ shared: false, sender: alex, me, roster })).toBeNull();
    expect(promptSenderLabel({ shared: true, sender: undefined, me, roster })).toBeNull();
    // A known-unknown (legacy) attribution says nothing; someone no longer on the roster is a former member.
    expect(promptSenderLabel({ shared: true, sender: null, me, roster })).toBeNull();
    expect(promptSenderLabel({ shared: true, sender: "55555555-5555-4555-8555-555555555555", me, roster })).toEqual({ name: "Former member", avatarUrl: null });
    // The roster not loaded yet: wait rather than flash a placeholder name.
    expect(promptSenderLabel({ shared: true, sender: alex, me, roster: null })).toBeNull();
  });

  it("draws the sender line above the bubble, like a chat app, with a screen-reader 'Sent by'", () => {
    const html = renderToStaticMarkup(h(TooltipProvider, { children: h(TurnPromptHeader, { originalText: "Ship it", sender: { name: "Alex Rivera", avatarUrl: null }, children: "Ship it" }) }));
    expect(html).toContain("data-prompt-sender");
    expect(html).toMatch(/Sent by<\/span>.*Alex Rivera/s);
    expect(html.indexOf("data-prompt-sender")).toBeLessThan(html.indexOf("Ship it"));
    const plain = renderToStaticMarkup(h(TooltipProvider, { children: h(TurnPromptHeader, { originalText: "Ship it", children: "Ship it" }) }));
    expect(plain).not.toContain("data-prompt-sender");
  });
});
