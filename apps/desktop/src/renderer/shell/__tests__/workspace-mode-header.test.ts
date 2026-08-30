import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "../../shared/ui/primitives/tooltip";
import { WorkspaceModeHeaderView } from "../../shared/ui/workspace-mode-header";

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

describe("workspace mode header", () => {
  it("shows the workspace name beside two icon-only mode choices", () => {
    const markup = renderToStaticMarkup(
      createElement(
        TooltipProvider,
        null,
        createElement(WorkspaceModeHeaderView, {
          workspaceName: "Cream",
          mode: "code",
          disabled: false,
          switching: false,
          onModeChange: vi.fn(),
        }),
      ),
    );

    expect(markup).toContain(">Cream</span>");
    expect(markup.match(/<button/g)).toHaveLength(2);
    expect(markup).toContain('aria-label="Code mode"');
    expect(markup).toContain('aria-label="Design mode"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).toContain('class="lucide lucide-code-xml size-4"');
    expect(markup).toContain('class="lucide lucide-pen-tool size-4"');
    expect(markup).toContain("p-1");
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
    const codeButtonTag = markup.match(
      /<button[^>]*data-workspace-mode="code"[^>]*>/,
    )?.[0];
    const designButtonTag = markup.match(
      /<button[^>]*data-workspace-mode="design"[^>]*>/,
    )?.[0];
    const codeButtonClasses =
      codeButtonTag?.match(/class="([^"]*)"/)?.[1]?.split(" ") ?? [];
    const designButtonClasses =
      designButtonTag?.match(/class="([^"]*)"/)?.[1]?.split(" ") ?? [];
    expect(codeButtonClasses).toContain("text-fg1");
    expect(codeButtonClasses).not.toContain("bg-bg2-hover");
    expect(designButtonClasses).toContain("text-fg3");
    expect(markup).not.toContain(">Code</button>");
    expect(markup).not.toContain(">Design</button>");
  });

  it("keeps the selected mode fully visible while the switch settles", () => {
    const markup = renderToStaticMarkup(
      createElement(
        TooltipProvider,
        null,
        createElement(WorkspaceModeHeaderView, {
          workspaceName: "Cream",
          mode: "design",
          disabled: false,
          switching: true,
          onModeChange: vi.fn(),
        }),
      ),
    );

    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('data-workspace-mode="design"');
    expect(markup).not.toMatch(/<button[^>]*\sdisabled(?:=|>)/);
  });

  it("supports the shared separator and Code's trailing collapse control", () => {
    const markup = renderToStaticMarkup(
      createElement(
        TooltipProvider,
        null,
        createElement(WorkspaceModeHeaderView, {
          workspaceName: "Cream",
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

  it("mounts the shared row above both the chat strip and Layers", () => {
    const conversationHeader = conversationPaneSource.indexOf(
      "<WorkspaceModeHeader",
    );
    const conversationBody = conversationPaneSource.indexOf(
      "<div className={BODY_BASE_CLS}>",
    );
    const designHeader = designSidebarSource.indexOf("<WorkspaceModeHeader");
    const designPanels = designSidebarSource.indexOf(
      "<DesignWorkspaceSidebarPanels",
    );

    expect(conversationHeader).toBeGreaterThanOrEqual(0);
    expect(conversationHeader).toBeLessThan(conversationBody);
    expect(conversationPaneSource).toMatch(
      /<WorkspaceModeHeader\s+workspace=\{workspace\}\s+separator/,
    );
    expect(designHeader).toBeGreaterThanOrEqual(0);
    expect(designHeader).toBeLessThan(designPanels);
    expect(designSidebarSource).toContain("separator");
  });

  it("keeps the collapsed-workbench control in the workspace row", () => {
    expect(conversationPaneSource).toContain("<WorkbenchToggleButton");
    expect(conversationPaneSource).toContain("trailing={");
    expect(paneLayoutSource).not.toContain("<WorkbenchToggleButton");
  });
});
