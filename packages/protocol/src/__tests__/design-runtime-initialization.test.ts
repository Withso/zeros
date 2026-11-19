import { chromium } from "@playwright/test";
import { expect, it } from "vitest";

import { DESIGN_RUNTIME_SOURCE } from "../design-runtime";

it("does not publish initial HTML parsing as a mutation after editor readiness", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const first = await page.evaluate(source => new Promise<number>(resolve => {
      const version = "a".repeat(24);
      const iframe = document.createElement("iframe");
      iframe.setAttribute("sandbox", "allow-scripts");
      const channel = new MessageChannel();
      const probe = { revisions: [] as number[], current: null as ((revision: number) => void) | null,
        read: () => new Promise<number>(done => {
          probe.current = done;
          channel.port1.postMessage({ protocol: "zeros-design-runtime", version: 2, type: "request",
            sourceVersion: version, requestId: "snapshot", method: "getSnapshot", args: {} });
        }) };
      (window as typeof window & { initializationProbe: typeof probe }).initializationProbe = probe;
      channel.port1.onmessage = event => {
        const message = event.data;
        if (message.type === "event" && message.event === "ready") resolve(message.payload.snapshot.revision);
        if (message.type === "event" && message.event === "mutation") probe.revisions.push(message.payload.revision);
        if (message.type === "response" && message.requestId === "snapshot") probe.current?.(message.result.revision);
      };
      channel.port1.start();
      iframe.onload = () => iframe.contentWindow!.postMessage({ protocol: "zeros-design-runtime", version: 2,
        type: "handshake", sourceVersion: version }, "*", [channel.port2]);
      // Production inserts the runtime in the head, before the HTML parser
      // constructs the frame body. Evaluating it after setContent misses this.
      iframe.srcdoc = `<!doctype html><html><head><script>window.__zerosDesignSourceVersion=${JSON.stringify(version)};${source}</script></head><body><main data-oid="root"><h1 data-oid="heading">Saved heading</h1></main></body></html>`;
      document.body.append(iframe);
    }), DESIGN_RUNTIME_SOURCE);
    // Observe one complete mutation-debounce window; this is the defect's
    // delayed publication, not a wait before admitting user input.
    await page.waitForTimeout(700);
    const quiet = await page.evaluate(async () => {
      const probe = (window as typeof window & { initializationProbe: { read(): Promise<number>; revisions: number[] } }).initializationProbe;
      return { revision: await probe.read(), mutations: [...probe.revisions] };
    });
    expect(quiet).toEqual({ revision: first, mutations: [] });

    await page.frames()[1]!.evaluate(() => { document.querySelector("h1")!.textContent = "Changed heading"; });
    await page.waitForFunction(() => (window as typeof window & { initializationProbe: { revisions: number[] } }).initializationProbe.revisions.length > 0);
    expect(await page.evaluate(() => (window as typeof window & { initializationProbe: { revisions: number[] } }).initializationProbe.revisions))
      .toEqual([first + 1]);
  } finally {
    await browser.close();
  }
}, 15_000);
