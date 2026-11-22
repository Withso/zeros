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

  it("gives each arm of a selector list its own gates, and shares what a value reads", () => {
    const bindings = bindingsOf(main(
      `<zd-option name="tone" type="choice" choices="info danger" default="info"></zd-option><zd-option name="ink" type="color" default="red"></zd-option>`,
      `.badge[data-tone="danger"], .caption { opacity: .7; } .badge, .caption { color: var(--zd-ink); }`,
      `<div data-oid="root"><span class="badge" data-oid="badge" data-tone="{{ tone }}">x</span><p class="caption" data-oid="caption">c</p></div>`))!;
    expect(bindings.layers.badge!.styles).toEqual({ color: ["ink"], opacity: ["tone"] });
    expect(bindings.layers.caption!.styles).toEqual({ color: ["ink"] });
  });

  it("counts a gate inside :not() as what a rule depends on, without matching the negated layer", () => {
    const bindings = bindingsOf(main(
      `<zd-option name="tone" type="choice" choices="info danger" default="info"></zd-option>`,
      `.badge:not([data-tone="danger"]) { opacity: .5; } .other:not(.badge) { color: red; }`,
      `<div data-oid="root"><span class="badge" data-oid="badge" data-tone="{{ tone }}">x</span><p class="other" data-oid="other">o</p></div>`))!;
    expect(bindings.layers.badge!.styles).toEqual({ opacity: ["tone"] });
    expect(bindings.layers.other).toBeUndefined();
  });

  it("excludes a layer only by a :not() it fully understands", () => {
    const bindings = bindingsOf(main(
      `<zd-option name="w" type="number" default="1"></zd-option>`,
      `.card:not(.card:hover) { width: var(--zd-w); } .card:not(.card) { height: var(--zd-w); }`,
      `<div data-oid="root"><div class="card" data-oid="card">c</div></div>`))!;
    // :hover was dropped from the negated compound, so it may not match: keep the layer.
    expect(bindings.layers.card!.styles).toEqual({ width: ["w"] });
  });

  it("excludes a layer by :not() on an attribute it holds as a fixed value, never on one a hole fills", () => {
    const bindings = bindingsOf(main(
      `<zd-option name="w" type="number" default="1"></zd-option><zd-option name="k" type="text" default="a"></zd-option>`,
      `.card:not([data-kind="fixed"]) { width: var(--zd-w); }`,
      `<div class="card" data-oid="fixed" data-kind="fixed">f</div><div class="card" data-oid="filled" data-kind="{{ k }}">h</div><div class="card" data-oid="bare">b</div>`))!;
    expect(bindings.layers.fixed).toBeUndefined();
    // data-kind is a gate (a hole fills it), so the rule depends on K as well.
    expect(bindings.layers.filled!.styles).toEqual({ width: ["k", "w"] });
    expect(bindings.layers.bare!.styles).toEqual({ width: ["k", "w"] });
  });

  it("never excludes the root by a class test: an instance adds its host's classes to the root", () => {
    const bindings = bindingsOf(main(
      `<zd-option name="w" type="number" default="1"></zd-option>`,
      `.card:not([class="card"]) { width: var(--zd-w); } .card:not(.card) { height: var(--zd-w); } .inner:not(.inner) { gap: var(--zd-w); }`,
      `<div class="card" data-oid="card"><span class="inner" data-oid="inner">i</span></div>`))!;
    expect(bindings.root).toBe("card");
    expect(bindings.layers.card!.styles).toEqual({ height: ["w"], width: ["w"] });
    // An inner layer's classes are its own: .inner:not(.inner) still excludes it.
    expect(bindings.layers.inner).toBeUndefined();
  });

  it("evaluates attribute operators on layer identity, keeping the layer when an operator is unknown", () => {
    const bindings = bindingsOf(main(
      `<zd-option name="w" type="number" default="1"></zd-option>`,
      `[data-oid^="card-"] { width: var(--zd-w); } [data-oid$="-x"] { height: var(--zd-w); } [data-oid*="ar"] { gap: var(--zd-w); }
       [data-oid~="card-a"] { padding: var(--zd-w); } [data-oid|="card"] { margin: var(--zd-w); } [data-oid="CARD-A" i] { opacity: var(--zd-w); }`,
      `<div data-oid="card-a">a</div><div data-oid="other">o</div>`))!;
    expect(bindings.layers["card-a"]!.styles).toEqual({ gap: ["w"], margin: ["w"], opacity: ["w"], padding: ["w"], width: ["w"] });
    expect(bindings.layers.other).toBeUndefined();
  });

  it("resolves custom properties whatever order they are declared in, and marks a chain cut short", () => {
    const ordered = bindingsOf(main(
      `<zd-option name="w" type="number" default="1"></zd-option>`,
      `.box { width: var(--a); } :root { --a: var(--b); } :root { --b: var(--zd-w); }`,
      `<div class="box" data-oid="box">b</div>`))!;
    expect(ordered.layers.box!.styles!.width).toEqual(["w"]);
    expect(ordered.truncated).toBeUndefined();
    // A chain of any depth resolves.
    const chain = Array.from({ length: 12 }, (_, index) => `--v${index}: var(--v${index + 1});`).join(" ");
    const deep = bindingsOf(main(
      `<zd-option name="w" type="number" default="1"></zd-option>`,
      `:root { ${chain} --v12: var(--zd-w); } .box { width: var(--v0); } .near { height: var(--v10); }`,
      `<div class="box" data-oid="box">b</div><div class="near" data-oid="near">n</div>`))!;
    expect(deep.layers.box!.styles!.width).toEqual(["w"]);
    expect(deep.layers.near!.styles!.height).toEqual(["w"]);
    expect(deep.truncated).toBeUndefined();
  });

  it("resolves a wide fan-out of custom properties once each, in bounded time", () => {
    // 16 levels of 7 properties, each reading all 7 of the next level.
    const levels = Array.from({ length: 16 }, (_, level) => Array.from({ length: 7 }, (_, index) =>
      `--l${level}-${index}: ${level === 15 ? "var(--zd-w)" : Array.from({ length: 7 }, (_, next) => `var(--l${level + 1}-${next})`).join(" ")};`).join(" ")).join(" ");
    const started = performance.now();
    const bindings = bindingsOf(main(`<zd-option name="w" type="number" default="1"></zd-option>`,
      `:root { ${levels} } .box { width: var(--l0-3); }`, `<div class="box" data-oid="box">b</div><div data-oid="other">o</div>`))!;
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(bindings.layers.box!.styles).toEqual({ width: ["w"] });
    // 112 properties reach Width; the record lists at most its vars limit of them.
    expect(Object.keys(bindings.vars!)).toHaveLength(64);
  });

  it("binds every control to a custom property past the graph's caps, and says the record was cut", () => {
    const many = Array.from({ length: 1100 }, (_, index) => `--m${index}: var(--m${index + 1});`).join(" ");
    const bindings = bindingsOf(main(
      `<zd-option name="w" type="number" default="1"></zd-option><zd-option name="tone" type="choice" choices="a b" default="a"></zd-option>`,
      `:root { ${many} } .box { width: var(--m0); } .plain { height: var(--not-declared-here); }`,
      `<div class="box" data-oid="box">b</div><div class="plain" data-oid="plain">p</div><span data-oid="t">{{ tone }}</span>`))!;
    expect(bindings.truncated).toBe(true);
    // Bound by that guess only: kept apart from what is known, so a fence can
    // refuse a write while nothing destructive rests on it.
    expect(bindings.layers.box).toEqual({ assumed: { width: ["tone", "w"] } });
    expect(Object.keys(bindings.assumedVars!)).toHaveLength(64);
    expect(bindings.vars).toBeUndefined();
    // A property the main's CSS does not declare (a token) is not one of its own.
    expect(bindings.layers.plain).toBeUndefined();
  });

  it("reads a main that holds a template with no template content, as SVG metadata does", () => {
    const bindings = bindingsOf(main(`<zd-option name="t" type="text" default="x"></zd-option>`, "",
      `<div data-oid="root"><svg data-oid="art"><metadata><template>m</template></metadata></svg><p data-oid="p">{{ t }}</p></div>`))!;
    expect(bindings.layers.p!.text).toEqual(["t"]);
  });

  it("scans template holes in time linear in the source, unclosed ones included", () => {
    const flood = "{{ ".repeat(200_000);
    const started = performance.now();
    const bindings = bindingsOf(main(`<zd-option name="t" type="text" default="x"></zd-option>`, "",
      `<p data-oid="p" class="a {{ ${"{{".repeat(50_000)}">${flood}{{ t }}</p>`));
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(bindings?.unread).toEqual(["t"]);
  });

  it("reads inline styles, ignores keyframe offsets, and lists the controls nothing reads", () => {
    const bindings = bindingsOf(main(
      `<zd-option name="w" type="number" default="1"></zd-option><zd-option name="idle" type="boolean" default="false"></zd-option>`,
      `@keyframes spin { from { opacity: var(--zd-w); } }`,
      `<div data-oid="box" style="width: var(--zd-w)"></div>`))!;
    expect(bindings.layers).toEqual({ box: { styles: { width: ["w"] } } });
    expect(bindings.unread).toEqual(["idle"]);
  });

  it("keeps a layer's authored properties ahead of custom-property links under its styles cap", () => {
    const links = Array.from({ length: 20 }, (_, index) => `--link-${index}: var(--zd-ink);`).join(" ");
    const bindings = bindingsOf(main(`<zd-option name="ink" type="color" default="red"></zd-option>`,
      `.box { ${links} color: var(--zd-ink); }`, `<div data-oid="root"><div class="box" data-oid="box">b</div></div>`))!;
    const styles = bindings.layers.box!.styles!;
    expect(Object.keys(styles)).toHaveLength(16);
    expect(styles.color).toEqual(["ink"]);
    expect(bindings.truncated).toBe(true);
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
