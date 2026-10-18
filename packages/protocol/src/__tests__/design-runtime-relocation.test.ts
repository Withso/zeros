import { describe, expect, it } from "vitest";
import { chromium } from "@playwright/test";
import { DESIGN_RUNTIME_SOURCE } from "../design-runtime";

describe("relocation context", () => {
  it("captures inherited appearance on demand and refuses ancestor compositing", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const result = await page.evaluate((source) => new Promise<Array<{ relocationContext?: { inheritedStyles: Record<string, string>; unsupported: string[] } }>>((resolve, reject) => {
        document.body.innerHTML = '<div style="color:rgb(1,2,3);font-size:30px;--accent: red;transform:scale(2)"><div data-oid="child" style="width:100px;height:80px;background:var(--accent)">Keep</div></div><div style="opacity:.5"><div data-oid="composited">Keep</div></div>';
        const sourceVersion = "a".repeat(24);
        Object.assign(window, { __zerosDesignSourceVersion: sourceVersion });
        const channel = new MessageChannel();
        const values: unknown[] = [];
        const timeout = window.setTimeout(() => reject(new Error("Relocation context timed out")), 3000);
        const request = () => channel.port1.postMessage({ protocol: "zeros-design-runtime", version: 2, type: "request", sourceVersion, requestId: String(values.length), method: "getNodeDetails", args: { nodeId: values.length < 2 ? "child" : "composited", relocation: values.length !== 0 } });
        channel.port1.onmessage = ({ data }) => {
          if (data.event === "ready") request();
          else if (data.type === "response") {
            if (!data.ok) { reject(new Error(data.error?.message)); return; }
            values.push(data.result);
            if (values.length < 3) request();
            else { window.clearTimeout(timeout); channel.port1.close(); resolve(values as never); }
          }
        };
        channel.port1.start(); new Function(source)();
        window.postMessage({ protocol: "zeros-design-runtime", version: 2, type: "handshake", sourceVersion }, "*", [channel.port2]);
      }), DESIGN_RUNTIME_SOURCE);
      expect(result[0]!.relocationContext).toBeUndefined();
      expect(result[1]!.relocationContext?.inheritedStyles).toMatchObject({ color: "rgb(1, 2, 3)", "font-size": "30px", "--accent": "red" });
      expect(result[1]!.relocationContext?.unsupported).toEqual([]);
      expect(result[2]!.relocationContext?.unsupported).toContain("ancestor compositing");
    } finally { await browser.close(); }
  });
});
