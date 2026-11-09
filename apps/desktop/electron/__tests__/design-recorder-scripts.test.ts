import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { DESIGN_STATIC_RENDER_SCRIPT } from "@zeros/protocol/design-capture";
import { DESIGN_RECORDER_FLATTEN_SOURCE, DESIGN_RECORDER_PREPARE_SCRIPT, designRecorderRecordScript } from "../design-recorder-scripts";

type Box = { overflowX: string; overflowY: string; display: string; scrollHeight: number; clientHeight: number; scrollWidth: number; clientWidth: number; willChange: string; position: string };
function element(box: Partial<Box>, children: unknown[] = [], shadow?: unknown[]) {
  const style = new Map<string, string>();
  const value = { overflowX: "visible", overflowY: "visible", display: "block", scrollHeight: 10, clientHeight: 10, scrollWidth: 10, clientWidth: 10, willChange: "auto", position: "static", ...box };
  const self: Record<string, unknown> = {
    ...value, computed: value, children, style: { setProperty: (name: string, v: string) => style.set(name, v), get: (name: string) => style.get(name) },
    shadowRoot: shadow ? { querySelectorAll: () => flat(shadow) } : null,
    contains: (other: unknown) => flat(children).includes(other),
  };
  return self;
}
const flat = (nodes: unknown[]): unknown[] => nodes.flatMap((node) => [node, ...flat((node as { children: unknown[] }).children)]);

describe("Design recorder scripts", () => {
  it("stills, prepares and prints a frame in one evaluation, in that order", async () => {
    // Each evaluation was a round trip through the recorder's main process,
    // which drives every window.
    const log: string[] = [];
    let release!: () => void;
    const prepared = new Promise<void>((resolve) => { release = resolve; });
    const script = designRecorderRecordScript("/tmp/frame \"1\"", { still: "(log.push('still'), 'stilled')", prepare: "(log.push('prepare'), prepared)" });
    const done = runInNewContext(script, { log, prepared, chrome: { gpuBenchmarking: { printToSkPicture: (dir: string) => log.push(`print ${dir}`) } } }) as Promise<unknown>;
    await Promise.resolve();
    expect(log).toEqual(["still", "prepare"]);
    release();
    await done;
    expect(log).toEqual(["still", "prepare", "print /tmp/frame \"1\""]);
    // By default, exactly the scripts the recorder identity names.
    const real = designRecorderRecordScript("/tmp/f");
    expect(real.indexOf(DESIGN_STATIC_RENDER_SCRIPT)).toBeGreaterThan(-1);
    expect(real.indexOf(DESIGN_RECORDER_PREPARE_SCRIPT)).toBeGreaterThan(real.indexOf(DESIGN_STATIC_RENDER_SCRIPT));
  });

  it("clips only overflowing scroll containers, keeps their formatting context, and reaches open shadow roots", () => {
    const listed = element({ overflowY: "auto", scrollHeight: 900, clientHeight: 300 });
    const fits = element({ overflowY: "auto" });
    const hidden = element({ overflowY: "hidden", scrollHeight: 900, clientHeight: 300 });
    const quiet = element({ overflowX: "hidden", overflowY: "hidden" });
    const pane = element({ overflowX: "hidden", overflowY: "auto", scrollHeight: 1432, clientHeight: 884 });
    const flex = element({ overflowX: "scroll", overflowY: "visible", display: "flex", scrollWidth: 2000, clientWidth: 400 });
    const shadowed = element({ overflowY: "scroll", scrollHeight: 500, clientHeight: 100 });
    const host = element({}, [], [shadowed]);
    const html = element({ overflowY: "auto", scrollHeight: 5000, clientHeight: 900 });
    const body = element({ overflowY: "auto", scrollHeight: 5000, clientHeight: 900 });
    const all = [listed, fits, hidden, quiet, pane, flex, host];
    const document = { documentElement: html, body, querySelectorAll: () => [html, body, ...flat(all)] };
    const converted = runInNewContext(`${DESIGN_RECORDER_FLATTEN_SOURCE}; flattenDesignScrollers()`, {
      document, getComputedStyle: (el: { computed: Box }) => el.computed, innerHeight: 900, innerWidth: 1440,
    });
    expect(converted).toBe(7);
    const styles = (el: Record<string, unknown>) => ["display", "overflow-x", "overflow-y"].map((name) => (el.style as { get(n: string): string | undefined }).get(name) ?? "-");
    expect(styles(listed)).toEqual(["flow-root", "-", "clip"]);
    expect(styles(flex)).toEqual(["-", "clip", "-"]);
    expect(styles(shadowed)).toEqual(["flow-root", "-", "clip"]);
    // A user-scrollable container is clipped even when its content fits; hidden
    // overflow only when it outgrows the box. Every non-visible axis is clipped.
    expect(styles(fits)).toEqual(["flow-root", "-", "clip"]);
    expect(styles(hidden)).toEqual(["flow-root", "-", "clip"]);
    expect(styles(pane)).toEqual(["flow-root", "clip", "clip"]);
    expect(styles(quiet)).toEqual(["-", "-", "-"]);
    // The page overflows its viewport, so the page itself is clipped.
    expect((html.style as { get(n: string): string | undefined }).get("overflow")).toBe("clip");
    expect((body.style as { get(n: string): string | undefined }).get("overflow")).toBe("clip");
  });

  it("is one expression that embeds the flatten function", () => {
    expect(DESIGN_RECORDER_PREPARE_SCRIPT).toContain("function flattenDesignScrollers()");
    expect(DESIGN_RECORDER_PREPARE_SCRIPT).not.toContain("${");
    expect(() => new Function(`return ${DESIGN_RECORDER_PREPARE_SCRIPT}`)).not.toThrow();
  });

  it("drops a will-change hint but keeps its stacking context, unless it contains fixed elements", () => {
    const pinned = element({ position: "fixed" });
    const hinted = element({ willChange: "transform" });
    const container = element({ willChange: "transform" }, [pinned]);
    const html = element({}), body = element({});
    const document = { documentElement: html, body, querySelectorAll: () => [html, body, ...flat([hinted, container])] };
    runInNewContext(`${DESIGN_RECORDER_FLATTEN_SOURCE}; flattenDesignScrollers()`, { document, getComputedStyle: (el: { computed: Box }) => el.computed, innerHeight: 900, innerWidth: 1440 });
    const get = (el: Record<string, unknown>, name: string) => (el.style as { get(n: string): string | undefined }).get(name);
    expect([get(hinted, "will-change"), get(hinted, "isolation")]).toEqual(["auto", "isolate"]);
    expect([get(container, "will-change"), get(container, "isolation")]).toEqual([undefined, undefined]);
    expect(get(html, "overflow")).toBeUndefined();
  });
});
