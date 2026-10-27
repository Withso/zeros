import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser } from "@playwright/test";
import { DESIGN_SURFACE_VECTOR_SOURCE } from "../design-surface-vector";

let browser: Browser;
beforeAll(async () => {
  // SVG images use grayscale text antialiasing. Match the HTML reference to
  // that mode so Linux LCD font smoothing cannot masquerade as a layout or
  // paint mismatch; keep the same strict pixel comparison on every platform.
  browser = await chromium.launch({ headless: true, args: ["--disable-lcd-text"] });
});
afterAll(async () => { await browser?.close(); });

const cases: Array<{ name: string; css: string; body?: string; fallback?: boolean }> = [
  { name: "short opaque body", css: "body{background:rgb(250,250,250)}" },
  { name: "short translucent body", css: "body{background:rgba(200,40,20,.5)}" },
  { name: "transparent frame", css: "body{background:transparent}" },
  { name: "percentage height beneath an automatic root", css: "body{height:100%}main{height:50%;background:red}", body: "<main>Layout</main>" },
  { name: "automatic grid root", css: "html{display:grid;align-content:center}main{background:red}" },
  { name: "positioned automatic root", css: "html{position:relative}main{position:absolute;bottom:0;width:100px;background:red}" },
  { name: "flex body with percentage height", css: "body{height:100%;display:flex;align-items:center}main{background:red}", body: "<main>Layout</main>" },
  { name: "authored root width", css: "html{width:50%}main{background:red}" },
  { name: "short root background inheritance", css: 'html{background:rgba(200,40,20,.5)}body{background:inherit}html::before{content:"";position:absolute;left:0;top:0;width:40px;height:40px;background:inherit}' },
  { name: "short root opacity with page paint", css: "html{opacity:.5;background:red}" },
  { name: "full viewport root opacity", css: "html{height:100%;opacity:.5;background:red}" },
  { name: "root background precedence", css: "html{background:rgb(20,90,190)}body{background:rgb(190,30,40)}" },
  { name: "child and pseudo inherit body paint", css: 'body{background:rgba(200,40,20,.5)}main{background:inherit}body::before{content:"";position:absolute;left:0;top:0;width:40px;height:40px;background:inherit}' },
  { name: "paint-contained body", css: "body{contain:paint;background:rgb(20,90,190)}" },
  { name: "hidden body", css: "body{display:none;background:rgb(20,90,190)}" },
  { name: "short gradient body", fallback: true, css: "body{background:linear-gradient(90deg,rgb(200,40,20),rgb(20,90,190))}" },
  { name: "translucent gradient over body color", fallback: true, css: "body{background:linear-gradient(rgba(200,40,20,.5),rgba(20,90,190,.5)) rgb(120,220,40)}" },
  { name: "positioned non-repeating gradient", fallback: true, css: "body{margin:8px;background:linear-gradient(90deg,red,blue) 10px 20px/100px 50px no-repeat}" },
  { name: "repeated gradient body", fallback: true, css: "body{background:repeating-linear-gradient(45deg,red 0 10px,blue 10px 20px);background-size:80px 60px}" },
  { name: "gradient inherited by child and pseudo", fallback: true, css: 'body{background:linear-gradient(rgba(200,40,20,.5),rgba(20,90,190,.5))}main{background:inherit}body::before{content:"";position:absolute;left:0;top:0;width:40px;height:40px;background:inherit!important}' },
  { name: "root gradient precedence", fallback: true, css: "html{background:linear-gradient(red,blue)}body{background:rgba(200,40,20,.5)}" },
  { name: "full viewport gradient body", css: "html,body{height:100%}body{background:linear-gradient(red,blue)}" },
  { name: "full viewport translucent gradient", css: "html,body{height:100%}body{background:linear-gradient(rgba(200,40,20,.5),rgba(20,90,190,.5)) rgb(120,220,40)}" },
  { name: "full viewport repeated gradient and inheritance", css: 'html,body{height:100%}body{background:linear-gradient(red,blue) 10px 20px/100px 50px repeat}main{background:inherit}body::before{content:"";position:absolute;left:0;top:0;width:40px;height:40px;background:inherit!important}' },
  { name: "full viewport root gradient", css: "html{height:100%;background:linear-gradient(red,blue)}body{background:rgba(200,40,20,.5)}" },
  { name: "root effects over a page gradient", fallback: true, css: "html{height:100%;opacity:.5;background:linear-gradient(red,blue)}" },
  { name: "qualified HTML root variables", css: "html:root{--ink:rgb(200,40,20)}main{background:var(--ink,blue)}" },
  { name: "root child selectors and specificity", css: "html:root{--ink:red}html{--ink:blue}:root > body > main{background:var(--ink)}" },
  { name: "root rules inside layers and viewport queries", css: "@layer colors{@media(min-width:300px){html:root{--ink:red}}}main{background:var(--ink,blue)}" },
  { name: "nested root rule", css: "html:root{& main{background:red}}" },
  { name: "quoted root text is not rewritten", css: 'html:root{--ink:red}main[data-label=":root"]{background:var(--ink)}', body: '<main data-label=":root"></main>' },
  { name: "qualified root selector", css: ":root:not(.missing){--ink:rgb(200,40,20)}main{background:var(--ink,blue)}" },
  { name: "root pseudo-element inherited color", css: ':root{color:red}html::before{content:"";position:absolute;inset:0;width:40px;height:40px;background:currentColor}' },
  { name: "root CSS variables and currentColor", css: ":root{--ink:rgb(200,40,20);color:var(--ink)}body{background:rgb(240,240,240)}main{background:currentColor}" },
  { name: "media query viewport", css: "main{background:red}@media(min-width:300px){main{background:blue}}@media(min-width:500px){main{background:green}}" },
  { name: "container geometry cannot inherit authored SVG rules", css: "svg,foreignObject{width:50px!important;height:20px!important;transform:translate(100px)!important}body{background:rgb(20,90,190)}" },
  { name: "container paint cannot inherit authored SVG rules", css: "svg,foreignObject{opacity:.5!important;filter:blur(4px)!important;background:red!important}body{background:rgb(20,90,190)}" },
  { name: "font and layout", css: "body{font:16px/20px monospace;color:rgb(20,90,190)}main{display:grid;grid-template-columns:1fr 1fr;gap:10px}", body: "<main><span>Hello</span><strong>Vector</strong></main>" },
];

it.each(cases)("preserves native document pixels for $name", async ({ css, body, fallback }) => {
  const page = await browser.newPage({ viewport: { width: 320, height: 240 } });
  try {
    await page.setContent(`<!doctype html><html><head><style>body{margin:0}main{height:40px}${css}</style></head><body>${body ?? "<main></main>"}</body></html>`);
    await page.evaluate(() => document.fonts.ready);
    const htmlPixels = (await page.screenshot({ omitBackground: true })).toString("base64");
    const svg = await page.evaluate(source => new Function(source + ";return designSurfaceVector();")() as string | null, DESIGN_SURFACE_VECTOR_SOURCE);
    // Page-canvas image propagation on a short root has a distinct positioning
    // area. Preserve its native preview instead of presenting different pixels.
    if (fallback) { expect(svg).toBeNull(); return; }
    expect(svg).not.toBeNull();
    await page.setContent('<!doctype html><style>html,body{margin:0;background:transparent}img{display:block;width:320px;height:240px}</style><img>');
    await page.evaluate(async markup => {
      const image = document.querySelector("img")!;
      const url = URL.createObjectURL(new Blob([markup!], { type: "image/svg+xml" }));
      image.src = url; await image.decode();
    }, svg);
    const vectorPixels = (await page.screenshot({ omitBackground: true })).toString("base64");
    const result = await page.evaluate(async ({ htmlPixels, vectorPixels }) => {
      async function pixels(base64: string) {
        const image = new Image(); image.src = "data:image/png;base64," + base64; await image.decode();
        const canvas = document.createElement("canvas"); canvas.width = 320; canvas.height = 240;
        const context = canvas.getContext("2d")!; context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, 320, 240).data;
      }
      const a = await pixels(htmlPixels), b = await pixels(vectorPixels);
      let different = 0;
      const examples: Array<{ x: number; y: number; html: number[]; vector: number[] }> = [];
      for (let index = 0; index < a.length; index += 4) {
        if ([0, 1, 2, 3].some(channel => Math.abs(a[index + channel]! - b[index + channel]!) > 2)) {
          different++;
          if (examples.length < 3) examples.push({ x: index / 4 % 320, y: Math.floor(index / 4 / 320), html: [...a.slice(index, index + 4)], vector: [...b.slice(index, index + 4)] });
        }
      }
      return { different, examples };
    }, { htmlPixels, vectorPixels });
    expect(result.different, JSON.stringify(result)).toBeLessThanOrEqual(8);
  } finally { await page.close(); }
}, 20_000);

it.each(["<svg><animate/></svg>", "<video></video>", "<canvas></canvas>"])("refuses unsupported timelines or media: %s", async body => {
  const page = await browser.newPage();
  try {
    await page.setContent(body);
    expect(await page.evaluate(source => new Function(source + ";return designSurfaceVector();")(), DESIGN_SURFACE_VECTOR_SOURCE)).toBeNull();
  } finally { await page.close(); }
});

it("waits for the native viewport before publishing a vector, without depending on animation frames", async () => {
  const { designSurfaceReadyScript } = await import("../design-surface");
  const page = await browser.newPage({ viewport: { width: 320, height: 240 } });
  try {
    await page.setContent('<!doctype html><style>body{margin:0;background:#fff}main{height:40px}</style><main>Native viewport</main>');
    await page.evaluate(script => {
      const target = window as Window & { __surfaceMessages?: Array<{ svg?: string }> };
      target.__surfaceMessages = [];
      window.addEventListener("message", event => {
        if (event.data?.kind === "zeros-design-surface-ready") target.__surfaceMessages!.push(event.data);
      });
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 0 });
      Object.defineProperty(window, "innerHeight", { configurable: true, value: 0 });
      // Hidden native documents may receive layout before animation callbacks.
      window.requestAnimationFrame = () => 1;
      new Function(script)();
    }, designSurfaceReadyScript("d".repeat(24), null, true));
    await page.waitForTimeout(50);
    expect(await page.evaluate(() => (window as Window & { __surfaceMessages?: unknown[] }).__surfaceMessages)).toEqual([]);
    await page.evaluate(() => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 320 });
      Object.defineProperty(window, "innerHeight", { configurable: true, value: 240 });
      window.dispatchEvent(new Event("resize"));
    });
    await expect.poll(() => page.evaluate(() => (window as Window & { __surfaceMessages?: unknown[] }).__surfaceMessages!.length)).toBe(1);
    expect(await page.evaluate(() => (window as Window & { __surfaceMessages?: Array<{ svg: string }> }).__surfaceMessages![0]!.svg)).toContain('viewBox="0 0 320 240"');
    await page.evaluate(() => window.dispatchEvent(new Event("resize")));
    await page.waitForTimeout(20);
    expect(await page.evaluate(() => (window as Window & { __surfaceMessages?: unknown[] }).__surfaceMessages!.length)).toBe(1);
  } finally { await page.close(); }
});

it("accepts exact-parent layout delivery when a native child receives no resize event", async () => {
  const { designSurfaceReadyScript } = await import("../design-surface");
  const page = await browser.newPage({ viewport: { width: 320, height: 240 } });
  try {
    await page.setContent('<!doctype html><style>body{margin:0;background:#fff}</style><main>Deferred viewport</main>');
    await page.evaluate(script => {
      const target = window as Window & { __surfaceMessages?: unknown[]; __layoutRequests?: unknown[] };
      target.__surfaceMessages = []; target.__layoutRequests = [];
      window.addEventListener("message", event => {
        if (event.data?.kind === "zeros-design-surface-ready") target.__surfaceMessages!.push(event.data);
        if (event.data?.kind === "zeros-design-surface-layout-request") target.__layoutRequests!.push(event.data);
      });
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 0 });
      Object.defineProperty(window, "innerHeight", { configurable: true, value: 0 });
      window.requestAnimationFrame = () => 1;
      new Function(script)();
    }, designSurfaceReadyScript("d".repeat(24), null, true));
    await page.waitForTimeout(30);
    expect(await page.evaluate(() => (window as Window & { __layoutRequests?: unknown[] }).__layoutRequests!.length)).toBe(1);
    await page.evaluate(() => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 320 });
      Object.defineProperty(window, "innerHeight", { configurable: true, value: 240 });
      window.dispatchEvent(new MessageEvent("message", { source: null, data: { kind: "zeros-design-surface-layout", sourceVersion: "d".repeat(24), theme: null } }));
      window.postMessage({ kind: "zeros-design-surface-layout", sourceVersion: "e".repeat(24), theme: null }, "*");
    });
    await page.waitForTimeout(30);
    expect(await page.evaluate(() => (window as Window & { __surfaceMessages?: unknown[] }).__surfaceMessages)).toEqual([]);
    await page.evaluate(() => window.postMessage({ kind: "zeros-design-surface-layout", sourceVersion: "d".repeat(24), theme: null }, "*"));
    await expect.poll(() => page.evaluate(() => (window as Window & { __surfaceMessages?: unknown[] }).__surfaceMessages!.length), { timeout: 1000 }).toBe(1);
  } finally { await page.close(); }
});
