import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function code(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    "utf8",
  )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function css(repoPath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../../../../../${repoPath}`, import.meta.url)),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");
}

function themeBlock(stylesheet: string, selector: string): string {
  const start = stylesheet.indexOf(`${selector} {`);
  expect(start, `${selector} block`).toBeGreaterThanOrEqual(0);
  return stylesheet.slice(start, stylesheet.indexOf("\n}", start));
}

describe("composer chrome", () => {
  it("edges the composer family with its own semantic border token", () => {
    // Dark's edge is 50/50/50, between border2 (46) and border3 (68), so it
    // has no primitive; Light keeps the border2 edge it already had.
    const semantic = css("styles/semantic-tokens.css");
    const dark = /--composer-border:\s*([^;]+);/.exec(themeBlock(semantic, ":root"))?.[1] ?? "";
    expect(dark).toMatch(/^#[0-9a-f]{6}$/i);
    expect([1, 3, 5].map((at) => Number.parseInt(dark.slice(at, at + 2), 16))).toEqual([50, 50, 50]);
    expect(themeBlock(semantic, '[data-theme="light"]')).toMatch(
      /--composer-border:\s*var\(--border2\);/,
    );
    // The composer, Create, the sent prompt, every dock card and the docked
    // pickers keep one edge, so none of them can drift back to border2.
    const shell = code("../composer-shell.tsx");
    expect(shell).toContain(
      'export const COMPOSER_SURFACE_CLS = "border-(--composer-border) bg-sidebar-bg"',
    );
    expect(shell).toMatch(
      /export const DOCK_CARD_CLS =\s*"border-\(--composer-border\) bg-sidebar-bg /,
    );
    expect(code("../../../shared/ui/primitives/popover.tsx")).toMatch(
      /composer:\s*"bg-sidebar-bg border-\(--composer-border\) /,
    );
    expect(shell).not.toContain("border-border2");
    // Review drafts in Changes, Files and Review take the agent composer's
    // surface from its owner rather than a copy.
    const review = code("../../code-review/review-composer.tsx");
    expect(review).toMatch(/className=\{cn\(\s*COMPOSER_SURFACE_CLS,/);
    expect(review).not.toContain("border-border2 bg-sidebar-bg");
  });

  it("keeps one sidebar-bg + composer-border edge whether or not it is focused", () => {
    // Clicking in and typing change nothing: the border never moves on focus
    // and the card carries no stock shadow.
    const agentChat = code("../agent-chat.tsx");
    expect(agentChat).toContain('"relative flex w-full min-w-0 flex-col border px-3.5 py-3",');
    // The edge and fill only ease; the Ask pill's morph (composer-ask.tsx)
    // owns the card's transitions.
    expect(agentChat).toMatch(/COMPOSER_SURFACE_CLS,\s*COMPOSER_SURFACE_RADIUS,\s*composerAskCardClasses\(askCollapsed\),/);
    expect(agentChat).not.toContain("shadow-xs");
  });

  it("keeps the drag and guarded states off the focus border", () => {
    const agentChat = code("../agent-chat.tsx");

    // Dragging files over the card and the guarded (plan/ask) frame both
    // override the border with `!`, so a focused composer looks identical to an
    // unfocused one in those states.
    expect(code("../composer-shell.tsx")).toMatch(
      /export const COMPOSER_DRAG_CLS =\s*"!border-\(--composer-border\) ring-highlighted-bright\/30 border-dashed ring-2"/,
    );
    expect(agentChat).toContain("dragActive && COMPOSER_DRAG_CLS");
    expect(agentChat).toContain("{dragActive && !askCollapsed && <ComposerDropVeil />}");
    expect(agentChat).toContain('"!border-transparent"');
  });

  it("edits a sent message in the composer's own card", () => {
    // The inline edit is the composer around the same editor and pills: its
    // surface and 18px corners, its drag edge and drop veil, and its 28px
    // controls 4px apart.
    const turn = code("../turn-container.tsx");
    const editor = turn.slice(turn.indexOf("function TurnPromptEditor("));
    expect(editor).toMatch(
      /"zeros-agent-turn-prompt is-editing relative w-full border px-3\.5 py-3",\s*COMPOSER_SURFACE_CLS,\s*COMPOSER_SURFACE_RADIUS,\s*dragActive && COMPOSER_DRAG_CLS,/,
    );
    expect(editor).toContain("{dragActive && <ComposerDropVeil />}");
    expect(editor).toContain("className={COMPOSER_SEND_CLS}");
    expect(code("../agent-chat.tsx")).toContain("className={COMPOSER_SEND_CLS}");
    expect(code("../composer-shell.tsx")).toContain(
      'export const COMPOSER_SEND_CLS =\n  "disabled:bg-bg2-hover disabled:text-fg2 aria-disabled:bg-bg2-hover aria-disabled:text-fg2 size-7 disabled:opacity-100"',
    );
    expect(editor).toContain('<PromptInputTools className="min-w-0 flex-nowrap gap-1">');
    // The old bg2 card, its inner ring, the 32px Resend and a restyled attach
    // button are gone.
    expect(turn).not.toContain("border-border2 bg-bg2");
    expect(turn).not.toContain("ring-highlighted-bright/40");
    expect(editor).not.toContain("size-8");
    expect(editor).not.toContain('className="rounded-sm"');
  });

  it("fades the transcript into the canvas above the top of the composer stack", () => {
    // One fade, owned by the dock column rather than any one card: the column
    // starts at its topmost card (pt-0), so the fade sits on the composer
    // alone and moves above the highest card once cards dock over it.
    const agentChat = code("../agent-chat.tsx");
    const column = agentChat.indexOf(
      '"relative mx-auto box-border flex w-full max-w-[856px] min-w-0 shrink-0 flex-col gap-2 border-t-0 bg-transparent px-7 pt-0 pb-4"',
    );
    expect(column, "dock column").toBeGreaterThanOrEqual(0);
    const fade = agentChat.indexOf(
      '<div aria-hidden="true" data-composer-dock-fade="" className={COMPOSER_DOCK_FADE} />',
      column,
    );
    expect(fade, "dock fade").toBeGreaterThan(column);
    // First in the column: before every card that can dock and the composer.
    for (const card of [
      "<EmbeddedTerminalCommand",
      "<GoalCard",
      "<QueuedMessagesCard",
      "<PermissionCard",
      "<QuestionCard",
      "<PlanReviewCard",
      "ref={composerCardRef}",
    ]) {
      expect(agentChat.indexOf(card, column), card).toBeGreaterThan(fade);
    }
    expect(agentChat.match(/data-composer-dock-fade=""/g)).toHaveLength(1);
  });

  it("gives Create, workspace and edit composers 18px corners without changing sent messages", () => {
    expect(code("../composer-shell.tsx")).toContain(
      'export const COMPOSER_SURFACE_RADIUS = "rounded-[18px]"',
    );
    expect(code("../agent-chat.tsx")).toContain("COMPOSER_SURFACE_RADIUS");
    expect(code("../../../shell/dispatcher/dispatcher-composer.tsx")).toContain("COMPOSER_SURFACE_RADIUS");
    expect(code("../composer-pills.tsx")).toContain('rx="17.5"');
    expect(code("../composer-shell.tsx")).toContain(
      'export const PROMPT_SURFACE_RADIUS = "rounded-[calc(var(--radius-lg)*1.5)]"',
    );
    expect(code("../turn-container.tsx")).toContain("PROMPT_SURFACE_RADIUS");
  });

  it("keeps the composer's own surface off the sent user message", () => {
    // One sidebar-bg + composer-border surface for the composer, Create and
    // the edit composer. Since 2026-11-09 a sent message is a bg2 bubble with
    // no edge (prompt-fold.test.ts), told apart from the prompt being written.
    expect(code("../composer-shell.tsx")).toContain(
      'export const COMPOSER_SURFACE_CLS = "border-(--composer-border) bg-sidebar-bg"',
    );
    expect(code("../turn-container.tsx")).not.toContain(": COMPOSER_SURFACE_CLS,");
    expect(code("../agent-chat.tsx")).toContain("COMPOSER_SURFACE_CLS,");
    expect(code("../../../shell/dispatcher/dispatcher-composer.tsx")).toContain("COMPOSER_SURFACE_CLS,");
    // Focusing or typing changes nothing.
    expect(code("../agent-chat.tsx")).not.toContain("focus-within:border-border2");
  });
});
