import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __unstable__loadDesignSystem } from "tailwindcss";
import {
  DESIGN_DIRECTORY_NAME,
  initializeDesignDocument,
  lintDesignDocument,
  readDesignWorkspaceSnapshot,
} from "../document";
import { forgetDesignStyleSourceCaches } from "../style-sources";
import * as tailwind from "../style-tailwind";
import * as selectors from "../style-class-selectors";
import { configureDesignFonts, resetDesignFontsForTests, settleDesignFontDownloadsForTests } from "../style-fonts";

vi.mock("tailwindcss", async (importOriginal) => {
  const actual = await importOriginal<typeof import("tailwindcss")>();
  return {
    ...actual,
    __unstable__loadDesignSystem: vi.fn(async (...args: Parameters<typeof actual.__unstable__loadDesignSystem>) => {
      const system = await actual.__unstable__loadDesignSystem(...args);
      return { ...system, candidatesToCss: vi.fn((candidates: string[]) => system.candidatesToCss(candidates)) };
    }),
  };
});

describe("unknown classes in Design lint", () => {
  let root: string;
  let directory: string;
  const frame = "page-1/home.html";
  const html = (body: string, head = "") => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

  beforeEach(async () => {
    vi.mocked(__unstable__loadDesignSystem).mockClear();
    root = await mkdtemp(path.join(tmpdir(), "zeros-style-classes-"));
    directory = path.join(root, DESIGN_DIRECTORY_NAME);
    await initializeDesignDocument(root);
    await mkdir(path.join(root, "styles"));
    await writeFile(path.join(root, "styles/app.css"), ".absent-parent .card { color: red; }");
    await writeFile(path.join(directory, frame), html('<main data-oid="first" class="card cardd">Hi</main>'));
    await editCanvas((canvas) => {
      canvas.styles = [{ id: "app", kind: "css", path: "styles/app.css" }];
      canvas.frames.home = { kind: "html", source: frame, title: "Home", x: 0, y: 0, width: 390, height: 844 };
      canvas.pages[0].frames.push("home");
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await settleDesignFontDownloadsForTests();
    resetDesignFontsForTests();
    forgetDesignStyleSourceCaches(root);
    await rm(root, { recursive: true, force: true });
  });

  async function editCanvas(edit: (canvas: Record<string, any>) => void) {
    const file = path.join(directory, "meta/canvas.json");
    const canvas = JSON.parse(await readFile(file, "utf8"));
    edit(canvas);
    await writeFile(file, JSON.stringify(canvas));
  }

  const lint = () => lintDesignDocument(root, undefined, { healOids: false, includeRuntimeAudits: false });
  const unknown = (report: Awaited<ReturnType<typeof lintDesignDocument>>, file = frame) =>
    report.violations.filter((violation) => String(violation.ruleId) === "unknown-class" && violation.file === file);
  const names = (report: Awaited<ReturnType<typeof lintDesignDocument>>, file = frame) =>
    unknown(report, file).map((violation) => /^Class "(.*)" has no CSS/.exec(violation.message)?.[1]);

  it("reports a distinct unknown at its first class attribute, using unpruned CSS and exact case", async () => {
    await writeFile(path.join(directory, frame), `<!doctype html><html><head></head><body>
  <main data-oid="first" class="card cardd cardd">Hi</main>
  <p data-oid="second" class="cardd Card">Again</p>
</body></html>`);
    const report = await lint();
    expect(unknown(report)).toEqual([
      {
        ruleId: "unknown-class", severity: "warning", file: frame, line: 2, column: 26, oid: "first",
        message: 'Class "cardd" has no CSS in this frame\'s styles.',
        fix: "Use an existing class or utility from the application's styles, define .cardd in the frame's <style> or a Design stylesheet, or remove it.",
      },
      expect.objectContaining({ message: 'Class "Card" has no CSS in this frame\'s styles.', line: 3, column: 24, oid: "second" }),
    ]);
    expect(unknown((await readDesignWorkspaceSnapshot(root)).lint)).toEqual(unknown(report));
  });

  it("splits class attributes only on ASCII whitespace", async () => {
    await writeFile(path.join(directory, frame), html('<main class="card\tcard\ncard\rcard\fcard\u00a0other"></main>'));
    expect(names(await lint())).toEqual(["card\u00a0other"]);
  });

  it("finds escaped names and classes anywhere in functional selectors and class attributes", async () => {
    await writeFile(path.join(root, "styles/app.css"), String.raw`
      :where(.x), :is(.y), :not(.n), :has(.h), :nth-child(2n of .nth),
      .hover\:bg-x, .w-1\/2, .\31 23, .Case,
      [class~="z"], [class="exact"], [class^="icon-"], [class$="-end"],
      [class*="middle"], [class|="dash"], [class="quoted\:name"],
      [class^="PREFIX-" i], [data-label=".not-a-class"] { color: red; }
    `);
    await writeFile(path.join(directory, frame), html('<main class="x y n h nth hover:bg-x w-1/2 123 Case z exact icon-ok the-end in-middle-now dash dash-child quoted:name prefix-lower not-a-class case nope"></main>'));
    expect(names(await lint())).toEqual(["not-a-class", "case", "nope"]);
  });

  it("accepts only the documented Tailwind and Lucide markers", async () => {
    await writeFile(path.join(directory, frame), html('<main class="group peer group/row peer/x lucide lucide-chevron-down group/ lucide- marker"></main>'));
    expect(names(await lint())).toEqual(["group/", "lucide-", "marker"]);
  });

  it("preserves non-ASCII class names in attribute selectors and limits the i modifier to ASCII folding", async () => {
    await writeFile(path.join(root, "styles/app.css"), '[class=foo\u00a0], [class="UPPER" i], [class="Ü" i], [class~="two words"] { color: red; }');
    await writeFile(path.join(directory, frame), html('<main class="foo\u00a0 upper Ü ü two words invented"></main>'));
    expect(names(await lint())).toEqual(["ü", "two", "words", "invented"]);
  });

  it("recognizes commented attribute selectors and CSS code-point escapes without treating keyframe offsets as classes", async () => {
    await writeFile(path.join(root, "styles/app.css"), '[class/* note */~="commented"] { color: red; } .\\d800, .\\31\r\n23, .a\\31\u00a0b { color: red; } @keyframes flash { 0.5% { opacity: 0; } }');
    await writeFile(path.join(directory, frame), html('<main class="commented \ufffd 123 a1\u00a0b 5 invented"></main>'));
    expect(names(await lint())).toEqual(["5", "invented"]);
  });

  it("uses inline and linked styles, and component styles without linting component classes", async () => {
    await writeFile(path.join(directory, "tokens.css"), ".linked { color: red; }");
    await writeFile(path.join(directory, "unused.css"), ".unlinked { color: red; }");
    await mkdir(path.join(directory, "components"), { recursive: true });
    await writeFile(path.join(directory, "components/badge.html"), html('<span class="component-invented">Badge</span>', "<style>.from-component { color: red; }</style>"));
    await writeFile(path.join(directory, frame), html(
      '<main class="card own linked from-component unlinked cardd"><zd-badge></zd-badge></main>',
      '<style>.own { color: red; }</style><link rel="stylesheet" href="../tokens.css">',
    ));
    expect(names(await lint())).toEqual(["unlinked", "cardd"]);
    await editCanvas((canvas) => { canvas.frames.home.styles = []; });
    expect(names(await lint())).toEqual(["card", "unlinked", "cardd"]);
  });

  it.each(["css", "sass", "build"])("reads an available %s source without pruning its classes", async (kind) => {
    const source = kind === "build" ? ".zeros/design-styles/app.css" : `styles/app.${kind === "sass" ? "scss" : "css"}`;
    await mkdir(path.dirname(path.join(root, source)), { recursive: true });
    await writeFile(path.join(root, source), ".absent-parent .card { color: red; }");
    await editCanvas((canvas) => { canvas.styles = [{ id: "app", kind, path: source }]; });
    expect(names(await lint())).toEqual(["cardd"]);
  });

  it("accepts only utilities Tailwind generates, including variants and escaped names", async () => {
    await writeFile(path.join(root, "styles/app.css"), '@import "tailwindcss"; @theme { --color-x: red; } .custom { color: red; }');
    await editCanvas((canvas) => { canvas.styles[0].kind = "tailwind"; });
    await writeFile(path.join(directory, frame), html('<main class="p-3 hover:bg-x w-1/2 group-hover:text-x has-[.active]:bg-x active custom invented"></main>'));
    expect(names(await lint())).toEqual(["invented"]);
    expect(names((await readDesignWorkspaceSnapshot(root)).lint)).toEqual(["invented"]);
  });

  it("does not invent utility CSS when a Tailwind source has no utilities directive", async () => {
    await writeFile(path.join(root, "styles/app.css"), "@theme { --spacing: 0.25rem; } .card { color: red; }");
    await editCanvas((canvas) => { canvas.styles[0].kind = "tailwind"; });
    await writeFile(path.join(directory, frame), html('<main class="card p-3"></main>'));
    expect(names(await lint())).toEqual(["p-3"]);
  });

  it("keeps the no-repository-JavaScript policy while classifying Tailwind candidates", async () => {
    await writeFile(path.join(root, "styles/plugin.js"), 'throw new Error("Repository JavaScript executed");');
    await writeFile(path.join(root, "styles/app.css"), '@import "tailwindcss"; @plugin "./plugin.js"; @config "./plugin.js"; @utility tile { color: red; } @custom-variant hocus (&:hover, &:focus);');
    await editCanvas((canvas) => { canvas.styles[0].kind = "tailwind"; });
    await writeFile(path.join(directory, frame), html('<main class="p-3 tile hocus:tile invented"></main>'));
    expect(names(await lint())).toEqual(["invented"]);
    expect(__unstable__loadDesignSystem).toHaveBeenCalledOnce();
  });

  it("skips a frame whose Tailwind candidates reach the cap, since the rest go unclassified", async () => {
    await writeFile(path.join(root, "styles/app.css"), '@import "tailwindcss";');
    await editCanvas((canvas) => { canvas.styles[0].kind = "tailwind"; });
    const many = Array.from({ length: tailwind.MAX_TAILWIND_CANDIDATES }, (_, index) => `a-${index}`);
    // Sorted candidates keep "a-…" and cut "p-3", which rendering would also drop.
    await writeFile(path.join(directory, frame), html(`<main class="${many.join(" ")} p-3"></main>`));
    expect(unknown(await lint())).toEqual([]);
    await writeFile(path.join(directory, frame), html('<main class="p-3 invented"></main>'));
    expect(names(await lint())).toEqual(["invented"]);
  });

  it("bounds Tailwind's internal parsed-candidate cache as distinct candidates accumulate", async () => {
    const compiler = await tailwind.compileDesignTailwind({ file: "app.css", content: '@import "tailwindcss";' }, async () => null);
    const invalid = Array.from({ length: tailwind.MAX_TAILWIND_CANDIDATES }, (_, index) => `invented-${index}`);
    expect(await compiler.candidatesToCss(invalid)).toEqual(invalid.map(() => null));
    expect(__unstable__loadDesignSystem).toHaveBeenCalledOnce();
    expect((await compiler.candidatesToCss(["p-3"]))[0]).toContain(".p-3");
    expect(__unstable__loadDesignSystem).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["css", "styles/missing.css", null],
    ["css", "styles/broken.css", ".card {"],
    ["build", ".zeros/design-styles/app.css", null],
    ["tailwind", "styles/app.css", '@import "tailwindcss"; @import "not-installed/theme.css";'],
    ["tailwind", "styles/app.css", '@import "tailwindcss"; @apply does-not-exist;'],
  ])("skips unknown classes for unavailable %s source %s while retaining other lint", async (kind, source, css) => {
    if (css !== null) await writeFile(path.join(root, source!), css);
    await editCanvas((canvas) => { canvas.styles = [{ id: "app", kind, path: source }]; });
    await writeFile(path.join(directory, frame), html('<main class="invented" style="color:var(--missing)"></main>'));
    const report = await lint();
    expect(unknown(report)).toEqual([]);
    expect(report.violations).toEqual(expect.arrayContaining([expect.objectContaining({ ruleId: "unknown-token" })]));
    await editCanvas((canvas) => { canvas.frames.home.styles = []; });
    expect(names(await lint())).toEqual(["invented"]);
  });

  it("skips unknown classes when App fonts are unavailable, except on opted-out frames", async () => {
    await editCanvas((canvas) => { canvas.fonts = [{ family: "Missing", provider: "local", path: "styles/missing.woff2" }]; });
    expect(unknown(await lint())).toEqual([]);
    await editCanvas((canvas) => { canvas.frames.home.styles = []; });
    expect(names(await lint())).toEqual(["card", "cardd"]);
  });

  it("does not treat partial font CSS with declared variables as a complete source", async () => {
    await editCanvas((canvas) => { canvas.fonts = [{ family: "Missing", provider: "local", path: "styles/missing.woff2", variable: "--font-missing" }]; });
    expect(unknown(await lint())).toEqual([]);
  });

  it("includes only the Google font stylesheets the frame's selected sources import", async () => {
    configureDesignFonts({ cacheDirectory: () => path.join(root, "font-cache"), fetch: async () => new Response("Unavailable", { status: 503 }) });
    await writeFile(path.join(root, "styles/other.css"), '@import url("https://fonts.googleapis.com/css2?family=Missing");');
    await editCanvas((canvas) => {
      canvas.styles.push({ id: "other", kind: "css", path: "styles/other.css" });
      canvas.frames.home.styles = ["app"];
    });
    expect(names(await lint())).toEqual(["cardd"]);
    await editCanvas((canvas) => { canvas.frames.home.styles = ["other"]; });
    expect(unknown(await lint())).toEqual([]);
  });

  it.each(["missing", "symlink", "malformed"])("skips unknown classes for a %s linked stylesheet", async (kind) => {
    const file = path.join(directory, "linked.css");
    if (kind === "symlink") await symlink(path.join(root, "styles/app.css"), file);
    if (kind === "malformed") await writeFile(file, ".card {");
    await writeFile(path.join(directory, frame), html('<main class="cardd" style="color:var(--missing)"></main>', '<link rel="stylesheet" href="../linked.css">'));
    const report = await lint();
    expect(unknown(report)).toEqual([]);
    expect(report.violations.some((violation) => violation.ruleId === "unknown-token")).toBe(true);
  });

  it("bounds warnings to 50, past which 49 names and the number of remaining classes", async () => {
    const classes = Array.from({ length: 55 }, (_, index) => `missing-${index}`);
    await writeFile(path.join(directory, frame), html(`<main data-oid="first" class="${classes.join(" ")} ${classes.join(" ")}"></main>`));
    const warnings = unknown(await lint());
    expect(warnings).toHaveLength(50);
    expect(warnings.slice(0, 49).map((violation) => violation.message)).toEqual(classes.slice(0, 49).map((name) => `Class "${name}" has no CSS in this frame's styles.`));
    expect(warnings[49]).toMatchObject({ ruleId: "unknown-class", severity: "warning", message: "6 more classes have no CSS in this frame.", oid: "first" });
    expect(warnings.every((warning) => warning.column === warnings[0]!.column)).toBe(true);

    // Exactly 50 fit, so each is named and none is summarized as "1 more".
    await writeFile(path.join(directory, frame), html(`<main data-oid="first" class="${classes.slice(0, 50).join(" ")}"></main>`));
    const fifty = unknown(await lint());
    expect(fifty.map((violation) => violation.message)).toEqual(classes.slice(0, 50).map((name) => `Class "${name}" has no CSS in this frame's styles.`));
  });

  it("reuses Tailwind generation and candidate results across warm lint, snapshots and other frames", async () => {
    await writeFile(path.join(root, "styles/app.css"), '@import "tailwindcss"; @theme { --color-x: red; }');
    await editCanvas((canvas) => { canvas.styles[0].kind = "tailwind"; });
    await writeFile(path.join(directory, frame), html('<main class="p-3 hover:bg-x w-1/2 invented"></main>'));
    const compile = vi.spyOn(tailwind, "compileDesignTailwind");
    const extract = vi.spyOn(selectors, "extractDesignClassCatalog");
    expect(names(await lint())).toEqual(["invented"]);
    expect(compile.mock.calls.length).toBeGreaterThan(0);
    expect(__unstable__loadDesignSystem).toHaveBeenCalledOnce();
    const system = await vi.mocked(__unstable__loadDesignSystem).mock.results[0]!.value;
    expect(system.candidatesToCss).toHaveBeenCalledOnce();
    const count = compile.mock.calls.length;
    const parsed = extract.mock.calls.length;
    expect(names(await lint())).toEqual(["invented"]);
    expect(names((await readDesignWorkspaceSnapshot(root)).lint)).toEqual(["invented"]);
    await writeFile(path.join(directory, "page-1/second.html"), html('<aside class="invented w-1/2 p-3"></aside>'));
    await editCanvas((canvas) => {
      canvas.frames.second = { ...canvas.frames.home, source: "page-1/second.html", title: "Second" };
      canvas.pages[0].frames.push("second");
    });
    expect(names(await lint(), "page-1/second.html")).toEqual(["invented"]);
    expect(compile).toHaveBeenCalledTimes(count);
    expect(__unstable__loadDesignSystem).toHaveBeenCalledOnce();
    expect(system.candidatesToCss).toHaveBeenCalledOnce();
    expect(extract).toHaveBeenCalledTimes(parsed);
  });

  it("refreshes classes when source and linked stylesheet contents change", async () => {
    await writeFile(path.join(directory, "tokens.css"), ".linked { color: red; }");
    await writeFile(path.join(directory, frame), html('<main class="card linked added"></main>', '<link rel="stylesheet" href="../tokens.css">'));
    expect(names(await lint())).toEqual(["added"]);
    await writeFile(path.join(root, "styles/app.css"), ".added { color: red; }");
    await writeFile(path.join(directory, "tokens.css"), ".other { color: red; }");
    expect(names(await lint())).toEqual(["card", "linked"]);
  });

  it("invalidates utility results when the Tailwind generation changes", async () => {
    await writeFile(path.join(root, "styles/app.css"), '@import "tailwindcss"; @theme { --color-x: red; }');
    await editCanvas((canvas) => { canvas.styles[0].kind = "tailwind"; });
    await writeFile(path.join(directory, frame), html('<main class="bg-x bg-brand"></main>'));
    expect(names(await lint())).toEqual(["bg-brand"]);
    await writeFile(path.join(root, "styles/app.css"), '@import "tailwindcss"; @theme { --color-brand: red; }');
    expect(names(await lint())).toEqual(["bg-x"]);
    expect(__unstable__loadDesignSystem).toHaveBeenCalledTimes(2);
  });

  it("retains other lint when class extraction fails", async () => {
    vi.spyOn(selectors, "extractDesignClassCatalog").mockImplementation(() => { throw new Error("Unavailable class catalog"); });
    await writeFile(path.join(directory, frame), html('<main class="invented" style="color:var(--missing)"></main>'));
    const report = await lint();
    expect(unknown(report)).toEqual([]);
    expect(report.violations.some((violation) => violation.ruleId === "unknown-token")).toBe(true);
  });

  it("keeps unavailable sources isolated to frames that receive them", async () => {
    await editCanvas((canvas) => {
      canvas.styles.push({ id: "missing", kind: "css", path: "styles/missing.css" });
      canvas.frames.home.styles = ["app"];
    });
    expect(names(await lint())).toEqual(["cardd"]);
    await editCanvas((canvas) => { canvas.frames.home.styles = ["missing"]; });
    expect(unknown(await lint())).toEqual([]);
    await editCanvas((canvas) => { canvas.frames.home.styles = ["app"]; });
    expect(names(await lint())).toEqual(["cardd"]);
  });
});
