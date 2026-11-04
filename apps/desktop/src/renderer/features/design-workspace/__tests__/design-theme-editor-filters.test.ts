// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DesignStyleSourceWire, DesignTokenWire } from "../../../platform/git";
import { TooltipProvider } from "../../../shared/ui/primitives";
import { DesignThemeEditor } from "../design-theme-editor";

vi.mock("../state/use-design-foundation", () => ({ useDesignFoundation: () => ({ data: null }) }));
vi.mock("../state/design-workspace-cache", () => ({
  applyDesignTransactionCached: vi.fn(),
  refreshDesignStylesCached: vi.fn(async () => {}),
  updateDesignThemeCached: vi.fn(),
  updateDesignTokenCached: vi.fn(),
}));
vi.mock("../design-agent-sync", () => ({ useAskDesignAgent: () => () => {} }));

const source = (
  id: string,
  title: string,
  tokens: Array<{ name: string; value: string }>,
  overrides: Partial<DesignStyleSourceWire> = {},
): DesignStyleSourceWire => ({
  id,
  title,
  kind: "css",
  path: `styles/${id}.css`,
  status: "ready",
  messages: [],
  themes: [],
  tokens: tokens.map((token) => ({ ...token, themeValues: {} })),
  bytes: 1,
  revision: "a".repeat(24),
  ...overrides,
});
const manual = (name: string, value: string): DesignTokenWire => ({
  name, syntax: "*", inherits: true, initialValue: value, value, themeValues: {}, usageCount: 0, line: 1,
});

const appStyles = source("app", "App styles", [
  { name: "--surface", value: "white" },
  { name: "--radius-md", value: "6px" },
]);
const platform = source("platform", "App global: platform", ["panel", "chrome", "dropdown", "modal", "toast"].map(
  (name, index) => ({ name: `--z-${name}`, value: String(30 + index) }),
));
const runtime = source("runtime", "App global: runtime content", [], { rules: 74 });

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function renderEditor(props: { tokens?: DesignTokenWire[]; styleSources?: DesignStyleSourceWire[] } = {}) {
  act(() => root.render(createElement(TooltipProvider, null, createElement(DesignThemeEditor, {
    workspaceId: "workspace",
    frame: null,
    tokens: props.tokens ?? [],
    tokenSourceVersion: null,
    styleSources: props.styleSources ?? [appStyles, platform, runtime],
    activeTheme: null,
    active: true,
    open: true,
    onOpenChange: () => {},
    onActiveThemeChange: () => {},
  }))));
}

const click = (element: Element | null) => {
  expect(element).not.toBeNull();
  act(() => (element as HTMLElement).click());
};
const sourceButton = (label: string) => document.querySelector(`[aria-label="Theme sources"] [aria-label^="${label},"]`);
const typeButton = (label: string) => document.querySelector(`[aria-label="Filter variables by type"] [aria-label="${label}"]`);
const pressedTypes = () => [...document.querySelectorAll('[aria-label="Filter variables by type"] button[aria-pressed="true"]')]
  .map((button) => button.getAttribute("aria-label"));
const rows = () => document.querySelectorAll("[data-design-theme-row]").length;

describe("theme editor type filter", () => {
  it("returns to All when another source is chosen, so its variables are never hidden", () => {
    renderEditor();
    click(sourceButton("App styles"));
    click(typeButton("Color"));
    expect(rows()).toBe(1);

    click(sourceButton("App global: platform"));
    expect(document.querySelector(".zd-theme-source-summary")?.textContent).toBe("5 variables · read-only");
    expect(rows()).toBe(5);
    expect(pressedTypes()).toEqual(["All"]);
  });

  it("keeps the chosen type visible and pressed after its last variable leaves", () => {
    renderEditor({ tokens: [manual("--brand", "rebeccapurple"), manual("--gap", "4px")] });
    click(typeButton("Color"));
    expect(rows()).toBe(1);

    renderEditor({ tokens: [manual("--gap", "4px")] });
    expect(rows()).toBe(0);
    expect(typeButton("Color")?.textContent).toBe("Color0");
    expect(pressedTypes()).toEqual(["Color"]);
    click(typeButton("All"));
    expect(rows()).toBe(1);
  });
});

describe("theme editor styles-only sources", () => {
  it("folds stylesheets without variables into one group that lists them on demand", () => {
    renderEditor();
    const group = document.querySelector("[data-design-theme-styles-only]");
    expect(group?.getAttribute("aria-expanded")).toBe("false");
    expect(group?.getAttribute("aria-label")).toBe("Styles only, 1 source");
    expect(sourceButton("App global: runtime content")).toBeNull();

    click(group);
    expect(group?.getAttribute("aria-expanded")).toBe("true");
    click(sourceButton("App global: runtime content"));
    expect(document.querySelector(".zd-theme-source-summary")?.textContent).toBe("74 rules · read-only");
    expect(document.querySelector(".zd-theme-empty")?.textContent).toContain(
      "Its 74 rules style frames that use its classes.",
    );
  });
});
