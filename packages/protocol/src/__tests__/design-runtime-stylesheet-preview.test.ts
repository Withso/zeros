import { chromium } from "@playwright/test";
import { describe, expect, it } from "vitest";

import { DESIGN_RUNTIME_SOURCE } from "../design-runtime";

type Outcome = {
  methods: string[];
  previewed: { applied: number; revision: number };
  previewColor: string;
  otherColor: string;
  restored: { applied: number };
  restoredColor: string;
  restoredText: string;
  unlinked: { applied: number };
  mutationEvents: number;
  refused?: string;
};

/** Load the runtime into a page whose head inlines two linked Design
 * stylesheets the way render preparation does, hand-shake with or without
 * the opt-in, and run the given requests. */
async function run(features: string[] | undefined): Promise<Outcome> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    return await page.evaluate(
      ({ source, features }) =>
        new Promise<Outcome>((resolve, reject) => {
          const sourceVersion = "7".repeat(24);
          document.head.innerHTML =
            '<style data-zeros-source="tokens.css" data-zeros-sheet="0-aaaaaaaaaaaaaaaaaaaaaaaa">:root{--accent:rgb(200, 0, 0)}</style>' +
            '<style data-zeros-source="page-1/page.css" data-zeros-sheet="1-bbbbbbbbbbbbbbbbbbbbbbbb">h1{color:var(--accent)}p{color:rgb(0, 0, 200)}</style>';
          document.body.innerHTML =
            '<main data-oid="root"><h1 data-oid="title">Title</h1><p data-oid="copy">Copy</p></main>';
          (window as Window & { __zerosDesignSourceVersion?: string }).__zerosDesignSourceVersion =
            sourceVersion;
          const title = document.querySelector("h1")!;
          const copy = document.querySelector("p")!;
          const channel = new MessageChannel();
          const pending = new Map<string, (message: Record<string, unknown>) => void>();
          let mutationEvents = 0;
          let methods: string[] = [];
          const timeout = window.setTimeout(() => reject(new Error("stylesheet preview timed out")), 5_000);
          const request = (method: string, args: Record<string, unknown>) =>
            new Promise<Record<string, unknown>>((done) => {
              const requestId = `${method}-${pending.size}-${Math.random()}`;
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
          channel.port1.onmessage = (event) => {
            const message = event.data as Record<string, unknown>;
            if (message.type === "event" && message.event === "mutation") mutationEvents += 1;
            if (message.type === "response") pending.get(message.requestId as string)?.(message);
            if (message.type !== "event" || message.event !== "ready") return;
            methods = ((message.payload as { capabilities: { methods: string[] } }).capabilities.methods);
            void (async () => {
              const previewed = await request("previewStylesheet", {
                file: "tokens.css",
                css: ":root{--accent:rgb(0, 150, 0)}",
              });
              if (!previewed.ok) {
                window.clearTimeout(timeout);
                resolve({ methods, refused: (previewed.error as { code: string }).code } as Outcome);
                return;
              }
              const previewColor = getComputedStyle(title).color;
              const otherColor = getComputedStyle(copy).color;
              const restored = await request("previewStylesheet", { file: "tokens.css", css: null });
              const unlinked = await request("previewStylesheet", { file: "missing.css", css: "h1{color:red}" });
              // Mutation events are debounced 500 ms: wait past one window.
              await new Promise((done) => window.setTimeout(done, 700));
              window.clearTimeout(timeout);
              const result = (value: Record<string, unknown>) =>
                value.result as { applied: number; snapshot: { revision: number } };
              resolve({
                methods,
                previewed: {
                  applied: result(previewed).applied,
                  revision: result(previewed).snapshot.revision,
                },
                previewColor,
                otherColor,
                restored: { applied: result(restored).applied },
                restoredColor: getComputedStyle(title).color,
                restoredText: document.querySelector('style[data-zeros-source="tokens.css"]')!.textContent ?? "",
                unlinked: { applied: result(unlinked).applied },
                mutationEvents,
              });
            })();
          };
          channel.port1.start();
          new Function(source)();
          window.postMessage(
            {
              protocol: "zeros-design-runtime",
              version: 2,
              type: "handshake",
              sourceVersion,
              ...(features ? { features } : {}),
            },
            "*",
            [channel.port2],
          );
        }),
      { source: DESIGN_RUNTIME_SOURCE, features },
    );
  } finally {
    await browser.close();
  }
}

describe("design runtime stylesheet previews", () => {
  it("applies and restores a linked stylesheet's in-flight text in place", async () => {
    const outcome = await run(["previewStylesheet", "unknownFeature"]);
    expect(outcome.methods).toContain("previewStylesheet");
    expect(outcome.previewed.applied).toBe(1);
    expect(outcome.previewed.revision).toBeGreaterThan(1);
    // The page stylesheet still reads the token: its rule now resolves green.
    expect(outcome.previewColor).toBe("rgb(0, 150, 0)");
    expect(outcome.otherColor).toBe("rgb(0, 0, 200)");
    expect(outcome.restored.applied).toBe(1);
    expect(outcome.restoredColor).toBe("rgb(200, 0, 0)");
    expect(outcome.restoredText).toBe(":root{--accent:rgb(200, 0, 0)}");
    // A frame that does not link the file is untouched.
    expect(outcome.unlinked.applied).toBe(0);
    // Runtime-owned writes never surface as authored mutations.
    expect(outcome.mutationEvents).toBe(0);
  }, 20_000);

  it("never advertises or accepts the method for a host that did not opt in", async () => {
    const outcome = await run(undefined);
    expect(outcome.methods).not.toContain("previewStylesheet");
    expect(outcome.refused).toBe("METHOD_NOT_SUPPORTED");
  }, 20_000);
});
