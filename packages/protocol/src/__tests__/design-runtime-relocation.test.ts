import { describe, expect, it } from "vitest";
import { chromium, expect as browserExpect } from "@playwright/test";
import { DESIGN_RUNTIME_SOURCE } from "../design-runtime";

describe("relocation context", () => {
  it("restores overlapping shorthand previews, confirmed generations and teardown exactly", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const result = await page.evaluate((runtime) => new Promise<{
        before: { x: number; y: number };
        cancelled: { x: number; y: number };
        committed: { x: number; y: number };
        undone: { x: number; y: number };
        redone: { x: number; y: number };
      }>((resolve, reject) => {
        document.head.innerHTML = "<style>body{margin:0}</style>";
        document.body.innerHTML = '<main data-oid="parent" style="position:relative;width:600px;height:400px"><div data-oid="child" style="position:absolute;right:10px;top:20px;width:100px;height:80px;margin-left:7px"></div></main>';
        let sourceVersion = "a".repeat(24), sequence = 0;
        Object.assign(window, { __zerosDesignSourceVersion: sourceVersion });
        const channel = new MessageChannel();
        Object.assign(window, { __relocationPort: channel.port1 });
        const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
        const ask = (method: string, args: unknown) => new Promise((resolve, reject) => {
          const requestId = String(++sequence);
          pending.set(requestId, { resolve, reject });
          channel.port1.postMessage({ protocol: "zeros-design-runtime", version: 2, type: "request", sourceVersion, requestId, method, args });
        });
        const measure = () => {
          const rect = document.querySelector('[data-oid="child"]')!.getBoundingClientRect();
          return { x: rect.x, y: rect.y };
        };
        const run = async () => {
          const before = measure();
          const styles = { inset: "0 auto auto 0", left: "0px", top: "0px", margin: "0" };
          await ask("previewStyles", { nodeId: "child", styles: { left: "5px", top: "25px" } });
          await ask("previewStyles", { nodeId: "child", styles });
          await ask("clearPreviewStyles", { nodeId: "child" });
          const cancelled = measure();
          await ask("previewStyles", { nodeId: "child", styles });
          await ask("commitStyles", { nextSourceVersion: "b".repeat(24), updates: [{ nodeId: "child", styles }] });
          const committed = measure();
          await ask("restoreGeneration", { targetSourceVersion: "a".repeat(24), commit: true });
          const undone = measure();
          await ask("restoreGeneration", { targetSourceVersion: "b".repeat(24), commit: true });
          const redone = measure();
          await ask("restoreGeneration", { targetSourceVersion: "a".repeat(24), commit: true });
          await ask("previewStyles", { nodeId: "child", styles });
          return { before, cancelled, committed, undone, redone };
        };
        const timeout = window.setTimeout(() => reject(new Error("Relocation history timed out")), 5000);
        channel.port1.onmessage = ({ data }) => {
          if (data.event === "ready") void run().then((result) => { window.clearTimeout(timeout); resolve(result); }, reject);
          else if (data.type === "response") {
            const reply = pending.get(data.requestId);
            pending.delete(data.requestId);
            if (!reply) return;
            if (data.ok) {
              if (data.result?.sourceVersion) sourceVersion = data.result.sourceVersion;
              reply.resolve(data.result);
            } else reply.reject(new Error(data.error?.message));
          }
        };
        channel.port1.start();
        new Function(runtime)();
        window.postMessage({ protocol: "zeros-design-runtime", version: 2, type: "handshake", sourceVersion }, "*", [channel.port2]);
      }), DESIGN_RUNTIME_SOURCE);
      expect(result.cancelled).toEqual(result.before);
      expect(result.committed).toEqual({ x: 0, y: 0 });
      expect(result.undone).toEqual(result.before);
      expect(result.redone).toEqual(result.committed);
      await page.evaluate(() => {
        const state = window as unknown as { __relocationPort: MessagePort; __zerosDesignSourceVersion: string };
        state.__relocationPort.postMessage({ protocol: "zeros-design-runtime", version: 2, type: "teardown", sourceVersion: state.__zerosDesignSourceVersion });
      });
      await browserExpect.poll(() => page.locator('[data-oid="child"]').evaluate((node) => ({ x: node.getBoundingClientRect().x, y: node.getBoundingClientRect().y }))).toEqual(result.before);
    } finally {
      await browser.close();
    }
  });

  it("captures inherited appearance on demand and refuses ancestor compositing", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const result = await page.evaluate(
        (source) =>
          new Promise<
            Array<{
              styles: Record<string, string>;
              relocationContext?: {
                inheritedStyles: Record<string, string>;
                unsupported: string[];
              };
            }>
          >((resolve, reject) => {
            document.body.innerHTML =
              '<div style="color:rgb(1,2,3);font-size:30px;--accent: red;transform:scale(2);--zeros-layout-origin-flow:1"><div data-oid="child" style="width:100px;height:80px;background:var(--accent)">Keep</div></div><div style="opacity:.5"><div data-oid="composited" style="--zeros-layout-origin-flow:1">Keep</div></div>';
            const sourceVersion = "a".repeat(24);
            Object.assign(window, {
              __zerosDesignSourceVersion: sourceVersion,
            });
            const channel = new MessageChannel();
            const values: unknown[] = [];
            const timeout = window.setTimeout(
              () => reject(new Error("Relocation context timed out")),
              3000,
            );
            const request = () =>
              channel.port1.postMessage({
                protocol: "zeros-design-runtime",
                version: 2,
                type: "request",
                sourceVersion,
                requestId: String(values.length),
                method: "getNodeDetails",
                args: {
                  nodeId: values.length < 2 ? "child" : "composited",
                  relocation: values.length !== 0,
                },
              });
            channel.port1.onmessage = ({ data }) => {
              if (data.event === "ready") request();
              else if (data.type === "response") {
                if (!data.ok) {
                  reject(new Error(data.error?.message));
                  return;
                }
                values.push(data.result);
                if (values.length < 3) request();
                else {
                  window.clearTimeout(timeout);
                  channel.port1.close();
                  resolve(values as never);
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
              },
              "*",
              [channel.port2],
            );
          }),
        DESIGN_RUNTIME_SOURCE,
      );
      expect(result[0]!.relocationContext).toBeUndefined();
      expect(result[1]!.relocationContext?.inheritedStyles).toMatchObject({
        color: "rgb(1, 2, 3)",
        "font-size": "30px",
        "--accent": "red",
      });
      expect(result[1]!.relocationContext?.unsupported).toEqual([]);
      expect(result[2]!.relocationContext?.unsupported).toContain(
        "ancestor compositing",
      );
      expect(result[0]!.styles["--zeros-layout-origin-flow"]).toBe("");
      expect(
        result[1]!.relocationContext?.inheritedStyles[
          "--zeros-layout-origin-flow"
        ],
      ).toBeUndefined();
      expect(result[2]!.styles["--zeros-layout-origin-flow"]).toBe("1");
    } finally {
      await browser.close();
    }
  });
});
