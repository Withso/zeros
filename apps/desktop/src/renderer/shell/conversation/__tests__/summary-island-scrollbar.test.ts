import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const read = (path: string) =>
  readFileSync(resolve(process.cwd(), "apps/desktop/src/renderer", path), "utf8");

/** A component's body: `function NAME(` up to the next top-level declaration. */
function component(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  const rest = src.slice(start + 1);
  const next = rest.search(/\n(?:export |function |interface |const |\/\*\*)/);
  return next < 0 ? src.slice(start) : src.slice(start, start + 1 + next);
}

// 2026-11-09: with the Summary docked as an island (side column collapsed),
// the chat's scrollbar sits at the pane's right edge, beside the island. The
// chat runs under the island and keeps its transcript, composer and fades
// clear of it; terminals and the empty pane stay beside it as before.
describe("the docked summary island and the chat's scrollbar", () => {
  it("floats the island over the chat's top-right corner and publishes its width", () => {
    const summary = read("shell/conversation/conversation-summary.tsx");
    const island = component(summary, "ConversationSummaryIsland");
    expect(island).toContain(
      '"conversation-summary-island bg-bg1-bright absolute top-3 right-4 z-2 max-h-[calc(100%-24px)] w-72 overflow-y-auto overscroll-contain p-3"',
    );
    expect(island).not.toMatch(/\b(my-3|mr-4|self-start|shrink-0)\b/);
    // w-72 plus the island's right-4 offset.
    expect(summary).toContain(
      'export const CHAT_ASIDE_INSET_HOST_CLS =\n  "has-[[data-summary-island]]:[--chat-aside-inset:calc(var(--spacing)*76)]";',
    );
  });

  it("lets the pane body carry the inset to every layer portaled into it", () => {
    const pane = component(read("shell/conversation/pane-layout.tsx"), "ChatPane");
    expect(pane).toContain('cn("relative flex min-h-0 min-w-0 flex-1", CHAT_ASIDE_INSET_HOST_CLS)');
    expect(pane).toContain(
      '"absolute inset-y-0 left-0 right-[var(--chat-aside-inset,0px)] flex min-h-0 flex-col"',
    );
    expect(read("shell/conversation/terminal-deck.tsx")).toContain(
      '"bg-bg1 absolute inset-y-0 left-0 right-[var(--chat-aside-inset,0px)] flex min-h-0 min-w-0 flex-col p-4"',
    );
  });

  it("runs the transcript to the pane edge and keeps its content, composer and fades clear", () => {
    const chat = read("features/agent/agent-chat.tsx");
    // The scroller's padding keeps the content clear of the island whether or
    // not it overflows; its scrollbar stays at the scroller's own edge, which
    // is the pane's. Unset, the inset leaves padding at 0.
    expect(chat).toContain(
      'overflow-x-hidden overflow-y-auto bg-transparent pr-(--chat-aside-inset)"',
    );
    expect(chat).toContain('<div className="relative shrink-0 pr-(--chat-aside-inset)">');
    // The top fade stops at the scrollbar, or at the island when it is docked.
    expect(chat).toContain(
      '"pointer-events-none absolute top-0 left-0 right-[max(var(--scrollbar-size),var(--chat-aside-inset,0px))] z-1 h-8 bg-gradient-to-b from-(--pane-bg) to-transparent"',
    );
    expect(read("features/agent/jump-pills.tsx")).toContain(
      "left-[calc((100%-var(--chat-aside-inset,0px))/2)]",
    );
  });

  it("keeps the chat pane's dead-end panels clear of the island", () => {
    const inset = "pr-[calc(var(--spacing)*6+var(--chat-aside-inset,0px))]";
    expect(read("shell/agent-removed-panel.tsx")).toContain(inset);
    expect(read("shell/no-folder-panel.tsx")).toContain(inset);
  });

  it("never fades the scrollbar above the composer either", () => {
    const fade = read("shared/ui/composer-surface.ts");
    expect(fade).toContain(
      '"pointer-events-none absolute bottom-full left-0 right-(--scrollbar-size) h-8 bg-gradient-to-t from-(--pane-bg) to-transparent"',
    );
    expect(fade).not.toContain("inset-x-0");
  });
});
