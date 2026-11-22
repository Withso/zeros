import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";
import { DESIGN_RUNTIME_SOURCE } from "../design-runtime";

type RuntimeWindow = Window & {
  __zerosDesignSourceVersion: string;
  runtimeRequest: (method: string, args: Record<string, unknown>) => Promise<{ result?: unknown; error?: unknown }>;
};

// A Button at its default size: no gated rule matches md, yet each binds
// its properties to the gate that would select it.
const BODY = `<style>
.btn[data-size="sm"] { height: 30px; } .btn[data-size="lg"] .icon { width: 20px; }
.btn--ghost { background: none; } .btn:not([data-size="sm"]) { color: red; }
.other[data-size="sm"] { margin: 0; } .btn[data-tone="a"] { opacity: 0.5; }
.btn[data-size="sm\\31"] { padding: 0; }
[data-size="lg"] { margin-top: 1px; } .btn--lg { border-top-width: 2px; } [data-size="lg"] .icon { letter-spacing: 1px; }
</style>
<button class="btn btn--solid" data-oid="btn" data-size="md" data-tone="b"><span class="icon" data-oid="icon">i</span></button>
<p class="plain" data-oid="other">Other</p>`;

async function fixture(browser: Browser): Promise<Page> {
  const page = await browser.newPage();
  await page.evaluate(
    async ({ source, body }) => {
      document.body.innerHTML = body;
      const runtimeWindow = window as unknown as RuntimeWindow;
      runtimeWindow.__zerosDesignSourceVersion = "a".repeat(24);
      new Function(source)();
      const channel = new MessageChannel();
      const pending = new Map<string, (value: { result?: unknown; error?: unknown }) => void>();
      let count = 0;
      const ready = new Promise<void>((resolve) => {
        channel.port1.onmessage = (event) => {
          if (event.data.type === "event" && event.data.event === "ready") resolve();
          if (event.data.type === "response") {
            pending.get(event.data.requestId)?.({ result: event.data.result, error: event.data.error });
            pending.delete(event.data.requestId);
          }
        };
      });
      runtimeWindow.runtimeRequest = (method, args) =>
        new Promise((resolve) => {
          const requestId = String(++count);
          pending.set(requestId, resolve);
          channel.port1.postMessage({ protocol: "zeros-design-runtime", version: 2, type: "request",
            sourceVersion: runtimeWindow.__zerosDesignSourceVersion, requestId, method, args });
        });
      channel.port1.start();
      window.postMessage({ protocol: "zeros-design-runtime", version: 2, type: "handshake",
        sourceVersion: runtimeWindow.__zerosDesignSourceVersion, features: ["getGatedStyles"] }, "*", [channel.port2]);
      await ready;
    },
    { source: DESIGN_RUNTIME_SOURCE, body: BODY },
  );
  return page;
}

const gated = (page: Page, nodeId: string, gates: { attributes: string[]; classPrefixes: string[] }) =>
  page.evaluate(({ nodeId, gates }) => (window as unknown as RuntimeWindow).runtimeRequest("getGatedStyles", { nodeId, gates }), { nodeId, gates });

describe("what rules gated on a control would set, at any value", () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch();
    page = await fixture(browser);
  });
  afterAll(async () => {
    await browser?.close();
  });

  it("binds a rule's properties to the gate it tests, though no value matches now", async () => {
    const reply = await gated(page, "btn", { attributes: ["data-size"], classPrefixes: ["btn--"] });
    expect(reply.error).toBeUndefined();
    // :not([data-size]) puts the gate inside parentheses: skipped, as are a
    // rule another element's class decides and a gate nobody asked about. An
    // escape in a value is the browser's to normalize; the rule still counts.
    // A gate-only selector still means the layer that carries the gate.
    expect(reply.result).toEqual({ height: ["data-size"], background: [".btn--"], padding: ["data-size"], "margin-top": ["data-size"], "border-top-width": [".btn--"] });
    expect((await gated(page, "icon", { attributes: ["data-size"], classPrefixes: ["btn--"] })).result).toEqual({ width: ["data-size"], "letter-spacing": ["data-size"] });
    expect((await gated(page, "other", { attributes: ["data-size"], classPrefixes: ["btn--"] })).result).toEqual({});
  });

  it("answers nothing without gates, and stays an opt-in method", async () => {
    expect((await gated(page, "btn", { attributes: [], classPrefixes: [] })).result).toEqual({});
  });
});
