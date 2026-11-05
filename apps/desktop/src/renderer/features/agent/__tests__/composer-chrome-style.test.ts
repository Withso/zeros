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

describe("composer chrome", () => {
  it("keeps one sidebar-bg + border2 edge whether or not it is focused", () => {
    // Clicking in and typing change nothing: the border never moves on focus
    // and the card carries no stock shadow.
    const agentChat = code("../agent-chat.tsx");
    expect(agentChat).toContain(
      '"relative flex w-full min-w-0 flex-col border px-3.5 py-3 transition-[border-color,background,box-shadow] duration-150 ease-out",',
    );
    expect(agentChat).toMatch(/COMPOSER_SURFACE_CLS,\s*COMPOSER_SURFACE_RADIUS,/);
    expect(agentChat).not.toContain("shadow-xs");
  });

  it("keeps the drag and guarded states off the focus border", () => {
    const agentChat = code("../agent-chat.tsx");

    // Dragging files over the card and the guarded (plan/ask) frame both
    // override the border with `!`, so a focused composer looks identical to an
    // unfocused one in those states.
    expect(agentChat).toContain(
      '"!border-border2 ring-highlighted-bright/30 border-dashed ring-2"',
    );
    expect(agentChat).toContain('"!border-transparent"');
  });

  it("gives Create and workspace composers 18px corners without changing sent messages", () => {
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

  it("paints the sent user message on the composer's own surface", () => {
    // One sidebar-bg + border2 surface for the composer, Create and the sent
    // message, so a prompt keeps its look after it is sent.
    expect(code("../composer-shell.tsx")).toContain(
      'export const COMPOSER_SURFACE_CLS = "border-border2 bg-sidebar-bg"',
    );
    expect(code("../turn-container.tsx")).toContain(": COMPOSER_SURFACE_CLS,");
    expect(code("../agent-chat.tsx")).toContain("COMPOSER_SURFACE_CLS,");
    expect(code("../../../shell/dispatcher/dispatcher-composer.tsx")).toContain("COMPOSER_SURFACE_CLS,");
    // Focusing or typing changes nothing.
    expect(code("../agent-chat.tsx")).not.toContain("focus-within:border-border2");
  });
});
