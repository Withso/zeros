import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  AgentControlBar,
  type AgentControlBarProps,
} from "../agent-control-bar";

function render(props: Partial<AgentControlBarProps> = {}) {
  return renderToStaticMarkup(
    createElement(AgentControlBar, {
      variant: "pill",
      title: "Codex",
      stopLabel: "Stop agent browser work",
      onStop: () => undefined,
      ...props,
    }),
  );
}

function rootClasses(markup: string) {
  return new Set(markup.match(/class="([^"]*)"/)![1]!.split(/\s+/));
}

describe("AgentControlBar", () => {
  it("shows the agent, what it is doing, Stop and the Esc shortcut", () => {
    const markup = render({ detail: "Clicking…", escapeHint: true });
    expect(markup).toMatch(/^<div[^>]*role="toolbar"/);
    expect(markup).toContain('aria-label="Codex control"');
    expect(markup).toContain(">Codex</span>");
    expect(markup).toContain(">Clicking…</span>");
    expect(markup).toMatch(
      /<button[^>]*aria-label="Stop agent browser work"[^>]*>[\s\S]*Stop<\/button>/,
    );
    expect(markup).toContain('aria-keyshortcuts="Escape"');
    expect(markup).toContain('data-slot="kbd"');
    expect(markup).toContain(">esc</span>");
  });

  it("floats on the shared dropdown elevation", () => {
    const classes = rootClasses(render());
    expect(classes).toContain("shadow-[var(--shadow-dropdown)]");
    expect(classes).not.toContain("shadow-[var(--shadow-xl)]");
    expect(classes).toContain("rounded-lg");
  });

  it("omits the detail and Esc hint when they do not apply", () => {
    const markup = render({ detail: "", escapeHint: false });
    expect(markup).not.toContain("aria-keyshortcuts");
    expect(markup).not.toContain('data-slot="kbd"');
    expect(markup.match(/<span/g)).toHaveLength(1);
  });

  it("fades without taking the pointer while hidden", () => {
    for (const variant of ["pill", "strip"] as const) {
      const shown = rootClasses(render({ variant, visible: true }));
      expect(shown).toContain("opacity-100");
      expect(shown).toContain("duration-120");
      expect(shown).toContain("motion-reduce:transition-none");
      expect(shown).not.toContain("pointer-events-none");
      const hidden = rootClasses(render({ variant, visible: false }));
      expect(hidden).toContain("opacity-0");
      expect(hidden).toContain("pointer-events-none");
    }
  });

  it("keeps the picture-in-picture strip layout", () => {
    const markup = render({
      variant: "strip",
      title: "example.com",
      leading: createElement("img", { alt: "", src: "data:," }),
      actions: createElement("button", { type: "button" }, "Hide"),
    });
    const classes = rootClasses(markup);
    for (const name of [
      "border-border1",
      "bg-bg1/95",
      "flex",
      "h-7",
      "items-center",
      "gap-1.5",
      "border-b",
      "px-2",
      "backdrop-blur-sm",
    ]) {
      expect(classes).toContain(name);
    }
    expect(markup).toContain('title="example.com"');
    // Icon-only Stop, then the caller's own actions.
    expect(markup).toMatch(
      /aria-label="Stop agent browser work"[\s\S]*<svg[\s\S]*<\/button><button type="button">Hide<\/button><\/div>$/,
    );
  });

  it("disables Stop while a stop is in flight", () => {
    for (const variant of ["pill", "strip"] as const) {
      expect(render({ variant, stopping: true })).toMatch(
        /<button[^>]*disabled=""[^>]*aria-label="Stop agent browser work"|<button[^>]*aria-label="Stop agent browser work"[^>]*disabled=""/,
      );
    }
  });
});
