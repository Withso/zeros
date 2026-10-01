import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { createSmokeIncidentLog } from "../ui-smoke-incidents.mjs";

const clock = () => new Date("2026-10-01T00:00:00.000Z");

function fakePage(url = "http://127.0.0.1:4100/harnesses/harness-a.html") {
  const page = new EventEmitter() as EventEmitter & {
    url: () => string;
    context: () => { newCDPSession: () => Promise<unknown> };
    cdp: EventEmitter & { send: (method: string) => Promise<unknown> };
  };
  const cdp = new EventEmitter() as typeof page.cdp;
  cdp.send = async (method: string) =>
    method === "Page.getFrameTree"
      ? { frameTree: { frame: { id: "main" } } }
      : {};
  page.cdp = cdp;
  page.url = () => url;
  page.context = () => ({ newCDPSession: async () => cdp });
  return page;
}

describe("ui smoke incident log", () => {
  it("records dev-server reload and re-optimization notices without the startup banner", () => {
    const log = createSmokeIncidentLog({ clock });
    const stdout = new PassThrough();
    log.watchDevServerOutput(stdout);
    stdout.write(
      "  VITE v7.3.6  ready in 900 ms\n  ➜  Network: http://192.0.2.10:4100/\n",
    );
    stdout.write(
      "12:00:01 [vite] ✨ new dependencies optimized: left-pad\n12:00:02 [vite] ✨ optimized dependencies ch",
    );
    stdout.write("anged. reloading\n");
    expect(log.entries()).toEqual([
      "2026-10-01T00:00:00.000Z dev server: 12:00:01 [vite] ✨ new dependencies optimized: left-pad",
      "2026-10-01T00:00:00.000Z dev server: 12:00:02 [vite] ✨ optimized dependencies changed. reloading",
    ]);
  });

  it("records only renderer-initiated main-frame navigations, crashes, uncaught errors, dev-client notices and dev-server failures", async () => {
    const log = createSmokeIncidentLog({ clock });
    const page = fakePage();
    await log.watchPage(page, { devServerOrigin: "http://127.0.0.1:4100" });
    page.cdp.emit("Page.frameRequestedNavigation", {
      frameId: "main",
      reason: "reload",
      url: "http://127.0.0.1:4100/harnesses/harness-a.html?mode",
    });
    page.cdp.emit("Page.frameRequestedNavigation", {
      frameId: "child",
      reason: "scriptInitiated",
      url: "about:srcdoc",
    });
    page.emit("pageerror", new TypeError("items[0] is undefined"));
    page.emit("console", {
      type: () => "debug",
      text: () => "[vite] connecting...",
    });
    page.emit("console", {
      type: () => "debug",
      text: () => "[vite] connected.",
    });
    page.emit("console", {
      type: () => "log",
      text: () => "[vite] server connection lost. Polling for restart...",
    });
    page.emit("console", {
      type: () => "error",
      text: () =>
        "Unable to preventDefault inside passive event listener invocation.",
    });
    page.emit("console", {
      type: () => "log",
      text: () => "[harness] onChange",
    });
    page.emit("crash");
    page.emit("response", {
      status: () => 504,
      url: () => "http://127.0.0.1:4100/node_modules/.vite/deps/react.js?v=1",
    });
    page.emit("response", {
      status: () => 500,
      url: () => "https://api.example.test/v1/fixture",
    });
    page.emit("response", {
      status: () => 200,
      url: () => "http://127.0.0.1:4100/a.ts",
    });
    expect(log.entries()).toEqual([
      "2026-10-01T00:00:00.000Z /harnesses/harness-a.html: renderer-initiated reload navigation to /harnesses/harness-a.html?mode",
      "2026-10-01T00:00:00.000Z /harnesses/harness-a.html: uncaught TypeError: items[0] is undefined",
      "2026-10-01T00:00:00.000Z /harnesses/harness-a.html: dev client: [vite] server connection lost. Polling for restart...",
      "2026-10-01T00:00:00.000Z /harnesses/harness-a.html: renderer crashed",
      "2026-10-01T00:00:00.000Z /harnesses/harness-a.html: dev server answered 504 for /node_modules/.vite/deps/react.js?v=1",
    ]);
  });

  it("keeps a bounded tail and reports it only when something was recorded", () => {
    const written: string[] = [];
    const log = createSmokeIncidentLog({
      clock,
      limit: 2,
      write: (text: string) => written.push(text),
    });
    log.report("incidents");
    expect(written).toEqual([]);
    for (const text of ["first", "second", "third"]) log.record(text);
    log.report("incidents");
    expect(written.join("")).toBe(
      "\nincidents (2 most recent, 1 older dropped):\n" +
        "  2026-10-01T00:00:00.000Z second\n" +
        "  2026-10-01T00:00:00.000Z third\n",
    );
  });

  it("records runner event-loop stalls longer than the threshold", async () => {
    const log = createSmokeIncidentLog({ clock });
    const stop = log.watchEventLoop({ intervalMs: 10, stallMs: 50 });
    const until = Date.now() + 120;
    while (Date.now() < until) {
      /* Block the event loop past the stall threshold. */
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    stop();
    expect(
      log
        .entries()
        .some((entry) => /runner event loop stalled for \d+ms/.test(entry)),
    ).toBe(true);
  });
});
