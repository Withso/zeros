import { chromium, type Browser, type Page } from "@playwright/test";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  DESIGN_RUNTIME_SOURCE,
  isDesignRuntimeFrameMessage,
} from "../design-runtime";

type Reply = { ok: boolean; result?: unknown; error?: { code: string } };
type PlaybackWindow = typeof window & {
  __zerosDesignSourceVersion?: string;
  request: (method: string, args: Record<string, unknown>) => Promise<Reply>;
  runtimePort: MessagePort;
  runtimeEvents: Array<{ event: string; payload: Record<string, unknown> }>;
};

const sourceVersion = "7".repeat(24);
const markup = `<!doctype html><html><head><style>
  @keyframes wash { from { opacity: .3 } to { opacity: .9 } }
  @keyframes slide { from { translate: 0 } to { translate: 20px } }
  main { animation: wash .12s linear infinite }
  #finite { animation: slide .15s linear both }
  #pseudo::before { content: 'motion'; animation: wash .12s linear infinite !important }
  #paused { animation: wash 1s linear infinite paused }
  #delayed { animation: slide 1s 2s both }
  #hover { width: 80px; height: 40px; transition: transform .4s linear }
  #hover:hover { transform: translateX(40px) }
  @media (prefers-reduced-motion: reduce) { main { animation: none } }
</style></head><body><main data-oid="root">
  <p id="finite" data-oid="finite">Finite</p><p id="pseudo">Pseudo</p>
  <p id="inline" style="animation: wash .12s linear infinite, slide .12s linear infinite !important; color: red">Inline</p>
  <p id="paused">Paused</p><p id="delayed">Delayed</p>
  <button id="hover">Hover</button><input id="check" type="checkbox">
  <details><summary>Open</summary>Content</details>
  <a id="external" href="https://example.invalid/">Leave</a>
  <form><button type="submit">Submit</button></form>
  <svg width="50" height="50"><rect width="10" height="10"><animate attributeName="x" values="0;30;0" dur=".2s" repeatCount="indefinite" /></rect></svg>
</main></body></html>`;

async function connect(page: Page, features?: string[]): Promise<string[]> {
  await page.setContent(markup);
  return page.evaluate(
    ({ source, sourceVersion, features }) =>
      new Promise<string[]>((resolve, reject) => {
        const testWindow = window as PlaybackWindow;
        testWindow.__zerosDesignSourceVersion = sourceVersion;
        testWindow.runtimeEvents = [];
        const channel = new MessageChannel();
        testWindow.runtimePort = channel.port1;
        const pending = new Map<string, (reply: Reply) => void>();
        let sequence = 0;
        const timeout = window.setTimeout(
          () => reject(new Error("Runtime handshake timed out")),
          5_000,
        );
        testWindow.request = (method, args) =>
          new Promise<Reply>((done) => {
            const requestId = String(++sequence);
            pending.set(requestId, done);
            channel.port1.postMessage({
              protocol: "zeros-design-runtime",
              version: 2,
              type: "request",
              sourceVersion,
              requestId,
              method,
              args,
            });
          });
        channel.port1.onmessage = ({ data }) => {
          if (data.type === "response") {
            pending.get(data.requestId)?.(data);
            pending.delete(data.requestId);
          } else {
            testWindow.runtimeEvents.push(data);
            if (data.event === "ready") {
              window.clearTimeout(timeout);
              resolve(data.payload.capabilities.methods);
            }
          }
        };
        channel.port1.start();
        new Function(source)();
        window.postMessage(
          {
            protocol: "zeros-design-runtime",
            version: 2,
            type: "handshake",
            sourceVersion,
            features,
          },
          "*",
          [channel.port2],
        );
      }),
    { source: DESIGN_RUNTIME_SOURCE, sourceVersion, features },
  );
}

const request = (page: Page, method: string, args: Record<string, unknown>) =>
  page.evaluate(
    ({ method, args }) => (window as PlaybackWindow).request(method, args),
    { method, args },
  );
const play = (page: Page, sessionId = "play-1", playing = true) =>
  request(page, "setPlayback", { sessionId, playing });
const animationCount = (page: Page) =>
  page.evaluate(() => document.getAnimations().length);

describe("whole-frame Design playback", () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    page = await browser.newPage();
    page.setDefaultTimeout(3_000);
  });
  afterEach(async () => {
    await page?.close();
  });

  it("negotiates playback without breaking hosts that predate it", async () => {
    const methods = await connect(page);
    expect(methods).not.toContain("setPlayback");
    expect(await play(page)).toMatchObject({
      ok: false,
      error: { code: "METHOD_NOT_SUPPORTED" },
    });
    expect(await animationCount(page)).toBe(0);
  });

  it("restarts root, descendant, pseudo-element and important inline animations with authored timing", async () => {
    expect(await connect(page, ["setPlayback", "unknownFeature"])).toContain(
      "setPlayback",
    );
    expect(await animationCount(page)).toBe(0);
    const inlineStyle = await page.locator("#inline").getAttribute("style");
    const rootStyle = await page.locator("html").getAttribute("style");
    expect(await play(page)).toMatchObject({
      ok: true,
      result: { playing: true, sessionId: "play-1" },
    });
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document
              .getAnimations()
              .filter((animation) => animation.playState === "running").length,
        ),
      )
      .toBe(6);
    const timing = await page.evaluate(() => ({
      root: document
        .querySelector("main")!
        .getAnimations()[0]
        .effect!.getTiming().iterations,
      paused: document.querySelector("#paused")!.getAnimations()[0].playState,
      delayed: document
        .querySelector("#delayed")!
        .getAnimations()[0]
        .effect!.getTiming().delay,
      svgPaused: document.querySelector("svg")!.animationsPaused(),
    }));
    expect(timing).toEqual({
      root: Infinity,
      paused: "paused",
      delayed: 2_000,
      svgPaused: false,
    });
    // Observe several full iterations, not merely a running flag at time zero.
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document
              .querySelector("main")!
              .getAnimations()[0]
              .effect!.getComputedTiming().currentIteration,
        ),
      )
      .toBeGreaterThan(4);
    expect(await page.locator("#inline").getAttribute("style")).toBe(
      inlineStyle,
    );
    expect(await page.locator("html").getAttribute("style")).toBe(rootStyle);
    expect(await play(page, "play-1", false)).toMatchObject({
      ok: true,
      result: { playing: false, sessionId: null },
    });
    expect(await animationCount(page)).toBe(0);
    expect(
      await page.evaluate(() =>
        document.querySelector("svg")!.animationsPaused(),
      ),
    ).toBe(true);
    expect(
      await page.evaluate(
        () => getComputedStyle(document.querySelector("main")!).animationName,
      ),
    ).toBe("wash");
    // Runtime-only restarts must neither dirty the source nor publish mutations.
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as PlaybackWindow).runtimeEvents.filter(
              (event) => event.event === "mutation",
            ).length,
        ),
      )
      .toBe(0);
  });

  it("restarts finite motion only on a new session and ignores a retired session's stop", async () => {
    await connect(page, ["setPlayback"]);
    expect((await play(page)).ok).toBe(true);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document.querySelector("#finite")!.getAnimations()[0]?.playState,
        ),
      )
      .toBe("finished");
    expect((await play(page)).ok).toBe(true);
    expect(
      await page.evaluate(
        () => document.querySelector("#finite")!.getAnimations()[0].playState,
      ),
    ).toBe("finished");
    expect((await play(page, "play-2")).ok).toBe(true);
    expect(
      await page.evaluate(
        () => document.querySelector("#finite")!.getAnimations()[0].playState,
      ),
    ).toBe("running");
    expect(await play(page, "play-1", false)).toMatchObject({
      result: { playing: true, sessionId: "play-2" },
    });
    await page.evaluate(
      (sourceVersion) =>
        (window as PlaybackWindow).runtimePort.postMessage({
          protocol: "zeros-design-runtime",
          version: 2,
          type: "teardown",
          sourceVersion,
        }),
      sourceVersion,
    );
    await expect.poll(() => animationCount(page)).toBe(0);
  });

  it("respects the document's authored reduced-motion preference", async () => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await connect(page, ["setPlayback"]);
    expect((await play(page)).ok).toBe(true);
    expect(
      await page
        .locator("main")
        .evaluate((node) => node.getAnimations().length),
    ).toBe(0);
    expect(
      await page
        .locator("#inline")
        .evaluate((node) => node.getAnimations().length),
    ).toBe(2);
  });

  it("restarts motion even when the document root authors a discrete display transition", async () => {
    await connect(page, ["setPlayback"]);
    const style = "transition: display 1s allow-discrete !important";
    await page
      .locator("html")
      .evaluate((root, style) => root.setAttribute("style", style), style);
    expect((await play(page)).ok).toBe(true);
    expect(
      await page
        .locator("main")
        .evaluate((node) => node.getAnimations().length),
    ).toBe(1);
    expect(await page.locator("html").getAttribute("style")).toBe(style);
  });

  it("allows hover transitions and native controls while containing navigation and submission", async () => {
    await connect(page, ["setPlayback"]);
    expect((await play(page)).ok).toBe(true);
    await page.locator("#hover").hover({ position: { x: 60, y: 20 } });
    await expect
      .poll(() =>
        page
          .locator("#hover")
          .evaluate((element) => getComputedStyle(element).transform),
      )
      .toBe("matrix(1, 0, 0, 1, 40, 0)");
    await page.mouse.move(500, 500);
    await expect
      .poll(() =>
        page
          .locator("#hover")
          .evaluate((element) => getComputedStyle(element).transform),
      )
      .toBe("none");
    await page.locator("#check").check();
    expect(await page.locator("#check").isChecked()).toBe(true);
    await page.locator("summary").click();
    expect(await page.locator("details").getAttribute("open")).toBe("");
    expect(
      await page.evaluate(() => {
        const click = new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
        });
        document.querySelector("#external")!.dispatchEvent(click);
        const submit = new SubmitEvent("submit", {
          bubbles: true,
          cancelable: true,
        });
        document.querySelector("form")!.dispatchEvent(submit);
        const drop = new DragEvent("drop", { bubbles: true, cancelable: true });
        document.body.dispatchEvent(drop);
        return {
          navigationBlocked: click.defaultPrevented,
          submitBlocked: submit.defaultPrevented,
          dropBlocked: drop.defaultPrevented,
        };
      }),
    ).toEqual({
      navigationBlocked: true,
      submitBlocked: true,
      dropBlocked: true,
    });
  });

  it("stops on Escape and document hiding with exact source/session notifications", async () => {
    await connect(page, ["setPlayback"]);
    expect((await play(page)).ok).toBe(true);
    await page.keyboard.press("Escape");
    await expect.poll(() => animationCount(page)).toBe(0);
    expect((await play(page, "play-2")).ok).toBe(true);
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", {
        value: true,
        configurable: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect.poll(() => animationCount(page)).toBe(0);
    expect(
      await page.evaluate(() =>
        (window as PlaybackWindow).runtimeEvents
          .filter((event) => event.event === "playbackStopped")
          .map((event) => event.payload),
      ),
    ).toEqual([
      { sourceVersion, sessionId: "play-1", reason: "escape" },
      { sourceVersion, sessionId: "play-2", reason: "hidden" },
    ]);
    expect(await play(page, "play-3")).toMatchObject({
      ok: false,
      error: { code: "BAD_REQUEST" },
    });
  });

  it("rejects malformed playback requests and malformed lifecycle events", async () => {
    await connect(page, ["setPlayback"]);
    for (const args of [
      { playing: true },
      { playing: "true", sessionId: "one" },
      { playing: false, sessionId: "" },
      { playing: true, sessionId: "x".repeat(129) },
    ]) {
      expect(await request(page, "setPlayback", args)).toMatchObject({
        ok: false,
        error: { code: "BAD_REQUEST" },
      });
    }
    expect(await animationCount(page)).toBe(0);
    const event = {
      protocol: "zeros-design-runtime",
      version: 2,
      type: "event",
      event: "playbackStopped",
      payload: { sourceVersion, sessionId: "play-1", reason: "escape" },
    };
    expect(isDesignRuntimeFrameMessage(event)).toBe(true);
    for (const patch of [
      { sourceVersion: "wrong" },
      { sessionId: "" },
      { sessionId: "x".repeat(129) },
      { reason: "unknown" },
    ]) {
      expect(
        isDesignRuntimeFrameMessage({
          ...event,
          payload: { ...event.payload, ...patch },
        }),
      ).toBe(false);
    }
  });
});
