import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { DESIGN_RECORDER_FLATTEN_SOURCE, DESIGN_RECORDER_PREPARE_SCRIPT } from "../design-recorder-scripts";

type Box = { overflowX: string; overflowY: string; display: string; scrollHeight: number; clientHeight: number; scrollWidth: number; clientWidth: number };
function element(box: Partial<Box>, children: unknown[] = [], shadow?: unknown[]) {
  const style = new Map<string, string>();
  const value = { overflowX: "visible", overflowY: "visible", display: "block", scrollHeight: 10, clientHeight: 10, scrollWidth: 10, clientWidth: 10, ...box };
  const self: Record<string, unknown> = {
    ...value, computed: value, children, style: { setProperty: (name: string, v: string) => style.set(name, v), get: (name: string) => style.get(name) },
    shadowRoot: shadow ? { querySelectorAll: () => flat(shadow) } : null,
  };
  return self;
}
const flat = (nodes: unknown[]): unknown[] => nodes.flatMap((node) => [node, ...flat((node as { children: unknown[] }).children)]);

describe("Design recorder scripts", () => {
  it("clips only overflowing scroll containers, keeps their formatting context, and reaches open shadow roots", () => {
    const listed = element({ overflowY: "auto", scrollHeight: 900, clientHeight: 300 });
    const fits = element({ overflowY: "auto" });
    const hidden = element({ overflowY: "hidden", scrollHeight: 900, clientHeight: 300 });
    const flex = element({ overflowX: "scroll", overflowY: "visible", display: "flex", scrollWidth: 2000, clientWidth: 400 });
    const shadowed = element({ overflowY: "scroll", scrollHeight: 500, clientHeight: 100 });
    const host = element({}, [], [shadowed]);
    const html = element({ overflowY: "auto", scrollHeight: 5000, clientHeight: 900 });
    const body = element({ overflowY: "auto", scrollHeight: 5000, clientHeight: 900 });
    const all = [listed, fits, hidden, flex, host];
    const document = { documentElement: html, body, querySelectorAll: () => [html, body, ...flat(all)] };
    const converted = runInNewContext(`${DESIGN_RECORDER_FLATTEN_SOURCE}; flattenDesignScrollers()`, {
      document, getComputedStyle: (el: { computed: Box }) => el.computed,
    });
    expect(converted).toBe(3);
    const styles = (el: Record<string, unknown>) => ["display", "overflow-x", "overflow-y"].map((name) => (el.style as { get(n: string): string | undefined }).get(name) ?? "-");
    expect(styles(listed)).toEqual(["flow-root", "-", "clip"]);
    expect(styles(flex)).toEqual(["-", "clip", "-"]);
    expect(styles(shadowed)).toEqual(["flow-root", "-", "clip"]);
    for (const untouched of [fits, hidden, html, body]) expect(styles(untouched)).toEqual(["-", "-", "-"]);
  });

  it("is one expression that embeds the flatten function", () => {
    expect(DESIGN_RECORDER_PREPARE_SCRIPT).toContain("function flattenDesignScrollers()");
    expect(DESIGN_RECORDER_PREPARE_SCRIPT).not.toContain("${");
    expect(() => new Function(`return ${DESIGN_RECORDER_PREPARE_SCRIPT}`)).not.toThrow();
  });
});
