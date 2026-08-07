import { parse, type DefaultTreeAdapterTypes } from "parse5";

import { assertSafeDesignHtmlDocument } from "./html";
import type {
  DesignHeadlessRenderer,
  DesignRenderArtifact,
  DesignRenderViewport,
} from "./api";
import type { DesignWebDocumentState } from "./model";

export interface PlaywrightRouteLike {
  abort(errorCode?: string): Promise<void> | void;
}

export interface PlaywrightPageLike {
  setContent(
    html: string,
    options: { waitUntil: "load"; timeout: number },
  ): Promise<unknown>;
  evaluate<Result>(
    pageFunction: () => Result | Promise<Result>,
  ): Promise<Result>;
  screenshot(options: {
    type: "png";
    animations: "disabled";
    caret: "hide";
    fullPage: false;
    scale: "device";
    timeout: number;
  }): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface PlaywrightBrowserContextLike {
  route(
    url: string,
    handler: (route: PlaywrightRouteLike) => Promise<void> | void,
  ): Promise<unknown>;
  newPage(): Promise<PlaywrightPageLike>;
  close(): Promise<void>;
}

export interface PlaywrightBrowserLike {
  newContext(options: {
    viewport: { width: number; height: number };
    deviceScaleFactor: number;
    colorScheme: "light" | "dark";
    reducedMotion: "reduce" | "no-preference";
    javaScriptEnabled: boolean;
    offline: boolean;
    serviceWorkers: "block";
    acceptDownloads: boolean;
    locale: string;
    timezoneId: string;
  }): Promise<PlaywrightBrowserContextLike>;
  close(): Promise<void>;
  isConnected?(): boolean;
}

export interface PlaywrightBrowserTypeLike {
  launch(
    options?: Readonly<Record<string, unknown>>,
  ): Promise<PlaywrightBrowserLike>;
}

export interface PlaywrightDesignRendererOptions {
  browserType: PlaywrightBrowserTypeLike;
  /** Produces the composed, sandbox-safe document. Filesystem adapters can use
   * this to inline binary assets and expand components before rasterization. */
  htmlForState?: (
    state: DesignWebDocumentState,
    signal?: AbortSignal,
  ) => string | Promise<string>;
  launchOptions?: Readonly<Record<string, unknown>>;
  timeoutMs?: number;
  maxConcurrentPages?: number;
}

interface SemaphoreWaiter {
  signal?: AbortSignal;
  onAbort?: () => void;
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
}

const MAX_HEADLESS_HTML_BYTES = 16 * 1024 * 1024;
const MAX_HEADLESS_STYLESHEETS = 128;

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

function abortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ?? new Error("The headless design render was cancelled.")
  );
}

function renderDeadline(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const forward = () =>
    controller.abort(parent ? abortReason(parent) : undefined);
  if (parent?.aborted) forward();
  else parent?.addEventListener("abort", forward, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error("The headless design render timed out.")),
    timeoutMs,
  );
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", forward);
    },
  };
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortReason(signal));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

async function settleWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    promise,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
}

async function bestEffortClose(
  close: () => Promise<void>,
  timeoutMs = 1_000,
): Promise<void> {
  await settleWithin(
    close().catch(() => {}),
    timeoutMs,
  );
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function assertHeadlessHtmlBudget(value: string): void {
  if (utf8Bytes(value) > MAX_HEADLESS_HTML_BYTES) {
    throw new Error("Composed headless HTML exceeds the 16 MiB limit.");
  }
}

function elements(
  document: DefaultTreeAdapterTypes.Document,
): DefaultTreeAdapterTypes.Element[] {
  const result: DefaultTreeAdapterTypes.Element[] = [];
  const visit = (
    node: DefaultTreeAdapterTypes.Document | DefaultTreeAdapterTypes.Element,
  ) => {
    for (const child of node.childNodes ?? []) {
      if (!("tagName" in child)) continue;
      result.push(child);
      visit(child);
    }
  };
  visit(document);
  return result;
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Produce a network-independent HTML document from the textual files in one
 * Design API state. Binary assets and expanded component definitions require
 * an adapter-specific htmlForState composer. */
export function prepareDesignHeadlessHtml(
  state: DesignWebDocumentState,
): string {
  const authored = state.files[state.entryFile];
  if (authored === undefined) {
    throw new Error(`Design entry source is missing: ${state.entryFile}`);
  }
  assertSafeDesignHtmlDocument(authored);
  const document = parse(authored, { sourceCodeLocationInfo: true });
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const stylesheetElements = elements(document).filter((element) => {
    if (element.tagName !== "link" || !element.sourceCodeLocation) return false;
    const rel =
      element.attrs.find((attribute) => attribute.name === "rel")?.value ?? "";
    return rel
      .split(/\s+/)
      .some((value) => value.toLowerCase() === "stylesheet");
  });
  if (stylesheetElements.length > MAX_HEADLESS_STYLESHEETS) {
    throw new Error(
      `A headless design may link at most ${MAX_HEADLESS_STYLESHEETS} stylesheets.`,
    );
  }
  let outputBytes = utf8Bytes(authored);
  for (const element of stylesheetElements) {
    const href = element.attrs.find(
      (attribute) => attribute.name === "href",
    )?.value;
    if (!href) throw new Error("A design stylesheet link is missing href.");
    const path = href.replace(/^\.\//, "").split(/[?#]/, 1)[0] ?? "";
    const css = state.files[path];
    if (css === undefined || !path.toLowerCase().endsWith(".css")) {
      throw new Error(`Linked design stylesheet is missing: ${href}`);
    }
    const text = `<style data-zeros-source="${escapeAttribute(path)}">${css.replace(/<\/style/gi, "<\\/style")}</style>`;
    outputBytes +=
      utf8Bytes(text) -
      utf8Bytes(
        authored.slice(
          element.sourceCodeLocation!.startOffset,
          element.sourceCodeLocation!.endOffset,
        ),
      );
    if (outputBytes > MAX_HEADLESS_HTML_BYTES) {
      throw new Error("Composed headless HTML exceeds the 16 MiB limit.");
    }
    edits.push({
      start: element.sourceCodeLocation!.startOffset,
      end: element.sourceCodeLocation!.endOffset,
      text,
    });
  }
  let html = authored;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    html = `${html.slice(0, edit.start)}${edit.text}${html.slice(edit.end)}`;
  }
  const guard =
    "<style data-zeros-headless>*,:before,:after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;caret-color:transparent!important}</style>";
  const result = /<\/head\s*>/i.test(html)
    ? html.replace(/<\/head\s*>/i, `${guard}</head>`)
    : `${guard}${html}`;
  assertHeadlessHtmlBudget(result);
  return result;
}

/** Browser-backed raster adapter for CI, cloud workers, and visual-diff
 * harnesses. It reuses one browser, bounds concurrent pages, disables network
 * access and active document JavaScript, and closes each isolated context. */
export class PlaywrightDesignRenderer implements DesignHeadlessRenderer {
  private readonly timeoutMs: number;
  private readonly maxConcurrentPages: number;
  private browserPromise: Promise<PlaywrightBrowserLike> | null = null;
  private activePages = 0;
  private readonly waiters: SemaphoreWaiter[] = [];
  private closed = false;

  constructor(private readonly options: PlaywrightDesignRendererOptions) {
    this.timeoutMs = boundedInteger(options.timeoutMs, 15_000, 1_000, 60_000);
    this.maxConcurrentPages = boundedInteger(
      options.maxConcurrentPages,
      2,
      1,
      4,
    );
  }

  async render(input: {
    state: DesignWebDocumentState;
    viewport: Required<DesignRenderViewport>;
    signal?: AbortSignal;
  }): Promise<DesignRenderArtifact> {
    const deadline = renderDeadline(input.signal, this.timeoutMs);
    let release: (() => void) | null = null;
    let context: PlaywrightBrowserContextLike | null = null;
    let page: PlaywrightPageLike | null = null;
    let abort: (() => void) | null = null;
    try {
      release = await this.acquire(deadline.signal);
      const compose = this.options.htmlForState ?? prepareDesignHeadlessHtml;
      const html = await abortable(
        Promise.resolve().then(() => compose(input.state, deadline.signal)),
        deadline.signal,
      );
      assertHeadlessHtmlBudget(html);
      const browser = await abortable(this.browser(), deadline.signal);
      const contextPromise = browser.newContext({
        viewport: {
          width: input.viewport.width,
          height: input.viewport.height,
        },
        deviceScaleFactor: input.viewport.deviceScaleFactor,
        colorScheme: input.viewport.colorScheme,
        reducedMotion: input.viewport.reducedMotion,
        javaScriptEnabled: false,
        offline: true,
        serviceWorkers: "block",
        acceptDownloads: false,
        locale: "en-US",
        timezoneId: "UTC",
      });
      try {
        context = await abortable(contextPromise, deadline.signal);
      } catch (error) {
        if (deadline.signal.aborted) {
          void contextPromise
            .then((lateContext) => bestEffortClose(() => lateContext.close()))
            .catch(() => {});
        }
        throw error;
      }
      const ownedContext = context;
      abort = () => {
        void bestEffortClose(() => ownedContext.close());
      };
      deadline.signal.addEventListener("abort", abort, { once: true });
      for (const pattern of [
        "http://**/*",
        "https://**/*",
        "file://**/*",
        "ftp://**/*",
      ]) {
        await abortable(
          Promise.resolve(
            context.route(pattern, (route) => route.abort("blockedbyclient")),
          ),
          deadline.signal,
        );
      }
      const pagePromise = context.newPage();
      try {
        page = await abortable(pagePromise, deadline.signal);
      } catch (error) {
        if (deadline.signal.aborted) {
          void pagePromise
            .then((latePage) => bestEffortClose(() => latePage.close()))
            .catch(() => {});
        }
        throw error;
      }
      await abortable(
        page.setContent(html, {
          waitUntil: "load",
          timeout: this.timeoutMs,
        }),
        deadline.signal,
      );
      const metrics = await abortable(
        page.evaluate(() => {
          // This callback executes inside Chromium. Describing its tiny DOM
          // surface locally keeps Node/Electron consumers from needing the DOM
          // TypeScript library merely to import the headless renderer.
          const pageDocument = (
            globalThis as unknown as {
              document: {
                documentElement: {
                  scrollWidth: number;
                  scrollHeight: number;
                };
                body: {
                  scrollWidth: number;
                  scrollHeight: number;
                } | null;
              };
            }
          ).document;
          return {
            contentWidth: Math.max(
              pageDocument.documentElement.scrollWidth,
              pageDocument.body?.scrollWidth ?? 0,
            ),
            contentHeight: Math.max(
              pageDocument.documentElement.scrollHeight,
              pageDocument.body?.scrollHeight ?? 0,
            ),
          };
        }),
        deadline.signal,
      );
      const bytes = await abortable(
        page.screenshot({
          type: "png",
          animations: "disabled",
          caret: "hide",
          fullPage: false,
          scale: "device",
          timeout: this.timeoutMs,
        }),
        deadline.signal,
      );
      return {
        mimeType: "image/png",
        bytes,
        width: input.viewport.width,
        height: input.viewport.height,
        revision: input.state.revision,
        metadata: {
          viewportProfile: input.viewport.width <= 600 ? "mobile" : "desktop",
          deviceScaleFactor: input.viewport.deviceScaleFactor,
          contentWidth: metrics.contentWidth,
          contentHeight: metrics.contentHeight,
          networkDisabled: true,
        },
      };
    } catch (error) {
      if (deadline.signal.aborted) throw abortReason(deadline.signal);
      throw error;
    } finally {
      if (abort) {
        deadline.signal.removeEventListener("abort", abort);
      }
      deadline.dispose();
      // Closing a context owns all of its pages. Fall back to the page only if
      // context creation never completed, and cap cleanup independently so a
      // broken browser cannot retain the semaphore forever.
      if (context) await bestEffortClose(() => context!.close());
      else if (page) await bestEffortClose(() => page!.close());
      release?.();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const error = new Error("The Playwright design renderer is closed.");
    for (const waiter of this.waiters.splice(0)) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.reject(error);
    }
    const browserPromise = this.browserPromise;
    this.browserPromise = null;
    if (browserPromise) {
      // Attach cleanup to a launch that may resolve late, but do not let an
      // unresponsive browser launcher make renderer shutdown unbounded.
      await settleWithin(
        browserPromise
          .then((browser) => bestEffortClose(() => browser.close()))
          .catch(() => {}),
        1_000,
      );
    }
  }

  private async browser(): Promise<PlaywrightBrowserLike> {
    if (this.closed) {
      throw new Error("The Playwright design renderer is closed.");
    }
    if (this.browserPromise) {
      const retained = await this.browserPromise.catch(() => null);
      if (retained && retained.isConnected?.() !== false) return retained;
      this.browserPromise = null;
    }
    const launchOptions = {
      headless: true,
      args: [
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-extensions",
        "--disable-sync",
        "--metrics-recording-only",
        "--no-first-run",
      ],
      ...this.options.launchOptions,
    };
    this.browserPromise = this.options.browserType.launch(launchOptions);
    const launched = this.browserPromise;
    try {
      return await launched;
    } catch (error) {
      if (this.browserPromise === launched) this.browserPromise = null;
      throw error;
    }
  }

  private acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.closed) {
      return Promise.reject(
        new Error("The Playwright design renderer is closed."),
      );
    }
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (this.activePages < this.maxConcurrentPages) {
      this.activePages += 1;
      return Promise.resolve(() => this.release());
    }
    return new Promise((resolve, reject) => {
      const waiter: SemaphoreWaiter = { signal, resolve, reject };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(abortReason(signal));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  private release(): void {
    this.activePages = Math.max(0, this.activePages - 1);
    const waiter = this.waiters.shift();
    if (!waiter) return;
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
    if (waiter.signal?.aborted) {
      waiter.reject(abortReason(waiter.signal));
      this.release();
      return;
    }
    this.activePages += 1;
    waiter.resolve(() => this.release());
  }
}
