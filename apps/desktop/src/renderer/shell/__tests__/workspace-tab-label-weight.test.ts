import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const WORKSPACE_ROW =
  "apps/desktop/src/renderer/shell/sidebar-workspace-row.tsx";

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
  const next = rest.search(/\n(?:export |function |interface |const |\/\*\*)/);
  return next < 0 ? src.slice(start) : src.slice(start, start + 1 + next);
}

/** Every class utility on the span that renders the visible `{label}`.
 *  Anchored on `>{label}<` (a text child, not a template-literal interpolation
 *  such as an aria-label) and walked back to that span's own opening tag. */
function labelSpanClass(body: string): string {
  const label = body.indexOf(">{label}<");
  const opener = label < 0 ? -1 : body.lastIndexOf("<span", label);
  if (opener < 0) throw new Error("label span not found");
  const literals = body.slice(opener, label).match(/"[^"]*"/g);
  if (!literals) throw new Error("label span className not found");
  return literals.map((literal) => literal.slice(1, -1)).join(" ");
}

const ANY_FONT_WEIGHT =
  /\bfont-(thin|light|normal|medium|semibold|bold|black)\b/;

// A workspace row is rendered by TWO components across the create lifecycle:
// PendingSidebarWorkspaceRow while `workspace.create` is in flight, then
// SidebarWorkspaceRow once the authoritative row lands. The real row has an
// open <Button>, whose `buttonVariants` base carries `font-medium`; the
// placeholder has none. Unless the shared container owns the weight, the name
// would change weight at the swap — a visible snap on a row the user is
// already sitting in. These assertions pin the one arrangement in which the
// two agree.
describe("sidebar workspace row label weight", () => {
  it("declares the weight once, on the container both rows share", () => {
    expect(
      classConstant(source(WORKSPACE_ROW), "SIDEBAR_WORKSPACE_ROW_CLS"),
    ).toMatch(ANY_FONT_WEIGHT);
  });

  it("lets the open Button inherit rather than restate a weight", () => {
    // Any `font-*` here would win via tailwind-merge (cva appends className
    // last), re-opening the gap between the real row and the placeholder.
    expect(
      classConstant(source(WORKSPACE_ROW), "SIDEBAR_WORKSPACE_OPEN_BUTTON_CLS"),
    ).not.toMatch(ANY_FONT_WEIGHT);
  });

  it("renders both row variants from that same container class", () => {
    const row = source(WORKSPACE_ROW);

    for (const name of ["SidebarWorkspaceRow", "PendingSidebarWorkspaceRow"]) {
      expect(component(row, name)).toMatch(
        /className=\{cn\(\s*SIDEBAR_WORKSPACE_ROW_CLS,/,
      );
    }
  });

  it("keeps every label span free of its own font utility", () => {
    const row = source(WORKSPACE_ROW);

    // Both label spans must inherit from the container. A `font-*` on either
    // one is exactly the drift this suite exists to catch.
    for (const name of ["SidebarWorkspaceRow", "PendingSidebarWorkspaceRow"]) {
      expect(labelSpanClass(component(row, name))).not.toMatch(ANY_FONT_WEIGHT);
    }
  });

  it("matches the chat strip, which owns its tab weight the same way", () => {
    // conversation/chat-tabs.tsx has never shown this snap because TAB_BASE_CLS and
    // the synthetic TAB_UNTITLED_CLS placeholder both carry the weight.
    const chatTabs = source(
      "apps/desktop/src/renderer/shell/conversation/chat-tabs.tsx",
    );

    expect(classConstant(chatTabs, "TAB_BASE_CLS")).toMatch(/\bfont-medium\b/);
    expect(classConstant(chatTabs, "TAB_UNTITLED_CLS")).toMatch(
      /\bfont-medium\b/,
    );
  });
});
