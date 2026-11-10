import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { designColorLiteralKey } from "../authoring-lint";
import {
  DESIGN_DIRECTORY_NAME,
  initializeDesignDocument,
  lintDesignDocument,
} from "../document";

// The authoring contract's three advisory checks, run through the real lint
// path over a small corpus. Each frame names the contract rule ids it must and
// must not produce; near misses are the cases a careful designer would leave.
const CONTRACT_RULES = ["repeated-inline-style", "literal-token-value", "repeated-markup"] as const;
type ContractRule = (typeof CONTRACT_RULES)[number];

// check:ui ignore-next -- authored frame colour fixture, not application chrome.
const BRAND = "#ff0044";
const TOKENS = `:root { --brand: ${BRAND}; --surface: hsl(0 0% 7.843%); --brand-alias: var(--brand); --gap: 8px; }\n`; // check:ui ignore-line -- authored frame colour fixture.
const CARD_COMPONENT = `<article data-zid="card" class="card"><h3 data-zid="title"><slot data-zd-attr="title"></slot></h3><p data-zid="body"><slot></slot></p><a data-zid="link" href="#">More</a></article>`;

const page = (body: string, head = "") =>
  `<!doctype html><html><head><link rel="stylesheet" href="../tokens.css">${head}</head><body>${body}</body></html>`;
const card = (title: string) => `<article class="card"><div class="media"></div><div class="body"><h3>${title}</h3><p>Body</p></div></article>`;
/** Three cards, three repeated inline styles and a token-equal literal: every
 * contract warning at once, as captured application markup tends to carry. */
const busy = (attributes = "") =>
  `<section class="shot"${attributes}>${card("One")}${card("Two")}${card("Three")}<p style="margin: 0; color: rgb(255 0 68)">A</p><p style="margin: 0; color: rgb(255 0 68)">B</p><p style="margin: 0; color: rgb(255 0 68)">C</p></section>`; // check:ui ignore-line -- authored frame colour fixture.
const row = (label: string) => `<div class="row"><span class="icon"></span><span class="label">${label}</span><span class="meta"></span></div>`;

interface Case {
  frame: string;
  source: string;
  must: ContractRule[];
  mustNot: ContractRule[];
}

const CASES: Case[] = [
  {
    frame: "repeated-inline.html",
    // Declaration order and spacing do not make a different set.
    source: page(`<main>
<div style="display: flex; gap: 8px">A</div>
<div style="display:flex;gap:8px">B</div>
<div style="gap: 8px; display: flex">C</div>
<div style="display: flex; gap: 8px">D</div>
</main>`),
    must: ["repeated-inline-style"],
    mustNot: ["literal-token-value", "repeated-markup"],
  },
  {
    frame: "inline-twice.html",
    source: page(`<main><div style="display: flex; gap: 8px">A</div><div style="display: flex; gap: 8px">B</div></main>`),
    must: [],
    mustNot: [...CONTRACT_RULES],
  },
  {
    frame: "one-off-edits.html",
    // People's Style panel edits: each element owns its own values.
    source: page(`<main style="position: relative">
<div style="width: 120px">A</div>
<div style="left: 40px; top: 12px; position: absolute">B</div>
<div style="color: var(--brand)">C</div>
<div style="width: 120px; height: 40px">D</div>
</main>`),
    must: [],
    mustNot: [...CONTRACT_RULES],
  },
  {
    frame: "literal-token.html",
    // Hex in a rule and rgb() inline name the same token value.
    source: page(`<main class="hero" style="border: 1px solid rgb(255 0 68)"><h1 class="title">Hi</h1></main>`, // check:ui ignore-line -- authored frame colour fixture.
      "<style>.title { color: #FF0044; } .hero { background: hsl(0, 0%, 7.843%); }</style>"), // check:ui ignore-line -- authored frame colour fixture.
    must: ["literal-token-value"],
    mustNot: ["repeated-inline-style", "repeated-markup"],
  },
  {
    frame: "literal-no-token.html",
    source: page(`<main class="hero"><h1 class="title">Hi</h1></main>`,
      // check:ui ignore-next-line -- literal frame colours that no token holds.
      "<style>.title { color: #123456; } .hero { background: rgba(255, 0, 68, 0.5); }</style>"),
    must: [],
    mustNot: [...CONTRACT_RULES],
  },
  {
    frame: "literal-declares-token.html",
    // A frame-local custom property declares a value; it is not a use of one.
    source: page(`<main class="hero" style="--accent: ${BRAND}">Hi</main>`, `<style>:root { --local: ${BRAND}; }</style>`),
    must: [],
    mustNot: [...CONTRACT_RULES],
  },
  {
    frame: "literal-fragment-url.html",
    // url(#fade) is a fragment reference, not the colour #ffaadd.
    source: page(`<main style="fill: url(#fade)">Hi</main>`, "<style>:root { --pink: #ffaadd; }</style>"), // check:ui ignore-line -- authored frame colour fixture.
    must: [],
    mustNot: [...CONTRACT_RULES],
  },
  {
    frame: "repeated-cards.html",
    source: page(`<main class="grid">${card("One")}${card("Two")}${card("Three")}</main>`),
    must: ["repeated-markup"],
    mustNot: ["repeated-inline-style", "literal-token-value"],
  },
  {
    frame: "cards-twice.html",
    source: page(`<main class="grid">${card("One")}${card("Two")}</main>`),
    must: [],
    mustNot: [...CONTRACT_RULES],
  },
  {
    frame: "simple-list.html",
    // Three <li> are a list, not a component.
    source: page(`<ul><li class="item">One</li><li class="item">Two</li><li class="item">Three</li><li class="item">Four</li></ul>`),
    must: [],
    mustNot: [...CONTRACT_RULES],
  },
  {
    frame: "flat-groups.html",
    // A flat group of lines repeated as table rows is not a component yet.
    source: page(`<main>${[1, 2, 3, 4].map((index) => `<div class="label"><p class="name">Row ${index}</p><p class="code">code</p><p class="use">use</p></div>`).join("")}</main>`),
    must: [],
    mustNot: [...CONTRACT_RULES],
  },
  {
    frame: "inline-parameters.html",
    // Custom properties set inline are per-element parameters.
    source: page(`<main>${[1, 2, 3].map(() => `<div class="swatch" style="--swatch: var(--brand); --size: 8px"></div>`).join("")}</main>`),
    must: [],
    mustNot: [...CONTRACT_RULES],
  },
  {
    frame: "component-instances.html",
    // Already a component: instances are the contract, not a repeat.
    source: page(`<main class="grid"><zd-card data-oid="c1" title="One">Body</zd-card><zd-card data-oid="c2" title="Two">Body</zd-card><zd-card data-oid="c3" title="Three">Body</zd-card></main>`),
    must: [],
    mustNot: [...CONTRACT_RULES],
  },
  {
    frame: "captured-section.html",
    // Markup that really came from elsewhere keeps its own classes and styles.
    source: page(`<main>${busy(' data-zd-captured="zeros renderer"')}</main>`),
    must: [],
    mustNot: [...CONTRACT_RULES],
  },
  {
    frame: "uncaptured-section.html",
    source: page(`<main>${busy()}</main>`),
    must: [...CONTRACT_RULES],
    mustNot: [],
  },
  {
    frame: "captured-and-authored.html",
    source: page(`<main>${busy(" data-zd-captured")}\n<section class="ours">${card("Mine")}${card("Yours")}${card("Theirs")}</section></main>`),
    must: ["repeated-markup"],
    mustNot: ["repeated-inline-style", "literal-token-value"],
  },
  {
    frame: "captured-body.html",
    // Marking the body captures the whole frame, its <style> included.
    source: `<!doctype html><html><head><style>.title { color: #ff0044; }</style></head><body data-zd-captured="zeros renderer">${busy()}</body></html>`, // check:ui ignore-line -- authored frame colour fixture.
    must: [],
    mustNot: [...CONTRACT_RULES],
  },
  {
    frame: "captured-section-style.html",
    // A captured section does not capture the frame's own stylesheet.
    source: page(`<main>${busy(" data-zd-captured")}</main>`, "<style>.title { color: #ff0044; }</style>"), // check:ui ignore-line -- authored frame colour fixture.
    must: ["literal-token-value"],
    mustNot: ["repeated-inline-style", "repeated-markup"],
  },
  {
    frame: "state-copies.html",
    // Three copies of a control drawn for its states belong in one component.
    source: page(`<main class="states">
<div class="state"><span class="state-label">Default</span><button class="btn"><span class="btn-icon"></span><span class="btn-label">Save</span></button></div>
<div class="state"><span class="state-label">Hover</span><button class="btn is-hover"><span class="btn-icon"></span><span class="btn-label">Save</span></button></div>
<div class="state"><span class="state-label">Disabled</span><button class="btn" disabled><span class="btn-icon"></span><span class="btn-label">Save</span></button></div>
</main>`),
    must: ["repeated-markup"],
    mustNot: ["repeated-inline-style", "literal-token-value"],
  },
];

describe("authoring contract lint", () => {
  let root: string;
  let directory: string;
  let report: Awaited<ReturnType<typeof lintDesignDocument>>;
  const contract = (file: string) =>
    report.violations.filter(
      (violation) => violation.file === `page-1/${file}` && (CONTRACT_RULES as readonly string[]).includes(violation.ruleId),
    );

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "zeros-authoring-contract-"));
    directory = path.join(root, DESIGN_DIRECTORY_NAME);
    await initializeDesignDocument(root);
    await writeFile(path.join(directory, "tokens.css"), TOKENS);
    await mkdir(path.join(directory, "components"), { recursive: true });
    await writeFile(path.join(directory, "components/card.html"), CARD_COMPONENT);
    const extra: Case[] = [
      {
        frame: "nested-repeats.html",
        source: page(`<main>${[1, 2, 3].map((index) => `<section class="panel"><h2>Panel ${index}</h2>${row("a")}${row("b")}${row("c")}</section>`).join("")}</main>`),
        must: ["repeated-markup"],
        mustNot: [],
      },
      {
        frame: "many-inline.html",
        source: page(`<main>${Array.from({ length: 12 }, (_, index) => [0, 1, 2].map(() => `<i style="margin: ${index}px; padding: 1px"></i>`).join("")).join("")}</main>`),
        must: ["repeated-inline-style"],
        mustNot: [],
      },
    ];
    for (const item of [...CASES, ...extra]) await writeFile(path.join(directory, "page-1", item.frame), item.source);
    const canvasFile = path.join(directory, "meta/canvas.json");
    const canvas = JSON.parse(await readFile(canvasFile, "utf8"));
    for (const [index, item] of [...CASES, ...extra].entries()) {
      const id = `frame_${index}`;
      canvas.frames[id] = { kind: "html", source: `page-1/${item.frame}`, title: item.frame, x: index * 500, y: 0, width: 480, height: 640 };
      canvas.pages[0].frames.push(id);
    }
    await writeFile(canvasFile, JSON.stringify(canvas));
    report = await lintDesignDocument(root, undefined, { healOids: false, includeRuntimeAudits: false });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.each(CASES)("$frame produces exactly the rules it breaks", ({ frame, must, mustNot }) => {
    const produced = new Set(contract(frame).map((violation) => violation.ruleId));
    for (const rule of must) expect(produced, `${frame} must report ${rule}`).toContain(rule);
    for (const rule of mustNot) expect(produced, `${frame} must not report ${rule}`).not.toContain(rule);
  });

  it("only warns, so validate's exit status and saving are unchanged", () => {
    const all = CASES.flatMap(({ frame }) => contract(frame));
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((violation) => violation.severity === "warning")).toBe(true);
  });

  it("names the repeated inline declarations once, with their places", () => {
    expect(contract("repeated-inline.html")).toEqual([
      {
        ruleId: "repeated-inline-style",
        severity: "warning",
        file: "page-1/repeated-inline.html",
        line: 2,
        column: 6,
        message: 'Move the inline style "display: flex; gap: 8px", repeated on 4 elements (lines 2, 3, 4 and 1 more), into one class.',
        fix: "Declare it once as a class in the frame's <style> or a Design stylesheet and use that class on each element; keep inline style for one-off values.",
      },
    ]);
  });

  it("names the token for every spelling of its value", () => {
    expect(contract("literal-token.html").map(({ message, line }) => ({ message, line }))).toEqual([
      { line: 1, message: 'Write var(--brand) instead of the literal colour "#FF0044" (2 places: lines 1 and 1).' }, // check:ui ignore-line -- authored frame colour fixture.
      { line: 1, message: 'Write var(--surface) instead of the literal colour "hsl(0, 0%, 7.843%)" (line 1).' }, // check:ui ignore-line -- authored frame colour fixture.
    ]);
    expect(contract("literal-token.html")[0]!.fix).toBe(
      "Use the token so the value follows the directory's tokens and themes; keep a literal only where no token means that value.",
    );
  });

  it("reports the outermost repeated markup once, not each repeat inside it", () => {
    expect(contract("nested-repeats.html").map(({ ruleId, message }) => ({ ruleId, message }))).toEqual([
      {
        ruleId: "repeated-markup",
        message: 'Make the <section> markup with class "panel", repeated 3 times (lines 1, 1 and 1), one component.',
      },
    ]);
    expect(contract("repeated-cards.html")[0]).toMatchObject({
      ruleId: "repeated-markup",
      message: 'Make the <article> markup with class "card", repeated 3 times (lines 1, 1 and 1), one component.',
      fix: "Define it once as components/<name>.html with <slot> for its content and data-zd-attr for attribute values, then place one <zd-name> per use.",
    });
  });

  it("reports only the authored repeat beside a captured one", () => {
    expect(contract("captured-and-authored.html").map(({ ruleId, line }) => ({ ruleId, line }))).toEqual([
      { ruleId: "repeated-markup", line: 2 },
    ]);
  });

  it("caps repeated inline styles per frame like unknown classes", () => {
    const repeated = contract("many-inline.html");
    expect(repeated).toHaveLength(10);
    expect(repeated.at(-1)!.message).toBe("3 more inline styles are repeated on three or more elements in this frame.");
  });
});

describe("colour literals the token check compares", () => {
  // check:ui ignore-next -- colour syntax fixtures for the engine's parser.
  const same = ["#f04", "#ff0044", "#FF0044FF", "rgb(255, 0, 68)", "rgb(255 0 68)", "rgba(255,0,68,1)", "rgb(100% 0% 26.667%)", "hsl(344deg 100% 50%)", "hsla(344, 100%, 50%, 1)"];
  it.each(same)("reads %s as one colour", (literal) => {
    expect(designColorLiteralKey(literal)).toBe("255,0,68,1");
  });

  it("keeps alpha and rejects what it cannot read exactly", () => {
    // check:ui ignore-next-line -- colour syntax fixtures for the engine's parser.
    expect(designColorLiteralKey("rgb(255 0 68 / 50%)")).toBe("255,0,68,0.5");
    // check:ui ignore-next-line -- colour syntax fixtures for the engine's parser.
    for (const literal of ["#ff004", "#ff00441", "red", "oklch(60% 0.2 20)", "rgb(255 0)", "hsl(1turn 100% 50%)", "rgb(var(--r) 0 0)"])
      expect(designColorLiteralKey(literal), literal).toBeNull();
  });
});
