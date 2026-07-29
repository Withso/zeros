import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

/** The literal class string assigned to a top-level `const NAME = "…"`. */
function classConstant(src: string, name: string): string {
  const match = new RegExp(`const ${name} =\\s*\\n?\\s*"([^"]*)"`).exec(src);
  if (!match) throw new Error(`${name} not found`);
  return match[1];
}

/** A component's body: `function NAME(` up to the next top-level declaration.
 *  Column-0 anchoring is what makes this safe — a destructured parameter list
 *  closes with `}` at column 0 too, and everything inside a body is indented. */
function component(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  const rest = src.slice(start + 1);
  const next = rest.search(/\n(?:function |interface |const |\/\*\*)/);
  return next < 0 ? src.slice(start) : src.slice(start, start + 1 + next);
}

/** The className on the span that renders `{label}` in a component body.
 *  Tolerates Prettier wrapping the child onto its own line — the invariant is
 *  about the class list, not about the span fitting in 80 columns. */
function labelSpanClass(body: string): string {
  const match = /<span className="([^"]*)">\s*\{label\}\s*<\/span>/.exec(body);
  if (!match) throw new Error("label span not found");
  return match[1];
}

const ANY_FONT_WEIGHT =
  /\bfont-(thin|light|normal|medium|semibold|bold|black)\b/;

// A workspace tab is rendered by TWO components across the create lifecycle:
// PendingWorkspaceTab while `workspace.create` is in flight, then WorkspaceTab
// once the authoritative row lands. The real tab wraps its label in <Button>,
// whose `buttonVariants` base carries `font-medium`; the placeholder is a bare
// div. So unless the shared container owns the weight, the branch name renders
// at 400 for the whole create and snaps to 500 at the swap — a visible thicken
// on a tab the user is already sitting in. These assertions pin the one
// arrangement in which the two agree.
describe("workspace tab label weight", () => {
  it("declares the weight once, on the container both tabs share", () => {
    const topBar = source("src/shell/top-bar.tsx");

    expect(classConstant(topBar, "WORKSPACE_TAB_CLS")).toMatch(
      /\bfont-medium\b/,
    );
  });

  it("lets the open Button inherit rather than restate a weight", () => {
    const topBar = source("src/shell/top-bar.tsx");

    // Any `font-*` here would win via tailwind-merge (cva appends className
    // last), re-opening the gap between the real tab and the placeholder.
    expect(classConstant(topBar, "WORKSPACE_OPEN_BUTTON_CLS")).not.toMatch(
      ANY_FONT_WEIGHT,
    );
  });

  it("renders both tab variants from that same container class", () => {
    const topBar = source("src/shell/top-bar.tsx");

    expect(component(topBar, "WorkspaceTab")).toContain(
      "className={WORKSPACE_TAB_CLS}",
    );
    expect(component(topBar, "PendingWorkspaceTab")).toContain(
      "className={WORKSPACE_TAB_CLS}",
    );
  });

  it("keeps every label span free of its own font utility", () => {
    const topBar = source("src/shell/top-bar.tsx");

    // Both label spans must inherit from the container. A `font-*` on either
    // one is exactly the drift this suite exists to catch.
    expect(labelSpanClass(component(topBar, "WorkspaceTab"))).not.toMatch(
      ANY_FONT_WEIGHT,
    );
    expect(
      labelSpanClass(component(topBar, "PendingWorkspaceTab")),
    ).not.toMatch(ANY_FONT_WEIGHT);
  });

  it("matches the chat strip, which owns its tab weight the same way", () => {
    // column2-chat-tabs.tsx has never shown this snap because TAB_BASE_CLS and
    // the synthetic TAB_UNTITLED_CLS placeholder both carry the weight.
    const chatTabs = source("src/shell/column2-chat-tabs.tsx");

    expect(classConstant(chatTabs, "TAB_BASE_CLS")).toMatch(/\bfont-medium\b/);
    expect(classConstant(chatTabs, "TAB_UNTITLED_CLS")).toMatch(
      /\bfont-medium\b/,
    );
  });
});
