// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesignLintViolationWire } from "../../../platform/git";
import { DesignFrameLintBadge, DesignFrameLintList } from "../design-frame-lint-badge";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const at = (ruleId: string, line: number, extra: Partial<DesignLintViolationWire> = {}): DesignLintViolationWire => ({
  ruleId, severity: "warning", message: `${ruleId} at ${line}`, file: "home.html", line, column: 1, ...extra,
});

let host: HTMLDivElement | null = null;
afterEach(() => {
  host?.remove();
  host = null;
});

const markup = (element: ReturnType<typeof createElement>) => {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(element));
  const html = container.innerHTML;
  act(() => root.unmount());
  return html;
};

describe("a frame's findings on its title", () => {
  it("shows nothing on a frame without findings", () => {
    expect(markup(createElement(DesignFrameLintBadge, { title: "Home", violations: [], onSelectLayer: () => {} }))).toBe("");
  });

  it("counts the frame's findings and says how many are errors", () => {
    const warnings = markup(createElement(DesignFrameLintBadge, {
      title: "Home", violations: [at("contrast", 2), at("overflow", 3)], onSelectLayer: () => {},
    }));
    expect(warnings).toContain("data-design-frame-lint=\"\"");
    expect(warnings).toContain("data-severity=\"warning\"");
    expect(warnings).toContain("aria-label=\"2 warnings to review in Home\"");
    expect(warnings).toContain(">2</span>");
    const mixed = markup(createElement(DesignFrameLintBadge, {
      title: "Home", violations: [at("no-script", 1, { severity: "error" }), at("contrast", 2)], onSelectLayer: () => {},
    }));
    expect(mixed).toContain("data-severity=\"error\"");
    expect(mixed).toContain("aria-label=\"1 error and 1 warning to review in Home\"");
  });

  it("lists each rule with its findings in line order, and a finding on a layer selects it", () => {
    host = document.createElement("div");
    document.body.append(host);
    const onSelectLayer = vi.fn();
    const root = createRoot(host);
    act(() => root.render(createElement(DesignFrameLintList, {
      violations: [at("contrast", 9, { oid: "late" }), at("overflow", 4), at("contrast", 2, { oid: "early" })],
      onSelectLayer,
    })));
    const groups = [...host.querySelectorAll("[data-design-frame-lint-group]")];
    expect(groups.map((group) => group.getAttribute("data-design-frame-lint-group"))).toEqual(["contrast", "overflow"]);
    expect(groups[0]!.textContent).toContain("Text contrast");
    const rows = [...groups[0]!.querySelectorAll("[data-design-frame-lint-finding]")];
    expect(rows.map((row) => row.textContent)).toEqual(["contrast at 2Line 2", "contrast at 9Line 9"]);
    // A finding without a layer is not a button: there is nothing to select.
    expect(groups[1]!.querySelector("button")).toBeNull();
    act(() => (rows[1] as HTMLButtonElement).click());
    expect(onSelectLayer).toHaveBeenCalledWith("late");
    act(() => root.unmount());
  });

  it("bounds a long rule to its first findings and says how many more there are", () => {
    host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(createElement(DesignFrameLintList, {
      violations: Array.from({ length: 30 }, (_, index) => at("spacing-scale", index + 1)),
      onSelectLayer: () => {},
    })));
    expect(host.querySelectorAll("[data-design-frame-lint-finding]")).toHaveLength(20);
    expect(host.textContent).toContain("10 more");
    act(() => root.unmount());
  });

  it("keeps pointer, double-click, menu and drop events in the open list from reaching the frame underneath", () => {
    host = document.createElement("div");
    document.body.append(host);
    const frame = vi.fn();
    const onSelectLayer = vi.fn();
    const root = createRoot(host);
    act(() => root.render(createElement("article", {
      onDoubleClick: frame, onPointerMove: frame, onContextMenu: frame, onDragOver: frame, onDrop: frame,
    }, createElement(DesignFrameLintBadge, { title: "Home", violations: [at("contrast", 2, { oid: "a" })], onSelectLayer }))));
    act(() => (host!.querySelector("[data-design-frame-lint]") as HTMLButtonElement).click());
    const row = document.querySelector("[data-design-frame-lint-finding]") as HTMLButtonElement;
    expect(row).not.toBeNull();
    for (const type of ["dblclick", "pointermove", "contextmenu", "dragover", "drop"])
      act(() => { row.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true })); });
    expect(frame).not.toHaveBeenCalled();
    act(() => row.click());
    expect(onSelectLayer).toHaveBeenCalledWith("a");
    act(() => root.unmount());
  });

  it("is drawn beside every frame's title from the page's lint report", () => {
    const canvasSource = readFileSync(resolve(process.cwd(), "apps/desktop/src/renderer/features/design-workspace/design-canvas.tsx"), "utf8");
    expect(canvasSource).toContain("designLintFindingsByFrame(snapshot?.lint.violations");
    expect(canvasSource).toMatch(/<DesignFrameLintBadge\s/);
  });
});
