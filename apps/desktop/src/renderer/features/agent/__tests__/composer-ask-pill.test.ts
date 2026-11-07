import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  COMPOSER_ASK_COLLAPSE_MS,
  COMPOSER_ASK_EXPAND_MS,
  ComposerAskPill,
  composerAskCardClasses,
  composerAskContentClasses,
} from "@/renderer/shared/ui/composer-ask";

const classes = (value: string) => value.split(/\s+/).filter(Boolean);

// 2026-11-07 (Zeros Design v401, "Chat window · Ask to focus"): an unfocused
// split pane's composer collapses into one "Ask <agent>" pill. The card itself
// is the pill, so its fill and edge carry through the morph.
describe("the composer's Ask pill", () => {
  it("reads Ask and the agent's name, with no shortcut, and only the collapsed pill takes focus", () => {
    const collapsed = renderToStaticMarkup(
      createElement(ComposerAskPill, { agent: "Codex", collapsed: true, onActivate: () => {} }),
    );
    expect(collapsed).toContain(">Ask Codex</span>");
    expect(collapsed).toContain('type="button"');
    expect(collapsed).not.toMatch(/⌘|Ctrl|kbd/i);
    expect(collapsed).not.toContain("tabindex");
    expect(collapsed).not.toContain("aria-hidden");
    const expanded = renderToStaticMarkup(
      createElement(ComposerAskPill, { agent: "Codex", collapsed: false, onActivate: () => {} }),
    );
    expect(expanded).toContain('tabindex="-1"');
    expect(expanded).toContain('aria-hidden="true"');
    expect(expanded).toContain("pointer-events-none");
    expect(expanded).toContain("opacity-0");
  });

  it("collapses the card to a 32px pill on the composer's own surface, lifting a step on hover", () => {
    const pill = classes(composerAskCardClasses(true));
    expect(pill).toEqual(expect.arrayContaining([
      "h-8", "w-(--ask-pill-w)", "overflow-hidden", "items-center", "justify-end",
      "rounded-[calc(var(--radius-lg)*2)]", "hover:bg-sidebar-bg-hover", "hover:border-border3",
    ]));
    // No fill or edge of its own: the composer's sidebar-bg and composer-border carry through.
    expect(pill.filter((name) => /^(bg-|border-)/.test(name))).toEqual([]);
    const card = classes(composerAskCardClasses(false));
    expect(card).not.toContain("h-8");
    expect(card).not.toContain("overflow-hidden");
  });

  it("morphs the shape in 220ms out and 180ms back on one curve, and holds still for reduced motion", () => {
    expect([COMPOSER_ASK_EXPAND_MS, COMPOSER_ASK_COLLAPSE_MS]).toEqual([220, 180]);
    for (const collapsed of [true, false]) {
      const card = classes(composerAskCardClasses(collapsed));
      expect(card).toEqual(expect.arrayContaining([
        "[interpolate-size:allow-keywords]",
        "transition-[width,height,border-radius,border-color,background-color,box-shadow]",
        "ease-[cubic-bezier(0.2,0,0,1)]", "motion-reduce:transition-none", "data-[ask-instant]:transition-none",
      ]));
      expect(card).toContain(collapsed ? "duration-180" : "duration-220");
    }
    // While it expands the card keeps the pill's clip and bottom-centre anchor.
    expect(classes(composerAskCardClasses(false))).toEqual(expect.arrayContaining([
      "data-[ask-morph]:overflow-hidden", "data-[ask-morph]:items-center", "data-[ask-morph]:justify-end",
    ]));
  });

  it("keeps the composer laid out at full width and fades it, so nothing reflows inside the morph", () => {
    const hidden = classes(composerAskContentClasses(true));
    expect(hidden).toEqual(expect.arrayContaining([
      "min-w-(--composer-content-w)", "opacity-0", "translate-y-1", "pointer-events-none", "duration-70",
    ]));
    const shown = classes(composerAskContentClasses(false));
    expect(shown).toEqual(expect.arrayContaining(["opacity-100", "translate-y-0", "delay-60", "duration-140"]));
    expect(shown).toContain("group-data-[ask-morph]/composer:min-w-(--composer-content-w)");
    // Only the card eases to auto; its contents keep numeric interpolation.
    expect(shown).toContain("[interpolate-size:numeric-only]");
    expect(shown).not.toContain("min-w-(--composer-content-w)");
  });
});
