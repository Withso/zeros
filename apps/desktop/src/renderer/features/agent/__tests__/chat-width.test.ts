import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CHAT_WIDTH_OPTIONS, DEFAULT_STORED_PREFS } from "../../../shared/theme/prefs";

const renderer = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), "utf8");
/** Source without comments, so prose that names a class never counts as a use. */
const code = (path: string) =>
  renderer(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
const css = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../../../../../../../${path}`, import.meta.url)), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );

/** The declarations of the first rule whose selector is exactly `selector`. */
function block(stylesheet: string, selector: string): string {
  const start = stylesheet.indexOf(`${selector} {`);
  expect(start, `${selector} block`).toBeGreaterThanOrEqual(0);
  return stylesheet.slice(start, stylesheet.indexOf("}", start));
}

// 2026-11-09: Settings → Appearance → Chat width picks the chat's text column:
// Narrow 625px, Normal 800px (the default) and Wide 1200px. The conversation's
// column adds the lane's 28px gutters on each side. These are maximums, so a
// narrower pane still shrinks the chat.
describe("chat width", () => {
  it("offers Narrow, Normal and Wide, Normal by default", () => {
    expect(CHAT_WIDTH_OPTIONS.map((option) => [option.value, option.label])).toEqual([
      ["narrow", "Narrow"],
      ["normal", "Normal"],
      ["wide", "Wide"],
    ]);
    expect(DEFAULT_STORED_PREFS.chatWidth).toBe("normal");
  });

  it("sets the text column for each width and keeps its gutters", () => {
    const semantic = css("styles/semantic-tokens.css");
    const root = block(semantic, ":root");
    expect(root).toContain("--chat-lane: 800px;");
    expect(root).toContain("--chat-column: calc(var(--chat-lane) + var(--spacing) * 14);");
    expect(block(semantic, ':root[data-chat-width="narrow"]')).toContain("--chat-lane: 625px;");
    expect(block(semantic, ':root[data-chat-width="wide"]')).toContain("--chat-lane: 1200px;");
  });

  it("sizes every part of the conversation from it, with no fixed width left", () => {
    const uses: Record<string, Record<string, number>> = {
      "features/agent/agent-chat.tsx": { "max-w-(--chat-column)": 2 },
      "features/agent/turn-event-list.tsx": { "max-w-(--chat-lane)": 1 },
      "features/agent/turn-container.tsx": { "max-w-(--chat-lane)": 1 },
      // The archived, read-only and no-Creator bars share one frame.
      "shell/composer-replacement-bar.tsx": { "max-w-(--chat-column)": 1 },
      "shell/conversation/chat-view.tsx": { "max-w-(--chat-column)": 1 },
      "shell/conversation/conversation-pane.tsx": { "max-w-(--chat-column)": 1 },
    };
    for (const [file, classes] of Object.entries(uses)) {
      const source = code(file);
      expect(source, file).not.toMatch(/max-w-\[(?:800|856)px\]/);
      for (const [cls, count] of Object.entries(classes)) {
        expect(source.split(cls).length - 1, `${file}: ${cls}`).toBe(count);
      }
    }
  });

  it("is picked in Settings → Appearance", () => {
    const settings = renderer("features/settings/settings-page.tsx");
    expect(settings).toContain('label="Chat width"');
    expect(settings).toContain('aria-label="Chat width"');
    expect(settings).toContain("CHAT_WIDTH_OPTIONS.map(");
    expect(settings).toMatch(/setPrefs\(\{ chatWidth: /);
  });
});
