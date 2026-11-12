import { describe, expect, it } from "vitest";

import {
  COMPONENT_OPTION_LIMITS,
  componentOptionCss,
  componentOptionValues,
  parseComponentOptionValue,
  readComponentDeclaration,
  type ComponentDeclarationElement,
} from "../component-options";

const element = (tag: string, attributes: Record<string, string>, offset = 0): ComponentDeclarationElement => ({
  tag,
  attributes: Object.entries(attributes).map(([name, value]) => ({ name, value })),
  offset,
});
const option = (attributes: Record<string, string>, offset = 0) => element("zd-option", attributes, offset);

const COMPOSER = [
  option({ name: "width", type: "number", label: "Width", default: "1120", min: "640", max: "1440", step: "8", unit: "px" }),
  option({ name: "attachments", type: "number", label: "Attachments", default: "2", min: "0", max: "4", step: "1" }),
  option({ name: "mode", type: "choice", label: "Mode", choices: "ask plan", default: "ask" }),
  option({ name: "density", type: "choice", label: "Density", choices: "compact comfortable wide-open", default: "comfortable" }),
  option({ name: "toolbar", type: "boolean", label: "Toolbar", default: "true" }),
  option({ name: "accent", type: "color", label: "Accent", default: "var(--blue-primary)" }),
  option({ name: "send-radius", type: "number", label: "Corner radius", group: "Send button", default: "8", min: "0", max: "16", unit: "px" }),
  option({ name: "send-label", type: "text", label: "Label", group: "Send button", default: "Send" }),
  option({ name: "motion", type: "easing", label: "Easing", default: "spring(0.2) 150ms" }),
  element("zd-derive", { name: "gutter", value: "width >= 1200 ? 24 : 16", unit: "px" }),
  element("zd-variant", { name: "compact", width: "800", density: "compact" }),
  element("zd-variant", { name: "wide-plan", width: "1280", mode: "plan" }),
];

const read = (elements: ComponentDeclarationElement[]) => readComponentDeclaration(elements);
const problems = (elements: ComponentDeclarationElement[]) => read(elements).problems.map((problem) => problem.message);

describe("a component's declared options", () => {
  it("reads every kind with its defaults, groups, derived values and variants", () => {
    const { declaration, problems } = read(COMPOSER);
    expect(problems).toEqual([]);
    expect(declaration.options.map((entry) => [entry.name, entry.kind])).toEqual([
      ["width", "number"], ["attachments", "number"], ["mode", "choice"], ["density", "choice"], ["toolbar", "boolean"],
      ["accent", "color"], ["send-radius", "number"], ["send-label", "text"], ["motion", "easing"],
    ]);
    const density = declaration.options.find((entry) => entry.name === "density");
    expect(density).toMatchObject({ choices: ["compact", "comfortable", "wide-open"], choiceLabels: ["Compact", "Comfortable", "Wide open"] });
    expect(declaration.options.find((entry) => entry.name === "send-label")).toMatchObject({ group: "Send button", default: "Send" });
    expect(declaration.options.find((entry) => entry.name === "motion")).toMatchObject({ default: { curve: "spring(0.2)", duration: 150 } });
    expect(declaration.derived.map((entry) => entry.name)).toEqual(["gutter"]);
    expect(declaration.variants.map((entry) => [entry.name, Object.fromEntries(entry.values)])).toEqual([
      ["compact", { width: 800, density: "compact" }],
      ["wide-plan", { width: 1280, mode: "plan" }],
    ]);
  });

  it("refuses names that are reserved, objects' own names, or not plain", () => {
    for (const name of ["name", "class", "style", "id", "hidden", "slot", "title", "data-x", "aria-x", "onclick", "zd-x", "constructor",
      "tostring", "__proto__", "prototype", "range", "true", "in", "Width", "9lives", "two--dashes", "trailing-", "a".repeat(33)]) {
      expect(problems([option({ name, type: "text", default: "" })]), name).toHaveLength(1);
    }
  });

  it("refuses declarations that cannot hold", () => {
    expect(problems([option({ name: "a", type: "text", default: "" }), option({ name: "a", type: "text", default: "" })])).toEqual(["The option a is declared twice."]);
    expect(problems([option({ name: "a", type: "slider", default: "1" })])[0]).toMatch(/type must be one of/);
    expect(problems([option({ name: "a", type: "number", default: "20", min: "0", max: "10" })])[0]).toMatch(/default .* from 0 to 10/);
    expect(problems([option({ name: "a", type: "number", default: "5", min: "10", max: "0" })])[0]).toMatch(/min .* above its max/);
    expect(problems([option({ name: "a", type: "number", default: "5", step: "0" })])[0]).toMatch(/step must be above 0/);
    expect(problems([option({ name: "a", type: "number", default: "5", unit: "px; color: red" })])[0]).toMatch(/unit/);
    expect(problems([option({ name: "a", type: "choice", choices: "one", default: "one" })])[0]).toMatch(/2 to 16 choices/);
    expect(problems([option({ name: "a", type: "choice", choices: "x x", default: "x" })])[0]).toMatch(/twice/);
    expect(problems([option({ name: "a", type: "choice", choices: "x y", default: "z" })])[0]).toMatch(/default must be one of x or y/);
    expect(problems([option({ name: "a", type: "boolean", default: "yes" })])[0]).toMatch(/true or false/);
    expect(problems([option({ name: "a", type: "number" })])[0]).toMatch(/needs a default/);
    expect(problems([element("zd-variant", { name: "default" })])[0]).toMatch(/default/);
    expect(problems([option({ name: "a", type: "text", default: "" }), element("zd-variant", { name: "v", b: "1" })])[0]).toMatch(/no option b/);
    expect(problems([option({ name: "n", type: "number", default: "1", max: "4" }), element("zd-variant", { name: "v", n: "9" })])[0]).toMatch(/a number of at most 4; 9 does not fit/);
    expect(problems([element("zd-derive", { name: "a", value: "b + 1" }), element("zd-derive", { name: "b", value: "1" })])[0]).toMatch(/Unknown name b/);
    expect(problems([element("zd-derive", { name: "a", value: '"x"', unit: "px" })])[0]).toMatch(/number/);
    expect(problems([element("zd-thing", { name: "a" })])[0]).toMatch(/zd-option, zd-derive or zd-variant/);
  });

  it("holds its limits", () => {
    const many = Array.from({ length: COMPONENT_OPTION_LIMITS.options + 1 }, (_, index) => option({ name: `o${index}`, type: "text", default: "" }));
    expect(problems(many)).toEqual([`A component may declare at most ${COMPONENT_OPTION_LIMITS.options} options.`]);
    const variants = Array.from({ length: COMPONENT_OPTION_LIMITS.variants + 1 }, (_, index) => element("zd-variant", { name: `v${index}` }));
    expect(problems(variants)).toEqual([`A component may declare at most ${COMPONENT_OPTION_LIMITS.variants} variants.`]);
    expect(problems([option({ name: "t", type: "text", default: "x".repeat(2_049) })])[0]).toMatch(/2,048/);
    expect(problems([option({ name: "t", type: "text", default: "", label: "L".repeat(65) })])[0]).toMatch(/label/);
  });
});

describe("an instance's values", () => {
  const { declaration } = read(COMPOSER);
  const attributes = (values: Record<string, string>) => new Map(Object.entries(values));

  it("take the instance's attributes over its variant over the defaults", () => {
    const { values, problems } = componentOptionValues(declaration, attributes({ "zd-variant": "compact", mode: "plan", toolbar: "false" }));
    expect(problems).toEqual([]);
    expect(values.get("width")).toBe(800);
    expect(values.get("density")).toBe("compact");
    expect(values.get("mode")).toBe("plan");
    expect(values.get("toolbar")).toBe(false);
    expect(values.get("attachments")).toBe(2);
  });

  it("read a bare boolean attribute as on", () => {
    expect(componentOptionValues(declaration, attributes({ toolbar: "" })).values.get("toolbar")).toBe(true);
  });

  it("keep the inherited value and say why when an attribute does not fit", () => {
    const { values, problems } = componentOptionValues(declaration, attributes({ width: "9000", mode: "draw", "zd-variant": "huge" }));
    expect(values.get("width")).toBe(1120);
    expect(values.get("mode")).toBe("ask");
    expect(problems.map((problem) => problem.message)).toEqual([
      "There is no variant huge; the defaults apply.",
      "width must be a number from 640 to 1440; 9000 does not fit.",
      'mode must be one of ask or plan; "draw" does not fit.',
    ]);
  });

  it("leave host attributes alone and warn about names that are not options", () => {
    const { problems } = componentOptionValues(declaration, attributes({ class: "x", "data-oid": "c1", style: "color: red", widht: "800" }));
    expect(problems).toEqual([{ message: "This component has no option widht.", severity: "warning" }]);
  });
});

describe("option values in CSS", () => {
  const { declaration } = read(COMPOSER);

  it("set every option that reaches CSS, defaults included", () => {
    const { values } = componentOptionValues(declaration, new Map());
    const css = componentOptionCss(declaration, values);
    expect(css).toMatch(/^--zd-width: 1120px; --zd-attachments: 2; --zd-accent: var\(--blue-primary\); --zd-send-radius: 8px; --zd-motion-easing: linear\([^)]*\); --zd-motion-duration: 150ms; --zd-gutter: 16px;$/);
  });

  it("turn a spring into a bounded linear() curve that ends at 1", () => {
    // Any run of spaces, tabs, commas and slashes separates a colour's parts.
    expect(parseComponentOptionValue({ kind: "color" } as never, "rgb(1\t\t2 , 3 / 0.5)").ok).toBe(true);
    expect(parseComponentOptionValue({ kind: "color" } as never, `rgb(${"\t".repeat(200)})`).ok).toBe(false);
    const easing = parseComponentOptionValue({ kind: "easing" } as never, "spring(0.3) 400ms");
    expect(easing.ok).toBe(true);
    const { values } = componentOptionValues(read([option({ name: "m", type: "easing", default: "spring(0.3) 400ms" })]).declaration, new Map());
    const css = componentOptionCss(read([option({ name: "m", type: "easing", default: "spring(0.3) 400ms" })]).declaration, values);
    const stops = css.match(/linear\(([^)]*)\)/)![1]!.split(",");
    expect(stops.length).toBeLessThanOrEqual(32);
    expect(stops.at(-1)!.trim()).toBe("1");
    expect(css).toContain("--zd-m-duration: 400ms;");
  });

  it("admit only strict forms, whatever an author tries to break out with", () => {
    const attempts = [";", "}", "/*", "*/", "url(x)", "expression(alert(1))", "\n", "red; background: url(x)", "red}body{color:red", "var(--a);x", "var(--a, url(x))",
      "rgb(1 2 3) ;", "rgb(1, 2, url(x))", "#fff;", "calc(1px)", "attr(x)", "env(x)", "inherit"];
    const kinds = {
      number: option({ name: "n", type: "number", default: "1" }),
      color: option({ name: "c", type: "color", default: "red" }),
      easing: option({ name: "e", type: "easing", default: "ease 100ms" }),
      choice: option({ name: "k", type: "choice", choices: "a b", default: "a" }),
      boolean: option({ name: "b", type: "boolean", default: "true" }),
    };
    for (const [kind, declared] of Object.entries(kinds)) {
      const { declaration } = read([declared]);
      for (const attempt of attempts) {
        const name = declaration.options[0]!.name;
        const { values, problems } = componentOptionValues(declaration, new Map([[name, attempt]]));
        expect(problems.length, `${kind} ${JSON.stringify(attempt)}`).toBe(1);
        const css = componentOptionCss(declaration, values);
        expect(css, `${kind} ${JSON.stringify(attempt)}`).not.toMatch(/url\(|expression\(|\/\*|[{}\n]|attr\(|env\(/);
      }
    }
    // Text never reaches CSS, so nothing written in it can escape there.
    const text = read([option({ name: "t", type: "text", default: "" })]).declaration;
    const values = componentOptionValues(text, new Map([["t", "x; } body { background: url(x) } /*"]])).values;
    expect(componentOptionCss(text, values)).toBe("");
    // Nor can a declared default or variant value.
    for (const attempt of attempts) {
      expect(problems([option({ name: "c", type: "color", default: attempt })]).length, attempt).toBe(1);
    }
  });

  it("accept the colours people write", () => {
    for (const color of ["#fff", "#ffffff80", "red", "transparent", "currentColor", "var(--blue-primary)", "rgb(1 2 3)", "rgba(1, 2, 3, 0.5)",
      "hsl(210deg 50% 40% / 80%)", "oklch(0.7 0.1 200)", "lab(50% 40 59.5)", "hwb(12 50% 0%)"]) {
      expect(problems([option({ name: "c", type: "color", default: color })]), color).toEqual([]);
    }
  });
});
