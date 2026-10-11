import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setClaudeIdleCompactionEnabled } from "../../agent/reliability-settings";
import { ClaudeProviderSettings } from "../claude-provider-settings";

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  setClaudeIdleCompactionEnabled(false);
});
afterEach(() => vi.unstubAllGlobals());

const idleSwitch = (html: string) => html.match(/<button[^>]*id="claude-idle-compaction"[^>]*>/)?.[0];

describe("Claude provider settings", () => {
  it("places the default-off Idle compaction switch after Keep sessions active", () => {
    const html = renderToStaticMarkup(createElement(ClaudeProviderSettings, { onChange: vi.fn() }));
    expect(html.indexOf("Auto memory")).toBeLessThan(html.indexOf("Keep sessions active"));
    expect(html.indexOf("Keep sessions active")).toBeLessThan(html.indexOf("Idle compaction"));
    expect(html).toContain("Compact long conversations while the session is idle");
    expect(idleSwitch(html)).toContain('aria-checked="false"');
    expect(html).toContain('for="claude-idle-compaction"');
  });

  it("restores the same persisted On choice on the next Settings mount", () => {
    setClaudeIdleCompactionEnabled(true);
    const html = renderToStaticMarkup(createElement(ClaudeProviderSettings, { onChange: vi.fn() }));
    expect(idleSwitch(html)).toContain('aria-checked="true"');
  });
});
