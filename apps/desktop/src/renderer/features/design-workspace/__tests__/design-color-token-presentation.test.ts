import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "../../../shared/ui/primitives";
import { DesignColorPickerBody, DesignColorTokenList } from "../design-color-picker";
import { DesignColorTokensContext } from "../design-color-token-context";
import type { DesignColorTokenGroup } from "../design-color-tokens";

// check:ui ignore-next -- token fixtures need literal color values.
const C = { bg0: "#0d0d0d", side: "#171717", scrim: "rgba(0, 0, 0, 0.5)" };

const groups: readonly DesignColorTokenGroup[] = [
  {
    key: "source:app\u0000bg",
    label: "App tokens › bg",
    source: "App tokens",
    tokens: [
      { name: "--bg0", declared: C.bg0, color: C.bg0 },
      { name: "--bg3", declared: "var(--sidebar-bg)", color: C.side },
    ],
  },
  {
    key: "manual\u0000scrim",
    label: "Manual › scrim",
    source: "Manual",
    tokens: [{ name: "--scrim", declared: C.scrim, color: C.scrim }],
  },
];

// The app mounts one TooltipProvider at its root.
const render = (element: ReactElement) =>
  renderToStaticMarkup(createElement(TooltipProvider, null, element));

const classAttributes = (html: string) => [...html.matchAll(/class="([^"]*)"/g)].map((match) => match[1]!);

describe("color token list", () => {
  it("shows each source group with searchable, named swatches and marks the active token", () => {
    const html = render(
      createElement(DesignColorTokenList, {
        groups,
        activeToken: "--bg3",
        query: "",
        onQueryChange: () => {},
        onChoose: () => {},
      }),
    );
    expect(html).toContain('aria-label="Search color tokens"');
    expect(html).toContain('role="group" aria-label="App tokens › bg"');
    expect(html).toContain('role="group" aria-label="Manual › scrim"');
    expect(html).toMatch(/aria-pressed="true"[^>]*data-design-color-token="--bg3"/);
    expect(html).toMatch(/aria-pressed="false"[^>]*data-design-color-token="--bg0"/);
    expect(html).toContain('title="--bg3: var(--sidebar-bg)"');
    expect(html).toContain(">bg3<");
    // Chrome is drawn with token classes; only the swatches carry data colors.
    expect(classAttributes(html).some((value) => /#[0-9a-f]{3,8}\b|rgba?\(/i.test(value))).toBe(false);
  });

  it("filters by the query and says when nothing matches", () => {
    const filtered = render(
      createElement(DesignColorTokenList, {
        groups,
        activeToken: null,
        query: "scrim",
        onQueryChange: () => {},
        onChoose: () => {},
      }),
    );
    expect(filtered).toContain('data-design-color-token="--scrim"');
    expect(filtered).not.toContain('data-design-color-token="--bg0"');
    const empty = render(
      createElement(DesignColorTokenList, {
        groups,
        activeToken: null,
        query: "nothing",
        onQueryChange: () => {},
        onChoose: () => {},
      }),
    );
    expect(empty).toContain("No color tokens match.");
  });
});

describe("color picker body", () => {
  const body = (tokenName: string | undefined, tokenPicker = true) =>
    render(
      createElement(
        DesignColorTokensContext.Provider,
        { value: groups },
        createElement(DesignColorPickerBody, {
          value: C.side,
          label: "Fill",
          tokenName,
          tokenPicker,
          panelRef: { current: null },
          onCommit: vi.fn(),
        }),
      ),
    );

  it("opens a token value on the Theme tab beside Custom", () => {
    const html = body("--bg3");
    expect(html).toContain('role="group" aria-label="Color source"');
    expect(html).toMatch(/aria-label="Theme" aria-pressed="true"/);
    expect(html).toMatch(/aria-label="Custom" aria-pressed="false"/);
    expect(html).toMatch(/aria-pressed="true"[^>]*data-design-color-token="--bg3"/);
  });

  it("keeps a composed color on Custom alone", () => {
    const html = body("--bg3", false);
    expect(html).not.toContain('aria-label="Color source"');
    expect(html).not.toContain("data-design-color-token");
  });
});
