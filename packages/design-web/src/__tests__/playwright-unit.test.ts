import { afterEach, describe, expect, it, vi } from "vitest";

import { createDesignWebDocumentState } from "../revision";
import {
  PlaywrightDesignRenderer,
  prepareDesignHeadlessHtml,
  type PlaywrightBrowserContextLike,
  type PlaywrightBrowserLike,
  type PlaywrightBrowserTypeLike,
  type PlaywrightPageLike,
} from "../playwright";

const VIEWPORT = {
  width: 800,
  height: 600,
  deviceScaleFactor: 1,
  colorScheme: "light" as const,
  reducedMotion: "reduce" as const,
};

function state(documentId: string, html?: string) {
  return createDesignWebDocumentState({
    documentId,
    entryFile: "index.html",
    files: {
      "index.html":
        html ??
        '<!doctype html><html><body><main data-oid="root">Design</main></body></html>',
      "styles.css": "main { color: #123456; }",
    },
  });
}

function browserHarness(): {
  browserType: PlaywrightBrowserTypeLike;
  browser: PlaywrightBrowserLike;
  context: PlaywrightBrowserContextLike;
  page: PlaywrightPageLike;
} {
  const page: PlaywrightPageLike = {
    setContent: vi.fn(async () => {}),
    evaluate: vi.fn(async () => ({
      contentWidth: 800,
      contentHeight: 600,
    })) as unknown as PlaywrightPageLike["evaluate"],
    screenshot: vi.fn(async () => new Uint8Array([137, 80, 78, 71])),
    close: vi.fn(async () => {}),
  };
  const context: PlaywrightBrowserContextLike = {
    route: vi.fn(async () => {}),
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => {}),
  };
  const browser: PlaywrightBrowserLike = {
    newContext: vi.fn(async () => context),
    close: vi.fn(async () => {}),
    isConnected: () => true,
  };
  return {
    page,
    context,
    browser,
    browserType: { launch: vi.fn(async () => browser) },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("headless HTML preparation budgets", () => {
  it("rejects pathological repeated stylesheet expansion", () => {
    const links = Array.from(
      { length: 129 },
      () => '<link rel="stylesheet" href="./styles.css">',
    ).join("");
    expect(() =>
      prepareDesignHeadlessHtml(
        state(
          "stylesheet-budget",
          `<!doctype html><html><head>${links}</head><body><main data-oid="root"></main></body></html>`,
        ),
      ),
    ).toThrow("at most 128 stylesheets");
  });

  it("applies the composed output budget to custom filesystem composers", async () => {
    const harness = browserHarness();
    const renderer = new PlaywrightDesignRenderer({
      browserType: harness.browserType,
      htmlForState: () => "x".repeat(16 * 1024 * 1024 + 1),
    });
    await expect(
      renderer.render({ state: state("custom-budget"), viewport: VIEWPORT }),
    ).rejects.toThrow("exceeds the 16 MiB limit");
    expect(harness.browserType.launch).not.toHaveBeenCalled();
    await renderer.close();
  });
});

describe("Playwright renderer lifecycle", () => {
  it("cancels a pending composer and releases the page slot", async () => {
    const harness = browserHarness();
    const renderer = new PlaywrightDesignRenderer({
      browserType: harness.browserType,
      maxConcurrentPages: 1,
      htmlForState: (document) =>
        document.documentId === "blocked"
          ? new Promise<string>(() => {})
          : '<!doctype html><html><body><main data-oid="root"></main></body></html>',
    });
    const controller = new AbortController();
    const first = renderer.render({
      state: state("blocked"),
      viewport: VIEWPORT,
      signal: controller.signal,
    });
    const second = renderer.render({
      state: state("next"),
      viewport: VIEWPORT,
    });

    controller.abort(new Error("cancelled by test"));
    await expect(first).rejects.toThrow("cancelled by test");
    await expect(second).resolves.toMatchObject({
      mimeType: "image/png",
      revision: state("next").revision,
    });
    expect(harness.browserType.launch).toHaveBeenCalledTimes(1);
    await renderer.close();
  });

  it("applies one deadline to composition as well as browser work", async () => {
    vi.useFakeTimers();
    const harness = browserHarness();
    const renderer = new PlaywrightDesignRenderer({
      browserType: harness.browserType,
      timeoutMs: 1_000,
      htmlForState: () => new Promise<string>(() => {}),
    });
    const rendering = renderer.render({
      state: state("timeout"),
      viewport: VIEWPORT,
    });
    const outcome = rendering.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(1_001);
    expect(await outcome).toEqual(
      expect.objectContaining({
        message: expect.stringContaining("timed out"),
      }),
    );
    await renderer.close();
  });

  it("closes a context that is created after cancellation", async () => {
    const context: PlaywrightBrowserContextLike = {
      route: vi.fn(async () => {}),
      newPage: vi.fn(async () => {
        throw new Error("must not create a page after cancellation");
      }),
      close: vi.fn(async () => {}),
    };
    let resolveContext!: (value: PlaywrightBrowserContextLike) => void;
    let signalContextStarted!: () => void;
    const contextStarted = new Promise<void>((resolve) => {
      signalContextStarted = resolve;
    });
    const pendingContext = new Promise<PlaywrightBrowserContextLike>(
      (resolve) => {
        resolveContext = resolve;
      },
    );
    const browser: PlaywrightBrowserLike = {
      newContext: vi.fn(() => {
        signalContextStarted();
        return pendingContext;
      }),
      close: vi.fn(async () => {}),
      isConnected: () => true,
    };
    const renderer = new PlaywrightDesignRenderer({
      browserType: { launch: vi.fn(async () => browser) },
    });
    const controller = new AbortController();
    const rendering = renderer.render({
      state: state("late-context"),
      viewport: VIEWPORT,
      signal: controller.signal,
    });

    await contextStarted;
    controller.abort(new Error("cancel before context"));
    await expect(rendering).rejects.toThrow("cancel before context");
    resolveContext(context);
    await vi.waitFor(() => expect(context.close).toHaveBeenCalledTimes(1));
    await renderer.close();
  });

  it("bounds shutdown while a browser launch is stuck and closes a late browser", async () => {
    vi.useFakeTimers();
    const harness = browserHarness();
    let resolveBrowser!: (browser: PlaywrightBrowserLike) => void;
    let announceLaunch!: () => void;
    const launchStarted = new Promise<void>((resolve) => {
      announceLaunch = resolve;
    });
    const launching = new Promise<PlaywrightBrowserLike>((resolve) => {
      resolveBrowser = resolve;
    });
    const renderer = new PlaywrightDesignRenderer({
      browserType: {
        launch: vi.fn(() => {
          announceLaunch();
          return launching;
        }),
      },
    });
    const controller = new AbortController();
    const rendering = renderer.render({
      state: state("late-browser"),
      viewport: VIEWPORT,
      signal: controller.signal,
    });

    await launchStarted;
    controller.abort(new Error("cancel browser launch"));
    await expect(rendering).rejects.toThrow("cancel browser launch");
    const closing = renderer.close();
    await vi.advanceTimersByTimeAsync(1_001);
    await closing;

    resolveBrowser(harness.browser);
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.browser.close).toHaveBeenCalledTimes(1);
  });
});
