import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "../../shared/ui/primitives/tooltip";
import {
  CREATE_DESIGN_DIRECTORY_LABEL,
  WorkspaceModeHeaderView,
  WorkspaceModeToggleView,
} from "../../shared/ui/workspace-mode-header";

const conversationPaneSource = readFileSync(
  resolve(
    process.cwd(),
    "apps/desktop/src/renderer/shell/conversation/conversation-pane.tsx",
  ),
  "utf8",
);
const designSidebarSource = readFileSync(
  resolve(
    process.cwd(),
    "apps/desktop/src/renderer/features/design-workspace/design-workspace-sidebar.tsx",
  ),
  "utf8",
);
const paneLayoutSource = readFileSync(
  resolve(
    process.cwd(),
    "apps/desktop/src/renderer/shell/conversation/pane-layout.tsx",
  ),
  "utf8",
);
const chatTabsSource = readFileSync(
  resolve(
    process.cwd(),
    "apps/desktop/src/renderer/shell/conversation/chat-tabs.tsx",
  ),
  "utf8",
);
const workbenchPaneSource = readFileSync(
  resolve(
    process.cwd(),
    "apps/desktop/src/renderer/shell/workbench/workbench-pane.tsx",
  ),
  "utf8",
);

/** The class string a `const NAME = "..."` declares, whether the literal sits on
 *  the same line or wraps onto the next (Prettier moves it when it grows). */
function classString(source: string, constantName: string): string {
  const declaration = source.match(
    new RegExp(`\\b${constantName} =\\s+"([^"]*)"`),
  )?.[1];
  if (declaration === undefined) {
    throw new Error(`no class string found for ${constantName}`);
  }
  return declaration;
}

function classList(source: string, constantName: string): string[] {
  return classString(source, constantName).split(" ");
}

/** The `h-*` utility a class-string constant declares. */
function bandHeight(source: string, constantName: string): string | undefined {
  return classList(source, constantName).find((cls) => /^h-\d+$/.test(cls));
}

function renderToggle(
  props: Partial<Parameters<typeof WorkspaceModeToggleView>[0]> = {},
) {
  return renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(WorkspaceModeToggleView, {
        mode: "code",
        disabled: false,
        switching: false,
        onModeChange: vi.fn(),
        ...props,
      }),
    ),
  );
}

describe("workspace mode toggle", () => {
  it("is two icon-only mode choices and nothing else", () => {
    const markup = renderToggle();

    expect(markup.match(/<button/g)).toHaveLength(2);
    expect(markup).toContain('aria-label="Code mode"');
    expect(markup).toContain('aria-label="Design mode"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).toContain('class="lucide lucide-code-xml size-4"');
    expect(markup).toContain('class="lucide lucide-pen-tool size-4"');
    expect(markup).toContain("p-1");
    // No row of its own, and no workspace name: the toggle is a bare control
    // its host seats (Code's chat strip, Design's named header row).
    expect(markup).not.toContain("h-10");
    expect(markup).not.toContain('data-workspace-mode-header=""');
    expect(markup).not.toContain('data-workspace-mode-name=""');
    expect(markup).not.toContain(">Code</button>");
    expect(markup).not.toContain(">Design</button>");

    const buttonTags = markup.match(/<button[^>]*>/g) ?? [];
    for (const buttonTag of buttonTags) {
      const buttonClasses =
        buttonTag.match(/class="([^"]*)"/)?.[1]?.split(" ") ?? [];
      expect(buttonClasses).toContain("size-4");
      expect(buttonClasses).not.toContain("h-6");
      expect(buttonClasses).not.toContain("w-6");
    }
    const toggleTag = markup.match(
      /<div data-workspace-mode-toggle=""[^>]*>/,
    )?.[0];
    expect(toggleTag).toContain("gap-2");
    const codeButtonClasses =
      markup
        .match(/<button[^>]*data-workspace-mode="code"[^>]*>/)?.[0]
        ?.match(/class="([^"]*)"/)?.[1]
        ?.split(" ") ?? [];
    const designButtonClasses =
      markup
        .match(/<button[^>]*data-workspace-mode="design"[^>]*>/)?.[0]
        ?.match(/class="([^"]*)"/)?.[1]
        ?.split(" ") ?? [];
    expect(codeButtonClasses).toContain("text-fg1");
    expect(codeButtonClasses).not.toContain("bg-bg2-hover");
    expect(designButtonClasses).toContain("text-fg3");
  });

  it("keeps the selected mode fully visible while the switch settles", () => {
    const markup = renderToggle({ mode: "design", switching: true });

    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('data-workspace-mode="design"');
    expect(markup).not.toMatch(/<button[^>]*\sdisabled(?:=|>)/);
  });

  it("turns Design into an explicit creation menu when no document exists", () => {
    const markup = renderToggle({
      createDesignDirectory: {
        state: "ready",
        directory: "Odocs - Design",
        onConfirm: vi.fn(),
      },
    });

    expect(CREATE_DESIGN_DIRECTORY_LABEL).toBe("Create design directory");
    expect(markup).toContain('data-workspace-mode-create=""');
    expect(markup).toContain('aria-haspopup="menu"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup.match(/<button/g)).toHaveLength(2);
  });

  it("keeps an unknown Design target behind the non-mutating menu", () => {
    const markup = renderToggle({
      createDesignDirectory: { state: "loading" },
    });

    expect(markup).toContain('data-workspace-mode-create=""');
    expect(markup).toContain('aria-haspopup="menu"');
  });
});

describe("workspace mode header row", () => {
  it("anchors the toggle first and labels the active Design directory", () => {
    const markup = renderToStaticMarkup(
      createElement(
        TooltipProvider,
        null,
        createElement(WorkspaceModeHeaderView, {
          designDirectoryName: "Odocs - Design",
          mode: "design",
          disabled: false,
          switching: false,
          onModeChange: vi.fn(),
        }),
      ),
    );

    const toggle = markup.indexOf('data-workspace-mode-toggle=""');
    const directoryName = markup.indexOf('data-design-directory-name=""');

    expect(markup).toContain(">Odocs - Design</span>");
    expect(markup).not.toContain(">Cream</span>");
    expect(markup).toContain('data-workspace-mode-toggle=""');
    expect(directoryName).toBeGreaterThan(toggle);
    expect(markup.match(/<button/g)).toHaveLength(2);

    const headerTag = markup.match(
      /<div data-workspace-mode-header=""[^>]*>/,
    )?.[0];
    expect(headerTag).toContain("pl-2");
    expect(classList(chatTabsSource, "CHAT_STRIP_LEADING_CLS")).toContain(
      "pl-2",
    );
  });

  it("supports the shared separator and a trailing control", () => {
    const markup = renderToStaticMarkup(
      createElement(
        TooltipProvider,
        null,
        createElement(WorkspaceModeHeaderView, {
          designDirectoryName: "Odocs - Design",
          mode: "code",
          disabled: false,
          switching: false,
          separator: true,
          trailing: createElement("span", null, "collapse-control"),
          onModeChange: vi.fn(),
        }),
      ),
    );

    expect(markup).toContain("border-b");
    expect(markup).toContain('data-workspace-mode-header-trailing=""');
    expect(markup).toContain("collapse-control");
  });

  it("is Design's Layers header only — Code owns no such row", () => {
    const designHeader = designSidebarSource.indexOf("<WorkspaceModeHeader");
    const designPanels = designSidebarSource.indexOf(
      "<DesignWorkspaceSidebarPanels",
    );

    expect(designHeader).toBeGreaterThanOrEqual(0);
    expect(designHeader).toBeLessThan(designPanels);
    expect(designSidebarSource).toContain("separator");
    // Code's conversation column dropped the row on 2026-09-01: no name row, no
    // 40px band above the chat strip.
    expect(conversationPaneSource).not.toContain("<WorkspaceModeHeader");
    expect(conversationPaneSource).not.toContain("WorkspaceModeHeader }");
  });
});

describe("Code seats its column controls in the chat strip", () => {
  it("hands the mode toggle to the strip's fixed leading slot", () => {
    expect(conversationPaneSource).toContain(
      "stripLeading={<WorkspaceModeToggle workspace={workspace} />}",
    );
    // The pane tree is the only consumer, so the toggle rides the strip rather
    // than any surviving row of its own.
    const leadingProp = conversationPaneSource.indexOf("stripLeading=");
    const layoutTag = conversationPaneSource.indexOf("<ConversationPaneLayout");
    expect(layoutTag).toBeGreaterThanOrEqual(0);
    expect(leadingProp).toBeGreaterThan(layoutTag);
  });

  it("keeps the collapsed-workbench control in the strip's trailing slot", () => {
    expect(conversationPaneSource).toContain("<WorkbenchToggleButton");
    expect(conversationPaneSource).toMatch(
      /stripTrailing=\{\s*workbenchCollapsed && onToggleWorkbench \? \(/,
    );
    // Ownership stays with the column (the strip is a dumb slot host).
    expect(paneLayoutSource).not.toContain("<WorkbenchToggleButton");
    expect(chatTabsSource).not.toContain("<WorkbenchToggleButton");
  });

  it("gives each control to exactly one pane, at the corner it belongs to", () => {
    expect(paneLayoutSource).toContain(
      "const stripLeading = isFirstPane ? ctx.stripLeading : null;",
    );
    expect(paneLayoutSource).toContain(
      "paneId === topRightLeafId(ctx.layout.root) ? ctx.stripTrailing : null",
    );
    expect(paneLayoutSource).toContain("leading={stripLeading}");
    expect(paneLayoutSource).toContain("trailing={stripTrailing}");
  });

  it("orders the strip: toggle, tabs, +, history, pane menu, expand", () => {
    const leadingSlot = chatTabsSource.indexOf("CHAT_STRIP_LEADING_CLS}");
    const tabViewport = chatTabsSource.indexOf("TAB_VIEWPORT_CLS}");
    const plusSlot = chatTabsSource.indexOf("PLUS_CONTROL_CLS}");
    const historySlot = chatTabsSource.indexOf("HISTORY_CONTROL_CLS}");
    const paneMenuSlot = chatTabsSource.indexOf("PANE_MENU_CONTROL_CLS}");
    const trailingSlot = chatTabsSource.indexOf("CHAT_STRIP_TRAILING_CLS}");

    // The mode toggle leads; history was moved (2026-09-01) from the strip's
    // left edge to the right end, immediately before the "⋯" pane menu, so the
    // pane's two menu controls cluster instead of straddling the tabs.
    expect(leadingSlot).toBeGreaterThanOrEqual(0);
    for (const [earlier, later] of [
      [leadingSlot, tabViewport],
      [tabViewport, plusSlot],
      [plusSlot, historySlot],
      [historySlot, paneMenuSlot],
      // Trailing is last, so the expand control holds the window's right edge.
      [paneMenuSlot, trailingSlot],
    ]) {
      expect(earlier).toBeLessThan(later);
    }
    // Both slots are shrink-0 siblings of the viewport, never inside it, so
    // scrolling the tabs cannot move them.
    for (const cls of ["CHAT_STRIP_LEADING_CLS", "CHAT_STRIP_TRAILING_CLS"]) {
      const classes = classList(chatTabsSource, cls);
      expect(classes).toContain("shrink-0");
      expect(classes).toContain("h-full");
    }
  });

  it("shares Workbench's band height so the expand control never shifts", () => {
    // The expand control lives in the chat strip while the panel is collapsed
    // and in Workbench's header while it is open. Both rows start at the same y
    // (they are their columns' first rows) and both center their content, so
    // equal heights are the whole reason the icon holds one position. At h-11
    // vs h-10 it sat 2px lower when collapsed.
    const stripHeight = bandHeight(chatTabsSource, "CHAT_STRIP_SHELL_CLS");
    const workbenchHeight = bandHeight(
      workbenchPaneSource,
      "WORKBENCH_HEADER_CLS",
    );

    expect(stripHeight).toBe("h-10");
    expect(workbenchHeight).toBe("h-10");
    expect(stripHeight).toBe(workbenchHeight);

    // Same trailing gutter on both, so the icon's x matches too.
    expect(classList(chatTabsSource, "CHAT_STRIP_TRAILING_CLS")).toContain(
      "pr-2",
    );
    expect(classList(workbenchPaneSource, "WORKBENCH_HEADER_CLS")).toContain(
      "pr-2",
    );
  });

  it("keeps both column controls at full brightness in an unfocused pane", () => {
    // ChatPane washes every pane that isn't the focused window with bg-bg0/30 at
    // z-30, covering its strip. That must keep dimming the PANE's own chrome —
    // its tabs, history, "+", "⋯" — but not these two, which act on the whole
    // workspace/column and only borrow a corner of one pane's strip. Without the
    // lift, opening a split left the mode toggle looking unavailable whenever
    // the top-left pane wasn't focused (measured: glyph peak 240 → 171).
    const veil = paneLayoutSource.match(
      /className="bg-bg0\/30 pointer-events-none absolute inset-0 z-(\d+)"/,
    )?.[1];
    expect(veil).toBe("30");

    for (const cls of ["CHAT_STRIP_LEADING_CLS", "CHAT_STRIP_TRAILING_CLS"]) {
      const classes = classList(chatTabsSource, cls);
      expect(classes).toContain("z-40");
      // z-index needs a positioned element to apply at all.
      expect(classes).toContain("relative");
      expect(Number(veil)).toBeLessThan(40);
    }

    // The pane's OWN strip controls stay under the veil — that dimming is the
    // point of the unfocused-window treatment.
    for (const cls of ["HISTORY_CONTROL_CLS", "PANE_MENU_CONTROL_CLS"]) {
      expect(classString(chatTabsSource, cls)).not.toMatch(/\bz-\d+\b/);
    }
  });

  it("keeps the no-workspace placeholder band carrying the same slots", () => {
    // Without this the toggle disappears (and the band's height jumps) on any
    // destination that has not resolved a workspace yet.
    expect(paneLayoutSource).toContain('data-chat-strip-leading=""');
    expect(paneLayoutSource).toContain('data-chat-strip-trailing=""');
    expect(paneLayoutSource).toContain("CHAT_STRIP_LEADING_CLS");
    expect(paneLayoutSource).toContain("CHAT_STRIP_TRAILING_CLS");
    // It consumes the strip's own shell class rather than restating the height,
    // which is how the two bands drifted apart in the first place.
    expect(paneLayoutSource).toContain(
      "className={CHAT_STRIP_SHELL_CLS} data-tauri-drag-region",
    );
    expect(paneLayoutSource).not.toMatch(/const STRIP_SHELL_CLS =/);
  });
});
