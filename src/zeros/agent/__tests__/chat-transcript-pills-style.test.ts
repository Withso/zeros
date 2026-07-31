// Source-string pins for the transcript pill row, in the same idiom as
// chat-provenance-style.test.ts. Every assertion here is a decision someone
// made deliberately and would otherwise "tidy up" back to a default — the
// renderer has no DOM test harness (vitest runs in the node environment), so
// pinning the source is how these are held.
//
// The decisions, all settled 2026-07-30:
//   D1 concise always, full on right-click (no mode switch in the row)
//   D3 added state = a Button VARIANT, not a className override
//   D5 no open/closed distinction anywhere
//   D6 no budget chrome of any kind
//   D8 hover shows the transcript, with no footer
//   D9 the pill is live, the chip is fixed — no staleness UI

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

/** Source with comments stripped.
 *
 *  These files explain their decisions at length, and several of those
 *  explanations name the very thing the code must not do ("no staleness
 *  badge", "up to 4 MB of raw payload"). A negative assertion against the raw
 *  text would fail on the prose that documents the rule — so the rule is
 *  checked against what actually renders. */
function code(relativePath: string): string {
  return (
    source(relativePath)
      // Block comments FIRST, each one to its own nearest terminator. This
      // covers `/** doc */`, `/* inline */` and the body of a JSX `{/* … */}`
      // in one pass — matching the JSX form on its own is where a naive
      // `\{\s*\/\*[\s\S]*?\*\/\s*\}` goes wrong: it happily opens on an
      // interface's `{` and swallows 3,000 characters of real code.
      .replace(/\/\*[\s\S]*?\*\//g, "")
      // …which leaves `{}` where a JSX comment was. Harmless, but drop it so
      // a brace-counting assertion is never confused by one.
      .replace(/\{\s*\}/g, "")
      .replace(/^\s*\/\/.*$/gm, "")
  );
}

const pills = () => code("src/zeros/agent/chat-transcript-pills.tsx");
const preview = () => code("src/zeros/agent/chat-transcript-preview.tsx");
const button = () => code("src/zeros/ui/primitives/button.tsx");

/** The body of the pill's right-click menu, so ordering assertions aren't
 *  confused by the import block at the top of the file. */
function contextMenuBody(): string {
  const src = pills();
  const start = src.indexOf("<ContextMenuContent>");
  const end = src.indexOf("</ContextMenuContent>");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe("D1 — concise always, full only on right-click", () => {
  it("a plain click attaches CONCISE", () => {
    expect(pills()).toContain('onAttach(summary, "concise")');
  });

  it("offers full only from the context menu", () => {
    const src = pills();
    expect(src).toContain('onAttach(summary, "full")');
    // …and exactly once. A second entry point for full is a mode switch by
    // another name, which is the thing D1 removed.
    expect(src.match(/onAttach\(summary, "full"\)/g)).toHaveLength(1);
  });

  it("has no segmented mode control in the row", () => {
    const src = pills();
    expect(src).not.toMatch(/Concise<\/|>Concise</);
    expect(src).not.toContain("ToggleGroup");
    expect(src).not.toContain("Tabs");
  });

  it("labels the row without a colon or a trailing control", () => {
    // The reference's "Add chat transcripts:" reads like a form field; the
    // pills are self-evidently the objects of the verb.
    expect(pills()).toContain("<span>Add chat transcripts</span>");
    expect(pills()).not.toContain("Add chat transcripts:");
  });

  it("leads the row with a conversation glyph, not a paperclip", () => {
    // 2026-07-30 founder direction. The row sits with the folder/branch/
    // terminal provenance rows, whose icons all name WHAT the row is about;
    // a paperclip named the mechanism instead. The paperclip survives in the
    // right-click menu, where "Attach full transcript" IS the mechanism.
    const src = pills();
    expect(src).toContain('<MessageCircleMore className="size-3.5"');
    expect(src).not.toContain('<Paperclip className="size-3.5"');
  });

  it("uses the SAME two words as the chat tab's own transcript menu", () => {
    // A second vocabulary for one existing pair of modes is how two mental
    // models start. The tab menu says "Copy concise/full transcript".
    const src = pills();
    expect(src).toContain("Attach concise transcript");
    expect(src).toContain("Attach full transcript");
    for (const wrong of ["Attach brief", "Attach detailed", "Attach short"]) {
      expect(src).not.toContain(wrong);
    }
  });

  it("puts 'Open this chat' last, under a separator", () => {
    // It unmounts this whole row by switching tabs, so it must not sit
    // adjacent to the two attach verbs where a mis-aimed click lands on it.
    const menu = contextMenuBody();
    const concise = menu.indexOf("Attach concise transcript");
    const full = menu.indexOf("Attach full transcript");
    const sep = menu.indexOf("ContextMenuSeparator");
    const open = menu.indexOf("Open this chat");
    expect(concise).toBeGreaterThan(-1);
    expect(full).toBeGreaterThan(concise);
    expect(sep).toBeGreaterThan(full);
    expect(open).toBeGreaterThan(sep);
  });
});

describe("D1 — the menu is reachable without a pointer", () => {
  // D1 puts the full transcript behind right-click, which makes the context
  // menu the ONLY route to it — so a menu the keyboard cannot open silently
  // demotes "full" to a mouse-only feature. Radix's trigger listens for
  // `contextmenu` and nothing else, and macOS has no context-menu key.
  it("opens the menu on ⌥-Enter", () => {
    const src = pills();
    expect(src).toContain("e.altKey");
    expect(src).toContain('e.key !== "Enter"');
    expect(src).toContain("onKeyDown={openMenuFromKeyboard}");
  });

  it("synthesises the event Radix already listens for", () => {
    // Not a controlled `open` prop: two ways to open the menu is how the
    // pointer path and the keyboard path drift apart.
    const src = pills();
    expect(src).toContain('new MouseEvent("contextmenu"');
    expect(src).toContain("bubbles: true");
    expect(src).not.toMatch(/<ContextMenu\s+open=/);
  });

  it("anchors the panel on the pill, not the window corner", () => {
    // Radix reads the open point straight off the event's client coords, so
    // dispatching without them pins the menu at 0,0.
    const src = pills();
    expect(src).toContain("getBoundingClientRect()");
    expect(src).toMatch(/clientX:\s*Math\.round/);
    expect(src).toMatch(/clientY:\s*Math\.round/);
  });

  it("does not swallow a plain Enter, which still attaches concise", () => {
    // The handler must bail before preventDefault on anything but ⌥-Enter,
    // or it eats the button's own activation.
    const src = pills();
    const body =
      src.split("const openMenuFromKeyboard")[1]?.split("const pill")[0] ?? "";
    expect(body).toBeTruthy();
    expect(body.indexOf("return;")).toBeLessThan(
      body.indexOf("preventDefault"),
    );
  });
});

describe("D3 — the added state is a Button variant, not an override", () => {
  it("selects a variant rather than restyling with className", () => {
    expect(pills()).toContain(
      'variant={attached ? "secondary-on" : "secondary"}',
    );
  });

  it("the variant exists and lifts BOTH fill and border", () => {
    // Three independent signals (fill, border, the brand glyph) so it survives
    // the light theme and does not depend on colour alone.
    const src = button();
    expect(src).toContain('"secondary-on":');
    expect(src).toContain("border-border4");
    expect(src).toContain("bg-bg2-hover");
  });

  it("does not overload the focus ring token for the pressed state", () => {
    // highlighted-bright IS the focus signal. Using it here would make a
    // focused-but-off pill and an on-but-unfocused pill look identical.
    const variant = button().split('"secondary-on":')[1]?.split("},")[0] ?? "";
    expect(variant).not.toContain("highlighted-bright");
  });

  it("never fills a pill with the Primary surface", () => {
    // N white fills is N main CTAs stacked above the view's real one.
    expect(pills()).not.toContain("primary-button-bg");
    expect(pills()).not.toContain('variant="default"');
  });

  it("carries the state for assistive tech, not just visually", () => {
    expect(pills()).toContain("aria-pressed={attached}");
  });
});

describe("D5 — open vs closed is not a distinction this feature makes", () => {
  it("never groups, badges or sorts on archived", () => {
    const src = pills();
    for (const banned of [
      "archived",
      "Closed",
      "OPEN TABS",
      "CommandSeparator",
    ]) {
      expect(src).not.toContain(banned);
    }
  });

  it("filtering narrows without re-sorting", () => {
    // cmdk's built-in filter sorts by score, which would silently re-order a
    // list whose order is itself the information.
    expect(pills()).toContain("shouldFilter={false}");
  });
});

describe("D6 — no budget chrome anywhere", () => {
  it("shows a message count and no size, budget, bar or token figure", () => {
    for (const src of [pills(), preview()]) {
      expect(src).not.toMatch(/\bKB\b|\bMB\b/);
      expect(src).not.toContain("maxTextBytesForModel");
      expect(src).not.toContain("budget");
      expect(src).not.toContain("Progress");
    }
    expect(pills()).toContain("{summary.userMessageCount}");
  });

  it("has no yellow / over-budget pill state", () => {
    expect(pills()).not.toContain("yellow");
  });
});

describe("D8 — hover shows the transcript, and says nothing else", () => {
  it("opens a HoverCard, not a Tooltip, on the pill", () => {
    expect(pills()).toContain("<HoverCard openDelay={400} closeDelay={120}>");
  });

  it("opens upward, away from the composer the user came to type into", () => {
    expect(pills()).toContain('side="top"');
  });

  it("nests the two asChild triggers directly around the button", () => {
    // Both Radix roots render NO DOM. Wrapping <HoverCard> in
    // <ContextMenuTrigger asChild> looks equivalent and is not: the trigger
    // hands its ref and onContextMenu to a context provider, which drops
    // them — right-click silently does nothing, and that is the ONLY route to
    // the full transcript. The triggers must sit on the same element.
    const src = pills();
    expect(src).toMatch(
      /<HoverCardTrigger asChild>\s*<ContextMenuTrigger asChild>\{pill\}<\/ContextMenuTrigger>\s*<\/HoverCardTrigger>/,
    );
    expect(src).not.toMatch(/<ContextMenuTrigger asChild>\s*<HoverCard\b/);
  });

  it("the panel is a header and a scroll region — no footer, no teach line", () => {
    const src = preview();
    expect(src).not.toContain("Click to attach");
    expect(src).not.toContain("Right-click");
    // No footer element at all: the panel is exactly two regions.
    expect(src).not.toMatch(/hp-foot|<footer/);
  });

  it("scrolls the WHOLE transcript — no render cap to disclose", () => {
    // 2026-07-30 founder direction: the hover must show the complete
    // transcript, for full and concise alike. It used to stop dead at 400
    // lines behind an inline "…400 lines shown" marker; now the body grows a
    // step at a time as the reader approaches the end, so nothing is withheld
    // and there is nothing to disclose. Same trade the transcript itself makes
    // — agent-chat.tsx pages older history in on scroll with no affordance.
    const src = preview();
    expect(src).not.toContain("PREVIEW_LINE_CAP");
    expect(src).not.toContain("lines shown");
    expect(src).toContain("nextPreviewLimit");
    expect(src).toContain("onScroll={onScroll}");
  });

  it("scrolls on a native overflow, NOT <ScrollArea>", () => {
    // Radix makes its Viewport the scroller and that Viewport carries
    // `h-full`. Its containing block here is the ScrollArea root, sized by
    // `flex-1` in a column with a max-height and no height — and a max-height
    // does not make a box definite for percentage resolution. So height:100%
    // fell back to auto, the viewport grew to its full content height, and
    // overflow-y:scroll had nothing to scroll: the wheel did nothing and the
    // thumb never mounted. Scrolling the flex item itself needs no percentage
    // height. Same shape as the two popper surfaces in this app that already
    // scroll (checkpoint-rail's hover card, the command palette's list).
    const src = preview();
    expect(src).not.toContain("ScrollArea");
    expect(src).toContain(
      'className="min-h-0 flex-1 overflow-y-auto overscroll-contain"',
    );
  });

  it("the header is exactly agent, count and last active", () => {
    const src = preview();
    expect(src).toContain("<AgentIcon");
    expect(src).toContain("{userMessageCount}");
    expect(src).toContain("Last active {formatCompactAge(lastMessageAt)} ago");
  });

  it("names the count 'prompts', because that is what it counts", () => {
    // The old "55 messages" was COUNT(*) over persisted rows — tool calls and
    // reasoning included — on a chat the user could see was two questions
    // long. The number is now user prompts, and the word has to say so, or the
    // same ambiguity returns the first time someone compares it to the bubbles
    // on screen.
    const src = preview();
    expect(src).toContain('"prompt" : "prompts"');
    expect(src).not.toMatch(/"message" : "messages"/);
  });

  it("draws the header rule on border2, so it is visible on bg2", () => {
    // border1 is the divider for bg1 surfaces. This panel is a bg2 popover, so
    // border1 rendered invisible and the header ran into the transcript.
    const src = preview();
    expect(src).toContain("border-border2");
    expect(src).not.toContain("border-border1");
  });

  it("renders no skeleton while the body loads", () => {
    // AGENTS.md: never add a fade, skeleton or spinner to conceal a waterfall.
    // The header paints instantly from the summary row; the body follows.
    const src = preview();
    expect(src).not.toContain("Skeleton");
    expect(src).toContain("body === null");
  });
});

describe("D9 — the pill is live, the chip is fixed", () => {
  it("shows the app's agent shimmer while the source chat streams", () => {
    const src = pills();
    expect(src).toContain("useChatStreaming(summary.chatId)");
    expect(src).toContain('variant="agent"');
    // Not a coloured activity dot — one animation must mean one thing, and
    // the chat tab strip already makes exactly this swap.
    expect(src).not.toContain("rounded-full bg-yellow");
  });

  it("has no staleness affordance", () => {
    for (const banned of ["stale", "Refresh", "newer messages", "snapshot"]) {
      expect(pills()).not.toContain(banned);
      expect(preview()).not.toContain(banned);
    }
  });
});

describe("row geometry", () => {
  it("indents the pills to the provenance rows' text column", () => {
    // 14px icon + 8px gap = 22px, so the pills line up under the sentence
    // rather than under its icon.
    expect(pills()).toContain('className="ml-[22px] flex flex-wrap gap-1.5"');
  });

  it("keeps the pills on the 24px control step", () => {
    expect(pills()).toContain('size="sm"');
  });

  it("groups them for assistive tech without adding six tab stops of chrome", () => {
    const src = pills();
    expect(src).toContain('role="group"');
    expect(src).toContain('aria-label="Add chat transcripts"');
  });
});
