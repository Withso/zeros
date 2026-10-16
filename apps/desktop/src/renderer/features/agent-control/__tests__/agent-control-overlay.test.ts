import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  AgentControlOverlayFrame,
  isAgentControlStopKey,
  isAgentControlStopTarget,
  readAgentControlOverlayState,
} from "../agent-control-overlay";

const key = (
  overrides: Partial<Parameters<typeof isAgentControlStopKey>[0]> = {},
) => ({
  key: "Escape",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  isComposing: false,
  ...overrides,
});

describe("readAgentControlOverlayState", () => {
  it("accepts the state main sends", () => {
    expect(
      readAgentControlOverlayState({
        title: "Codex",
        detail: "Clicking…",
        visible: true,
      }),
    ).toEqual({ title: "Codex", detail: "Clicking…", visible: true });
  });

  it("ignores anything else", () => {
    for (const value of [
      null,
      undefined,
      "Codex",
      { title: "Codex", detail: "Clicking…" },
      { title: 1, detail: "", visible: true },
      { title: "Codex", detail: null, visible: true },
      { title: "Codex", detail: "", visible: "yes" },
    ]) {
      expect(readAgentControlOverlayState(value)).toBeNull();
    }
  });
});

describe("isAgentControlStopKey", () => {
  it("stops on Esc, as the page does", () => {
    expect(isAgentControlStopKey(key())).toBe(true);
    const shifted = { ...key(), shiftKey: true };
    expect(isAgentControlStopKey(shifted)).toBe(true);
  });

  it("leaves chords, other keys and IME composition alone", () => {
    expect(isAgentControlStopKey(key({ key: "Enter" }))).toBe(false);
    expect(isAgentControlStopKey(key({ metaKey: true }))).toBe(false);
    expect(isAgentControlStopKey(key({ ctrlKey: true }))).toBe(false);
    expect(isAgentControlStopKey(key({ altKey: true }))).toBe(false);
    expect(isAgentControlStopKey(key({ isComposing: true }))).toBe(false);
  });
});

describe("isAgentControlStopTarget", () => {
  // Stands in for a DOM element: only `closest` matters.
  const element = (insideButton: boolean) => {
    const target = {
      closest: (selector: string) =>
        selector === "button:not(:disabled)" && insideButton ? target : null,
    };
    return target as unknown as EventTarget;
  };

  it("is true only over an enabled button", () => {
    expect(isAgentControlStopTarget(element(true))).toBe(true);
    expect(isAgentControlStopTarget(element(false))).toBe(false);
    expect(isAgentControlStopTarget({} as EventTarget)).toBe(false);
    expect(isAgentControlStopTarget(null)).toBe(false);
  });
});

describe("AgentControlOverlayFrame", () => {
  const render = (visible: boolean, stopping = false) =>
    renderToStaticMarkup(
      createElement(AgentControlOverlayFrame, {
        state: { title: "Codex", detail: "Typing…", visible },
        stopping,
        onStop: () => undefined,
      }),
    );

  it("floats the pill at the bottom center with the view's insets", () => {
    const markup = render(true);
    // Matches agentControlOverlayBounds: 24px sides, 16px bottom.
    expect(markup).toMatch(
      /^<div class="flex h-screen items-end justify-center px-6 pb-4">/,
    );
    expect(markup).toContain('role="toolbar"');
    expect(markup).toContain(">Codex</span>");
    expect(markup).toContain(">Typing…</span>");
    expect(markup).toContain('aria-label="Stop Codex"');
    expect(markup).toContain('aria-keyshortcuts="Escape"');
    expect(markup).toContain(">esc</span>");
    expect(markup).toContain("opacity-100");
  });

  it("fades out while hidden and disables Stop while stopping", () => {
    expect(render(false)).toContain("pointer-events-none opacity-0");
    expect(render(true, true)).toMatch(/<button[^>]*disabled=""/);
  });
});
