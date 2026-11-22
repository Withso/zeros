import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { designComponentRecordWithinLimits, DESIGN_COMPONENT_BINDINGS_LIMITS, designFrameComponentSchema } from "@zeros/protocol/design-catalog";
import { designComponentSummaryOf } from "../component-template";

const FIXTURES = resolve(__dirname, "fixtures/demo-components");
const bindingsOf = (source: string) => designComponentSummaryOf(source)?.bindings;
const main = (options: string, head: string, body: string) =>
  `<!doctype html><html><head><template data-zd-options>${options}</template><style>${head}</style></head><body>${body}</body></html>`;

describe("the controls each layer of a main reads", () => {
  // Ten real components. The expected file was checked line by line against
  // the hand-derived table of what each layer reads (text, visible, attribute
  // holes, own-CSS declarations and attribute-gated rules); linked sheets are
  // the renderer's to complete.
  const expected = JSON.parse(readFileSync(resolve(FIXTURES, "expected-bindings.json"), "utf8")) as Record<string, unknown>;
  for (const file of readdirSync(FIXTURES).filter((name) => name.endsWith(".html"))) {
    it(`matches the reviewed table for ${file}`, () => {
      const summary = designComponentSummaryOf(readFileSync(resolve(FIXTURES, file), "utf8"))!;
      expect(summary.bindings).toEqual(expected[file]);
      expect(designFrameComponentSchema.safeParse(summary).success).toBe(true);
    });
  }

  it("names the main's one root, and no root for several conditional ones", () => {
    const read = (file: string) => bindingsOf(readFileSync(resolve(FIXTURES, file), "utf8"))!;
    expect(read("text-field.html").root).toBe("text-field");
    expect(read("text-field.html").layers["text-field"]!.styles).toEqual({ width: ["width"] });
    expect(read("badge.html").root).toBeUndefined();
  });

  it("leaves a layer nothing binds out, so it is not selectable", () => {
    const read = (file: string) => bindingsOf(readFileSync(resolve(FIXTURES, file), "utf8"))!.layers;
    for (const [file, oid] of [["alert.html", "alert-text"], ["data-table.html", "dtable-grid"], ["progress.html", "progress-head"],
      ["switch-row.html", "switch-row-text"], ["tabs.html", "tabs"], ["rating.html", "o-c4d21f051"]] as const)
      expect(Object.hasOwn(read(file), oid)).toBe(false);
  });

  it("attributes text inside a wrapping data-zd-if template to the nearest layer, as visible", () => {
    const layers = bindingsOf(readFileSync(resolve(FIXTURES, "progress.html"), "utf8"))!.layers;
    expect(layers["progress-ring-hole"]).toEqual({ text: ["value"], visible: ["show-value"] });
  });

  it("maps easing, derived and chained custom properties back to the options they reach", () => {
    const bindings = bindingsOf(main(
      `<zd-option name="press" type="easing" default="ease-out 120ms"></zd-option><zd-option name="size" type="number" default="4" unit="px"></zd-option>` +
        `<zd-derive name="double" value="size * 2" unit="px"></zd-derive>`,
      `.a { transition: transform var(--zd-press-duration) var(--zd-press-easing); --gap: var(--zd-double); }
       .b { padding: var(--gap); } .c { --x: var(--y); --y: var(--x); margin: var(--x); }`,
      `<div class="a" data-oid="a"><span class="b" data-oid="b"></span><i class="c" data-oid="c"></i></div>`))!;
    expect(bindings.layers.a!.styles).toEqual({ "--gap": ["size"], transition: ["press"] });
    expect(bindings.layers.b!.styles).toEqual({ padding: ["size"] });
    // A cycle reaches nothing and ends.
    expect(bindings.layers.c).toBeUndefined();
    expect(bindings.vars).toEqual({ "--gap": ["size"] });
  });

  it("binds a rule that tests an attribute a hole fills, and a class a hole fills by its prefix", () => {
    const bindings = bindingsOf(main(
      `<zd-option name="size" type="choice" choices="sm md" default="md"></zd-option><zd-option name="tone" type="choice" choices="a b" default="a"></zd-option>`,
      `.btn[data-size="sm"] { height: 30px; } .btn-a { color: red; } .other { color: blue; } :root .label { gap: 2px; } :root { --ink: black; }`,
      `<button class="btn btn-{{ tone }}" data-oid="btn" data-size="{{ size }}"><span class="label" data-oid="label">x</span></button>`))!;
    expect(bindings.root).toBe("btn");
    expect(bindings.layers.btn!.styles).toEqual({ color: ["tone"], height: ["size"] });
    expect(bindings.gates).toEqual({ class: ["tone"], "data-size": ["size"] });
    // The prefix tells the runtime which classes are the hole's.
    expect(bindings.classGates).toEqual({ "btn-": ["tone"] });
    expect(bindings.layers.label).toBeUndefined();
  });

  it("reads inline styles, ignores keyframe offsets, and lists the controls nothing reads", () => {
    const bindings = bindingsOf(main(
      `<zd-option name="w" type="number" default="1"></zd-option><zd-option name="idle" type="boolean" default="false"></zd-option>`,
      `@keyframes spin { from { opacity: var(--zd-w); } }`,
      `<div data-oid="box" style="width: var(--zd-w)"></div>`))!;
    expect(bindings.layers).toEqual({ box: { styles: { width: ["w"] } } });
    expect(bindings.unread).toEqual(["idle"]);
  });

  it("bounds every list while collecting, and never touches the declaration", () => {
    const layers = Array.from({ length: 300 }, (_, index) => `<p data-oid="l-${index}">{{ t }}</p>`).join("");
    const long = `<p data-oid="${"x".repeat(300)}">{{ t }}</p>`;
    const summary = designComponentSummaryOf(main(`<zd-option name="t" type="text" default="x"></zd-option>`, "", `<div>${layers}${long}</div>`))!;
    expect(Object.keys(summary.bindings!.layers)).toHaveLength(DESIGN_COMPONENT_BINDINGS_LIMITS.layers);
    expect(summary.bindings!.truncated).toBe(true);
    expect(summary.elements).toHaveLength(1);
    expect(summary.reach).toEqual({ t: "structure" });
    const record = designComponentRecordWithinLimits({ elements: summary.elements, reach: summary.reach, bindings: summary.bindings });
    expect("exceeds" in record).toBe(false);
    expect(record.bindings).toEqual(summary.bindings);
  });

  it("keeps the whole record within its byte budget as sent, counting non-ASCII text in UTF-8", () => {
    // 256 layers of long non-ASCII names, each bound to several controls: far past the budget in bytes.
    const options = Array.from({ length: 8 }, (_, index) => `<zd-option name="o${index}" type="text" default="x"></zd-option>`).join("");
    const holes = Array.from({ length: 8 }, (_, index) => `{{ o${index} }}`).join("");
    const css = Array.from({ length: 16 }, (_, index) => `--é${"界".repeat(40)}${index}: var(--zd-o0);`).join(" ");
    const layers = Array.from({ length: 256 }, (_, index) => `<p data-oid="${"層".repeat(80)}-${index}" class="p">${holes}</p>`).join("");
    const bindings = bindingsOf(main(options, `.p { ${css} }`, `<div>${layers}</div>`))!;
    expect(new TextEncoder().encode(JSON.stringify(bindings)).length).toBeLessThanOrEqual(DESIGN_COMPONENT_BINDINGS_LIMITS.bytes);
    expect(bindings.truncated).toBe(true);
    expect(Object.keys(bindings.layers).length).toBeGreaterThan(0);
  });

  it("drops only bindings that still fail the record's schema, keeping the controls", () => {
    const record = designComponentRecordWithinLimits({ elements: [], reach: {}, bindings: { layers: { a: { text: [] } } } });
    expect("exceeds" in record).toBe(false);
    expect("bindings" in record).toBe(false);
  });
});
