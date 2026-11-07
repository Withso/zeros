import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { cn } from "@/renderer/shared/ui/cn";
import { PILL_METRICS, PILL_SHELL } from "@/renderer/features/agent/composer-editor/pill-views";

// The chat's reading text is 15px on 22px lines (`text-reading`), one step
// above the 14px chrome: agent output, sent messages, the composer and the
// rows of the transcript feed. The chip beside a tool's name is 13px. Source
// pins in the idiom of chat-provenance-style.test.ts; the UI smokes measure
// the rendered sizes.

const R = "apps/desktop/src/renderer";

function source(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

function agentMarkdownSizes(): { selector: string; size: string }[] {
  const css = source("styles/global/runtime-content.css").replace(/\/\*[\s\S]*?\*\//g, "");
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, selector]) => selector!.includes(".zeros-agent-md"))
    .flatMap(([, selector, body]) =>
      [...body!.matchAll(/font-size:\s*([^;]+);/g)].map((match) => ({
        selector: selector!.trim().replace(/\s+/g, " "),
        size: match[1]!.trim(),
      })),
    );
}

describe("chat reading type", () => {
  it("defines a 15px reading size on 22px lines and keeps dialog titles at 15px", () => {
    const tokens = source("styles/zeros-tokens.css");
    expect(tokens).toMatch(/--reading-text-size: 0\.9375rem;/);
    expect(tokens).toContain("--text-reading: var(--reading-text-size);");
    expect(tokens).toContain("--text-reading--line-height: calc(22 / 15);");
    expect(tokens).toMatch(/--dialog-title-size: 0\.9375rem;/);
    expect(tokens).toContain("--text-dialog-title: var(--dialog-title-size);");
  });

  it("sets agent output prose in the reading size and code, inline code and tables at 13px", () => {
    const sizes = agentMarkdownSizes();
    expect(sizes.filter(({ size }) => size === "14px")).toEqual([]);
    const prose = sizes.filter(({ size }) => size === "var(--agent-md-text)").map(({ selector }) => selector);
    for (const element of ["", " p", " ol", " a", " .zeros-md-filepath", " dl"]) {
      expect(prose.some((selector) => selector.endsWith(`.zeros-agent-md${element}`))).toBe(true);
    }
    const size = (selector: string) => sizes.find((entry) => entry.selector === `[data-Zeros-root] .zeros-agent-md ${selector}`)?.size;
    expect(size("code")).toBe("13px");
    expect(size("pre")).toBe("13px");
    expect(size("table")).toBe("13px");
  });

  it("sizes agent markdown by where it sits: the chat, a tool detail, the plan, a review panel", () => {
    const css = source("styles/global/runtime-content.css").replace(/\/\*[\s\S]*?\*\//g, "");
    const declaration = (selector: string) =>
      new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{[^}]*--agent-md-text:\\s*([^;]+);`).exec(css)?.[1]?.trim();
    expect(declaration("[data-Zeros-root] .zeros-agent-md")).toBe("var(--reading-text-size)");
    expect(declaration("[data-Zeros-root] [data-tool-detail] .zeros-agent-md")).toBe("13px");
    expect(declaration("[data-Zeros-root] .zeros-agent-md.zeros-agent-md--document")).toBe("var(--reading-text-size)");
    expect(declaration("[data-Zeros-root] .zeros-agent-md.zeros-agent-md--panel")).toBe("14px");
    // The plan is the turn's focal document: it keeps the reading size inside its detail.
    expect(source(`${R}/features/agent/renderers/tool-exit-plan-mode.tsx`)).toContain('"zeros-agent-md zeros-agent-md--document text-fg1 px-3 py-2.5 text-reading"');
    // Markdown outside the chat keeps the 14px it had before the chat moved to 15px.
    for (const file of ["shell/workbench/tabs/review-tab.tsx", "shell/workbench/tabs/review-timeline.tsx", "features/code-review/inline-review-thread.tsx"]) {
      expect(source(`${R}/${file}`), file).toMatch(/className="zeros-agent-md zeros-agent-md--panel[ "]/);
    }
  });

  it("sets tool details at 13px and popover titles on the 13px scale", () => {
    const renderer = source(`${R}/features/agent/renderers/event-row-renderer.tsx`);
    for (const pin of [
      '"text-fg2 space-y-2 text-xs"',
      '"text-fg2 px-3 py-2 text-xs whitespace-pre-wrap"',
      '"flex flex-wrap items-center gap-1.5 px-3 py-2 text-xs text-fg3"',
      '"px-3 py-2 text-xs text-fg3"',
      '"text-fg2 px-3 py-2 text-xs">No lines returned.',
    ]) expect(renderer).toContain(pin);
    expect(source(`${R}/features/agent/composer-tools.tsx`)).toContain('className="text-fg1 text-xs leading-4.5 font-medium"');
    expect(source(`${R}/shell/conversation/cloud-workspace-details.tsx`)).toContain('"text-fg1 mb-3 truncate text-xs leading-4.5 font-medium"');
  });

  it("writes and shows sent messages in the reading size", () => {
    const editor = source(`${R}/features/agent/composer-editor/use-composer-editor.tsx`);
    const editorClass = /const EDITOR_CLASS = `([^`]*)`/.exec(editor)?.[1] ?? "";
    expect(editorClass.split(/\s+/)).toContain("text-reading");
    expect(editorClass).not.toMatch(/\b(?:text-sm|leading-5)\b/);
    expect(source(`${R}/shared/ui/primitives/elements/message.tsx`)).toContain("text-reading leading-relaxed");
    const message = source(`${R}/features/agent/renderers/text-message.tsx`);
    expect(message).toContain('<div className="text-reading wrap-anywhere whitespace-pre-wrap">');
    // Plain text: sent messages read at the reading size; a system notice keeps
    // its 13px on 20px lines.
    expect(message).toContain('cn(message.role === "system" ? "leading-5" : "text-reading", "wrap-anywhere whitespace-pre-wrap")');
    expect(message).not.toContain('"leading-5 wrap-anywhere');
  });

  it("sets the transcript's rows and notices in the reading size, rows on 20px lines so they stay 28px", () => {
    const rows: [string, string][] = [
      ["features/agent/renderers/event-row.tsx", '"max-w-[60ch] min-w-0 truncate text-reading leading-5"'],
      ["features/agent/renderers/event-stripe.tsx", '<span className="text-fg2 min-w-0 truncate text-reading leading-5">'],
      ["features/agent/renderers/event-row-renderer.tsx", '"text-fg1 flex items-center gap-2 py-1 text-reading leading-5"'],
      ["features/agent/renderers/event-row-renderer.tsx", '"text-fg2 py-1 text-reading leading-5" data-provider-notice'],
      ["features/agent/renderers/text-message.tsx", '"text-fg3 flex items-start gap-2 py-1 text-reading leading-5"'],
      ["features/agent/renderers/tool-subagent.tsx", '"min-w-0 truncate text-reading leading-5"'],
      ["features/agent/renderers/tool-subagent.tsx", '<span className="text-fg1 text-reading leading-5">Prompt</span>'],
      ["features/agent/renderers/browser-activity-card.tsx", '<span className="text-fg1 min-w-0 truncate text-reading leading-5">{statusLabel}</span>'],
      ["features/agent/workflow-activity.tsx", '<span className="text-fg1 truncate text-reading leading-5">{label}</span>'],
      ["features/agent/local-links/note-row.tsx", '<span className="text-fg1 text-reading leading-5">{LABELS[note.event]}</span>'],
    ];
    // Running text keeps the reading size's own 22px lines.
    const text: [string, string][] = [
      ["features/agent/renderers/event-row-renderer.tsx", '"text-fg2 flex select-text flex-col gap-2 pr-3 pl-5 text-reading"'],
      ["features/agent/renderers/tool-exit-plan-mode.tsx", '"zeros-agent-md zeros-agent-md--document text-fg1 px-3 py-2.5 text-reading"'],
      ["features/agent/agent-notice.tsx", '"bg-brown-bg text-fg1 min-w-0 px-3 py-2 text-reading"'],
    ];
    for (const [file, pin] of [...rows, ...text]) expect(source(`${R}/${file}`), file).toContain(pin);
  });

  it("sets the chip beside a tool's name at 13px, still 20px tall", () => {
    const row = source(`${R}/features/agent/renderers/event-row.tsx`);
    expect(row).toContain('"max-w-[440px] min-w-0 truncate rounded-sm px-1.5 py-0.5 text-xs leading-4 font-medium"');
    // The file tag is the inline Pill, already 13px; it sets no size of its own.
    const fileTag = /<FileTag[\s\S]*?\/>/.exec(row)?.[0] ?? "";
    expect(fileTag).toContain("className=");
    expect(fileTag).not.toMatch(/\btext-(?:xxs|2xxs|3xxs|xs|sm)\b/);
  });

  it("draws every pill in the composer and sent messages at 13/16 in its 20px box", () => {
    const metrics = PILL_METRICS.split(/\s+/);
    for (const cls of ["h-5", "text-xs", "leading-4"]) expect(metrics, cls).toContain(cls);
    expect(metrics).not.toContain("text-3xxs");
    expect(PILL_SHELL.startsWith(PILL_METRICS)).toBe(true);
  });

  it("merges the reading size as a font size, not a color", () => {
    expect(cn("text-reading", "text-fg2")).toBe("text-reading text-fg2");
    expect(cn("text-sm", "text-reading")).toBe("text-reading");
  });
});
