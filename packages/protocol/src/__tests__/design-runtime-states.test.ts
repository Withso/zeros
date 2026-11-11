import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";
import {
  DESIGN_RUNTIME_SOURCE,
  isDesignRuntimeFrameMessage,
  isDesignRuntimeNodeDetails,
  type DesignRuntimeNodeDetails,
} from "../design-runtime";

type RuntimeWindow = Window & {
  __zerosDesignSourceVersion: string;
  runtimeRequest: (method: string, args: Record<string, unknown>) => Promise<{ result?: unknown; error?: unknown; message: unknown }>;
  runtimeEvents: string[];
  runtimeEventMessages: unknown[];
};

// A class-styled button with every state, a Tailwind v4 variant as the
// compiler nests it, and the shapes the picker leaves alone.
const HEAD = `
<style data-zeros-style-source="app">
  @layer theme, utilities;
  @layer utilities {
    .hover\\:bg-red-500 { &:hover { @media (hover: hover) { background-color: rgb(239, 68, 68); } } }
    .disabled\\:opacity-50 { &:disabled { opacity: 0.5; } }
  }
</style>
<style>
  .btn { background-color: rgb(0, 0, 128); color: white; padding: 4px; transition: background-color 2s; }
  .btn:hover { background-color: rgb(0, 0, 255); }
  .btn:focus { box-shadow: rgb(1, 2, 3) 0px 0px 0px 1px; }
  .btn:focus-visible { outline: rgb(0, 128, 0) solid 2px; }
  .btn:active { transform: scale(0.5); }
  .btn:disabled { opacity: 0.25; }
  .btn:hover:focus { color: rgb(9, 9, 9); }
  .card:hover { color: rgb(255, 0, 0); }
  .card:focus { color: rgb(0, 255, 0); }
  .card:disabled { color: rgb(0, 0, 255); }
  .row:hover .label { color: rgb(255, 0, 0); }
  .item:not(:hover) { opacity: 0.8; }
  .item:is(:hover) { color: rgb(255, 0, 0); }
  .item:hover::after { content: "x"; }
  @layer { .anon:hover { color: rgb(255, 0, 0); } }
  .deep { .x { &:hover { color: rgb(255, 0, 0); } } }
  @media (min-width: 1px) { @supports (display: grid) { .wrapped:hover { color: rgb(1, 1, 1); } } }
  .forced:hover { color: rgb(2, 2, 2) !important; }
  .forced { color: rgb(3, 3, 3) !important; }
  .late:hover { color: rgb(255, 0, 0); }
  .late.late-b { color: rgb(0, 0, 255); }
</style>`;
const BODY = `
<button data-oid="button" class="btn">Go</button>
<button data-oid="tw" class="hover:bg-red-500 disabled:opacity-50">Tw</button>
<div data-oid="card" class="card">Card</div>
<div data-oid="row" class="row"><span data-oid="label" class="label">Label</span></div>
<div data-oid="item" class="item">Item</div>
<div data-oid="anon" class="anon">Anon</div>
<div class="deep"><div data-oid="deep" class="x">Deep</div></div>
<div data-oid="wrapped" class="wrapped">Wrapped</div>
<div data-oid="forced" class="forced">Forced</div>
<div data-oid="late" class="late late-b">Late</div>
<div data-oid="drawn" style="width: 40px; border-radius: 3px">Drawn</div>
<p data-oid="text">Some text</p>`;

async function fixture(browser: Browser, head = HEAD, body = BODY): Promise<Page> {
  const page = await browser.newPage();
  await page.evaluate(
    async ({ source, head, body }) => {
      document.head.innerHTML = head;
      document.body.innerHTML = body;
      const runtimeWindow = window as unknown as RuntimeWindow;
      runtimeWindow.__zerosDesignSourceVersion = "a".repeat(24);
      runtimeWindow.runtimeEvents = [];
      runtimeWindow.runtimeEventMessages = [];
      new Function(source)();
      const channel = new MessageChannel();
      const pending = new Map<string, (value: { result?: unknown; error?: unknown; message: unknown }) => void>();
      let count = 0;
      const ready = new Promise<void>((resolve) => {
        channel.port1.onmessage = (event) => {
          if (event.data.type === "event") {
            runtimeWindow.runtimeEventMessages.push(event.data);
            runtimeWindow.runtimeEvents.push(event.data.event === "stateReleased" ? `stateReleased:${event.data.payload.holdId}` : event.data.event);
            if (event.data.event === "ready") resolve();
          }
          if (event.data.type === "response") {
            pending.get(event.data.requestId)?.({ result: event.data.result, error: event.data.error, message: event.data });
            pending.delete(event.data.requestId);
          }
        };
      });
      runtimeWindow.runtimeRequest = (method, args) =>
        new Promise((resolve) => {
          const requestId = String(++count);
          pending.set(requestId, resolve);
          channel.port1.postMessage({
            protocol: "zeros-design-runtime",
            version: 2,
            type: "request",
            sourceVersion: runtimeWindow.__zerosDesignSourceVersion,
            requestId,
            method,
            args,
          });
        });
      channel.port1.start();
      window.postMessage(
        {
          protocol: "zeros-design-runtime",
          version: 2,
          type: "handshake",
          sourceVersion: runtimeWindow.__zerosDesignSourceVersion,
          features: ["holdNodeState", "releaseNodeState"],
        },
        "*",
        [channel.port2],
      );
      await ready;
    },
    { source: DESIGN_RUNTIME_SOURCE, head, body },
  );
  return page;
}

const request = async (page: Page, method: string, args: Record<string, unknown>) => {
  const reply = await page.evaluate(
    ({ method, args }) => (window as unknown as RuntimeWindow).runtimeRequest(method, args),
    { method, args },
  );
  expect(isDesignRuntimeFrameMessage(reply.message)).toBe(true);
  return reply;
};
const details = async (page: Page, nodeId: string) =>
  (await request(page, "getNodeDetails", { nodeId })).result as DesignRuntimeNodeDetails;
const hold = async (page: Page, nodeId: string, state: string, holdId = "hold") =>
  (await request(page, "holdNodeState", { nodeId, state, holdId })).result as DesignRuntimeNodeDetails;
const events = (page: Page) => page.evaluate(() => (window as unknown as RuntimeWindow).runtimeEvents.splice(0));
const computed = (page: Page, nodeId: string, property: string) =>
  page.locator(`[data-oid="${nodeId}"]`).evaluate(
    (element, property) => getComputedStyle(element).getPropertyValue(property),
    property,
  );

describe("layer states in Chromium", () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await fixture(browser);
  });
  afterAll(async () => {
    await browser?.close();
  });

  it("offers the states a layer's own rules give it and it can be in, in menu order", async () => {
    expect((await details(page, "button")).states).toEqual(["hover", "focus", "focus-visible", "active", "disabled"]);
    // A div cannot take focus or be disabled; its rules for them never apply.
    expect((await details(page, "card")).states).toEqual(["hover"]);
    expect((await details(page, "drawn")).states).toBeUndefined();
    expect((await details(page, "text")).states).toBeUndefined();
  });

  it("offers a Tailwind v4 variant nested under its utility class", async () => {
    expect((await details(page, "tw")).states).toEqual(["hover", "disabled"]);
  });

  it("leaves ancestor, functional, negated, pseudo-element, anonymous-layer and deeply nested states alone", async () => {
    for (const nodeId of ["row", "label", "item", "anon", "deep"]) {
      expect((await details(page, nodeId)).states, nodeId).toBeUndefined();
    }
  });

  it("holds a state with the values the browser gives it, then releases without a trace", async () => {
    await page.mouse.move(0, 400);
    const held = await hold(page, "button", "hover");
    expect(held.heldState).toBe("hover");
    expect(held.styles.backgroundColor).toBe("rgb(0, 0, 255)");
    expect(held.authoredStyles?.["background-color"]).toMatchObject({
      origin: "frame",
      selector: ".btn:hover",
      state: "hover",
      value: "rgb(0, 0, 255)",
    });
    // The transition does not run: the held value is there at once.
    expect(await computed(page, "button", "background-color")).toBe("rgb(0, 0, 255)");
    // Reads while held come back marked, never as Default.
    expect((await details(page, "button")).heldState).toBe("hover");
    expect((await details(page, "card")).heldState).toBeUndefined();

    expect((await request(page, "releaseNodeState", {})).result).toEqual({ released: true });
    expect(await computed(page, "button", "background-color")).toBe("rgb(0, 0, 128)");
    expect(await page.evaluate(() => [
      document.querySelectorAll("style[data-zeros-runtime-state]").length,
      document.querySelectorAll("[data-zd-state]").length,
    ])).toEqual([0, 0]);
    const released = await details(page, "button");
    expect(released.heldState).toBeUndefined();
    expect(released.authoredStyles?.["background-color"]).toMatchObject({ selector: ".btn", value: "rgb(0, 0, 128)" });
    expect(released.authoredStyles?.["background-color"]?.state).toBeUndefined();
    expect((await request(page, "releaseNodeState", {})).result).toEqual({ released: false });
  });

  it("matches what a real hover shows on the class-styled button", async () => {
    await page.locator('[data-oid="button"]').hover();
    // The 2s transition has reached its end colour.
    await page.waitForFunction(() =>
      getComputedStyle(document.querySelector('[data-oid="button"]')!).backgroundColor === "rgb(0, 0, 255)");
    const real = await computed(page, "button", "background-color");
    await page.mouse.move(0, 400);
    await hold(page, "button", "hover");
    expect(await computed(page, "button", "background-color")).toBe(real);
    await request(page, "releaseNodeState", {});
  });

  it("holds focus visible with focus, and active with hover", async () => {
    await hold(page, "button", "focus-visible");
    expect(await computed(page, "button", "outline-color")).toBe("rgb(0, 128, 0)");
    expect(await computed(page, "button", "box-shadow")).toBe("rgb(1, 2, 3) 0px 0px 0px 1px");
    // A combined :hover:focus rule needs both; focus visible is not a hover.
    expect(await computed(page, "button", "color")).toBe("rgb(255, 255, 255)");
    const active = await hold(page, "button", "active");
    expect(active.heldState).toBe("active");
    expect(await computed(page, "button", "transform")).toBe("matrix(0.5, 0, 0, 0.5, 0, 0)");
    expect(await computed(page, "button", "background-color")).toBe("rgb(0, 0, 255)");
    expect(await page.locator('[data-oid="button"]').getAttribute("data-zd-state")).toBe("hover active");
    await request(page, "releaseNodeState", {});
  });

  it("keeps a copy's layer, @media and @supports, and !important", async () => {
    const tw = await hold(page, "tw", "hover");
    expect(tw.styles.backgroundColor).toBe("rgb(239, 68, 68)");
    expect(tw.authoredStyles?.["background-color"]).toMatchObject({
      origin: "source",
      sourceId: "app",
      selector: ".hover\\:bg-red-500:hover",
      state: "hover",
    });
    const copies = await page.evaluate(() => {
      const sheet = (document.querySelector("style[data-zeros-runtime-state]") as HTMLStyleElement).sheet!;
      return Array.from(sheet.cssRules, (rule) => rule.cssText.replace(/\s+/g, " "));
    });
    expect(copies.join("\n")).toMatch(/^@layer utilities \{ @media \(hover: hover\) \{ \.hover\\:bg-red-500\[data-zd-state~="hover"\]/);
    await request(page, "releaseNodeState", {});

    await hold(page, "wrapped", "hover");
    expect(await computed(page, "wrapped", "color")).toBe("rgb(1, 1, 1)");
    await hold(page, "forced", "hover");
    // Both rules are important; the state's has the higher specificity.
    expect(await computed(page, "forced", "color")).toBe("rgb(2, 2, 2)");
    await request(page, "releaseNodeState", {});
  });

  // Known limit: a copy sits after every original rule in its layer, so a
  // later rule of equal specificity that beats the state for real loses to
  // the held copy.
  it("pins the known order case: a later rule of equal specificity", async () => {
    await page.locator('[data-oid="late"]').hover();
    expect(await computed(page, "late", "color")).toBe("rgb(0, 0, 255)");
    await page.mouse.move(0, 400);
    await hold(page, "late", "hover");
    expect(await computed(page, "late", "color")).toBe("rgb(255, 0, 0)");
    await request(page, "releaseNodeState", {});
  });

  it("refuses a state the layer does not offer", async () => {
    const card = await request(page, "holdNodeState", { nodeId: "card", state: "focus", holdId: "h" });
    expect(card.error).toBeDefined();
    const unknown = await request(page, "holdNodeState", { nodeId: "button", state: "visited", holdId: "h" });
    expect(unknown.error).toBeDefined();
    const anonymous = await request(page, "holdNodeState", { nodeId: "button", state: "hover" });
    expect(anonymous.error).toBeDefined();
    expect(await page.evaluate(() => document.querySelectorAll("style[data-zeros-runtime-state]").length)).toBe(0);
  });

  it("holds and releases without a snapshot, mutation or revision", async () => {
    const before = await request(page, "getSnapshot", {});
    await events(page);
    await hold(page, "button", "hover", "first");
    // Holding another state replaces the hold the host asked for: no event.
    await hold(page, "button", "focus", "second");
    await request(page, "releaseNodeState", {});
    // Events travel on the reply port: anything these sent is in before the
    // snapshot's reply.
    const after = await request(page, "getSnapshot", {});
    expect(await events(page)).toEqual([]);
    expect((after.result as { revision: number }).revision).toBe((before.result as { revision: number }).revision);
  });

  it("never lets a capture see the held state, and keeps holding after it", async () => {
    await hold(page, "button", "hover");
    const seen = await page.evaluate(async () => {
      const serialize = XMLSerializer.prototype.serializeToString;
      const captured: string[] = [];
      const live: string[] = [];
      XMLSerializer.prototype.serializeToString = function (this: XMLSerializer, node: Node) {
        const text = serialize.call(this, node);
        captured.push(text);
        const button = document.querySelector('[data-oid="button"]')!;
        live.push(getComputedStyle(button).backgroundColor);
        return text;
      };
      try {
        await (window as unknown as RuntimeWindow).runtimeRequest("captureScreenshot", {});
      } finally {
        XMLSerializer.prototype.serializeToString = serialize;
      }
      return { captured, live };
    });
    expect(seen.captured.length).toBeGreaterThan(0);
    for (const text of seen.captured) {
      expect(text).not.toContain("data-zd-state");
      expect(text).not.toContain("data-zeros-runtime-state");
    }
    expect(seen.live).toEqual(seen.captured.map(() => "rgb(0, 0, 128)"));
    expect(await computed(page, "button", "background-color")).toBe("rgb(0, 0, 255)");
    expect((await details(page, "button")).heldState).toBe("hover");
    await request(page, "releaseNodeState", {});
  });

  it.each([
    ["setTheme", { theme: "dark" }],
    ["previewStyles", { nodeId: "button", styles: { color: "red" } }],
    ["commitStyles", { nodeId: "button", styles: {} }],
    ["setNodeVisibility", { nodeId: "card", hidden: false }],
  ])("releases before %s and says so before its reply", async (method, args) => {
    await hold(page, "button", "hover", method);
    await events(page);
    await request(page, method, args);
    expect((await events(page))[0]).toBe(`stateReleased:${method}`);
    expect(await page.evaluate(() => [
      document.querySelectorAll("style[data-zeros-runtime-state]").length,
      document.querySelectorAll("[data-zd-state]").length,
    ])).toEqual([0, 0]);
    expect((await request(page, "releaseNodeState", {})).result).toEqual({ released: false });
    await request(page, "clearPreviewStyles", {});
  });

  it("keeps the hold when the theme it is asked for is the one shown, and lets go when it changes", async () => {
    await request(page, "setTheme", { theme: "dark" });
    await hold(page, "button", "hover", "same-theme");
    await events(page);
    await request(page, "setTheme", { theme: "dark" });
    expect(await events(page)).toEqual([]);
    expect(await computed(page, "button", "background-color")).toBe("rgb(0, 0, 255)");
    expect((await details(page, "button")).heldState).toBe("hover");
    await request(page, "setTheme", { theme: null });
    expect((await events(page))[0]).toBe("stateReleased:same-theme");
    expect(await computed(page, "button", "background-color")).toBe("rgb(0, 0, 128)");
    // And from no theme: re-applying none keeps it, a theme lets go.
    await hold(page, "button", "hover", "no-theme");
    await events(page);
    await request(page, "setTheme", { theme: null });
    expect(await events(page)).toEqual([]);
    expect((await details(page, "button")).heldState).toBe("hover");
    await request(page, "setTheme", { theme: "dark" });
    expect((await events(page))[0]).toBe("stateReleased:no-theme");
    await request(page, "setTheme", { theme: null });
  });

  it("keeps a held frame root's values out of every snapshot, and keeps holding after one", async () => {
    const scoped = await fixture(
      browser,
      `<style>.shell { background-color: rgb(0, 0, 128); } .shell:hover { background-color: rgb(0, 0, 255); }</style>`,
      `<main data-oid="shell" data-zeros-frame-root class="shell"><p data-oid="copy">Copy</p></main>`,
    );
    try {
      expect(((await request(scoped, "getSnapshot", {})).result as { frame: DesignRuntimeNodeDetails }).frame.oid).toBe("shell");
      await hold(scoped, "shell", "hover", "root");
      const taken = (await request(scoped, "getSnapshot", {})).result as { frame: DesignRuntimeNodeDetails };
      expect(taken.frame.heldState).toBeUndefined();
      expect(taken.frame.styles.backgroundColor).toBe("rgb(0, 0, 128)");
      expect(taken.frame.authoredStyles?.["background-color"]?.state).toBeUndefined();
      // The held view is as it was, and reads of it are still marked.
      expect(await computed(scoped, "shell", "background-color")).toBe("rgb(0, 0, 255)");
      const after = await details(scoped, "shell");
      expect(after.heldState).toBe("hover");
      expect(after.authoredStyles?.["background-color"]).toMatchObject({ selector: ".shell:hover", state: "hover" });
      // The snapshot an observed change publishes is Default too.
      await events(scoped);
      await scoped.evaluate(() => document.querySelector('[data-oid="copy"]')!.textContent = "Changed");
      await vi.waitFor(() => scoped.evaluate(() => (window as unknown as RuntimeWindow).runtimeEventMessages.some(
        (message) => (message as { event?: string }).event === "mutation")).then((seen) => expect(seen).toBe(true)));
      const published = await scoped.evaluate(() => ((window as unknown as RuntimeWindow).runtimeEventMessages.filter(
        (message) => (message as { event?: string }).event === "mutation").at(-1) as { payload: { frame: DesignRuntimeNodeDetails } }).payload.frame);
      expect(published.heldState).toBeUndefined();
      expect(published.styles.backgroundColor).toBe("rgb(0, 0, 128)");
      expect(await computed(scoped, "shell", "background-color")).toBe("rgb(0, 0, 255)");
    } finally {
      await scoped.close();
    }
  });

  it("releases when the held layer leaves the document", async () => {
    const scoped = await fixture(browser);
    try {
      await hold(scoped, "card", "hover", "removed");
      await events(scoped);
      await scoped.evaluate(() => document.querySelector('[data-oid="card"]')!.remove());
      // After the observer's debounce.
      await vi.waitFor(async () =>
        expect(await scoped.evaluate(() => (window as unknown as RuntimeWindow).runtimeEvents.slice())).toEqual(["stateReleased:removed", "mutation"]),
      { timeout: 5_000 });
      expect(await scoped.evaluate(() => document.querySelectorAll("style[data-zeros-runtime-state]").length)).toBe(0);
    } finally {
      await scoped.close();
    }
  });
});

// Selector lists, at-rules inside nesting, and a rule written for the layer.
describe("layer states across selector shapes in Chromium", () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await fixture(browser, `<style>
      .a { color: rgb(0, 0, 1); }
      .a:hover, .b:hover { color: rgb(0, 0, 2); }
      .a:focus, .c:hover { outline: rgb(0, 0, 3) solid 1px; }
      .nest { color: rgb(0, 0, 4); @media (min-width: 1px) { &:hover { color: rgb(0, 0, 5); } } }
      [data-oid="own"] { color: rgb(0, 0, 6); }
      [data-oid="own"]:hover { color: rgb(0, 0, 7); }
    </style>`, `
      <div data-oid="list" class="a">List</div>
      <div data-oid="nest" class="nest">Nest</div>
      <div data-oid="own">Own</div>`);
  });
  afterAll(async () => {
    await browser?.close();
  });

  it("offers and copies only the branches of a selector list that name the layer", async () => {
    // .a:focus names it, but a div cannot take focus; .c:hover does not name it.
    expect((await details(page, "list")).states).toEqual(["hover"]);
    const held = await hold(page, "list", "hover");
    expect(held.styles.color).toBe("rgb(0, 0, 2)");
    expect(held.authoredStyles?.color).toMatchObject({ selector: ".a:hover, .b:hover", state: "hover", subjectClasses: ["a"] });
    const copies = await page.evaluate(() =>
      Array.from((document.querySelector("style[data-zeros-runtime-state]") as HTMLStyleElement).sheet!.cssRules, (rule) => rule.cssText));
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatch(/^\.a\[data-zd-state~="hover"\] \{/);
    // The unrelated outline rule was not copied for a hover.
    expect(await computed(page, "list", "outline-style")).toBe("none");
    await request(page, "releaseNodeState", {});
  });

  it("finds a state under @media inside a nested rule and keeps the condition on its copy", async () => {
    expect((await details(page, "nest")).states).toEqual(["hover"]);
    const held = await hold(page, "nest", "hover");
    expect(held.styles.color).toBe("rgb(0, 0, 5)");
    expect(held.authoredStyles?.color).toMatchObject({ selector: ".nest:hover", state: "hover" });
    // Nested and conditional: never reported as the layer's own.
    expect(held.authoredStyles?.color?.conditional).toBeUndefined();
    const copies = await page.evaluate(() =>
      Array.from((document.querySelector("style[data-zeros-runtime-state]") as HTMLStyleElement).sheet!.cssRules, (rule) => rule.cssText.replace(/\s+/g, " ")));
    expect(copies.join("\n")).toMatch(/^@media \(min-width: 1px\) \{ \.nest\[data-zd-state~="hover"\]/);
    await request(page, "releaseNodeState", {});
  });

  it("does not report a held rule written for the layer as its own change", async () => {
    const rest = await details(page, "own");
    expect(rest.authoredStyles?.color).toMatchObject({ selector: '[data-oid="own"]', value: "rgb(0, 0, 6)" });
    const held = await hold(page, "own", "hover");
    expect(held.authoredStyles?.color).toMatchObject({ selector: '[data-oid="own"]:hover', state: "hover", value: "rgb(0, 0, 7)" });
    expect(held.authoredStyles?.color?.replaced).toBeUndefined();
    expect(held.authoredStyles?.color?.declared).toBeUndefined();
    await request(page, "releaseNodeState", {});
  });
});

// The runtime's real output for every new field passes the validator the
// bridge applies, with selectors and class names written the odd ways CSS
// allows.
describe("layer state wire output in Chromium", () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await fixture(browser, `<style>
      .\\31 23:hover { color: rgb(1, 1, 1); }
      .a\\.b:focus-visible { outline: rgb(2, 2, 2) solid 1px; }
      [data-label="a,b"]:hover, .x\\:y:hover { background-color: rgb(3, 3, 3); }
      .\\31 23:disabled { opacity: 0.4; }
    </style>`, '<button data-oid="odd" class="123 a.b x:y" data-label="a,b">Odd</button>');
  });
  afterAll(async () => {
    await browser?.close();
  });

  it("emits states, held details, winners' state and the release event its validators accept", async () => {
    const rest = await details(page, "odd");
    expect(rest.states).toEqual(["hover", "focus-visible", "disabled"]);
    expect(isDesignRuntimeNodeDetails(rest)).toBe(true);
    for (const state of ["hover", "focus-visible", "disabled"]) {
      const held = await hold(page, "odd", state, `hold:${state}`);
      expect(held.heldState).toBe(state);
      expect(isDesignRuntimeNodeDetails(held), state).toBe(true);
      expect(Object.values(held.authoredStyles ?? {}).some((style) => style.state === state), state).toBe(true);
    }
    const hover = await hold(page, "odd", "hover", "hold-odd");
    expect(hover.authoredStyles?.["background-color"]).toMatchObject({
      selector: '[data-label="a,b"]:hover, .x\\:y:hover',
      state: "hover",
    });
    expect(hover.authoredStyles?.color).toMatchObject({ state: "hover", subjectClasses: ["123"] });
    await page.evaluate(() => { (window as unknown as RuntimeWindow).runtimeEventMessages.length = 0; });
    await request(page, "setTheme", { theme: "dark" });
    const messages = await page.evaluate(() => (window as unknown as RuntimeWindow).runtimeEventMessages);
    const released = messages.filter((message) => (message as { event?: string }).event === "stateReleased");
    expect(released).toHaveLength(1);
    expect(isDesignRuntimeFrameMessage(released[0])).toBe(true);
    expect(released[0]).toMatchObject({ payload: { holdId: "hold-odd" } });
    expect((await details(page, "odd")).heldState).toBeUndefined();
  });
});

// element.matches calls per getNodeDetails. The cascade's own per-rule cost
// is unchanged and cached per element; a second read of the same element
// therefore counts state detection alone: one stateless match per state rule
// that names every class its subject requires, none for a layer no state rule
// names.
describe("state detection cost per selection", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  const counted = async (nodeId: string) => {
    const page = await fixture(browser);
    try {
      return await page.evaluate(async (nodeId) => {
        const runtime = window as unknown as RuntimeWindow;
        await runtime.runtimeRequest("getNodeDetails", { nodeId: "card" });
        const counts = { cold: 0, warm: 0, queries: 0 };
        let phase: "cold" | "warm" = "cold";
        const matches = Element.prototype.matches;
        Element.prototype.matches = function (this: Element, selector: string) {
          counts[phase] += 1;
          return matches.call(this, selector);
        };
        for (const prototype of [Document.prototype, Element.prototype, DocumentFragment.prototype]) {
          const query = prototype.querySelectorAll;
          prototype.querySelectorAll = function (this: ParentNode, selector: string) {
            counts.queries += 1;
            return query.call(this, selector);
          } as typeof query;
        }
        await runtime.runtimeRequest("getNodeDetails", { nodeId });
        phase = "warm";
        await runtime.runtimeRequest("getNodeDetails", { nodeId });
        return counts;
      }, nodeId);
    } finally {
      await page.close();
    }
  };

  it("adds no query, one match per state rule naming the layer, and nothing elsewhere", async () => {
    const measured = {
      button: await counted("button"),
      drawn: await counted("drawn"),
      text: await counted("text"),
    };
    expect(measured.button.queries + measured.drawn.queries + measured.text.queries).toBe(0);
    // Seven .btn state rules name its class; detection stops once all five
    // states are found, after the first five.
    expect(measured.button.warm).toBe(5);
    expect(measured.button.cold - measured.button.warm).toBe(measured.drawn.cold);
    expect(measured.drawn.warm).toBe(0);
    expect(measured.text.warm).toBe(0);
  });
});
