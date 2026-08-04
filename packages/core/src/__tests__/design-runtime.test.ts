import { describe, expect, it } from "vitest";
import { chromium } from "@playwright/test";

import {
  DESIGN_RUNTIME_PROTOCOL,
  DESIGN_RUNTIME_SOURCE,
  DESIGN_RUNTIME_VERSION,
  isDesignRuntimeFrameMessage,
  type DesignRuntimeFrameMessage,
} from "../design-runtime";

describe("design runtime protocol", () => {
  it("ships one self-contained runtime with the stable protocol marker", () => {
    expect(DESIGN_RUNTIME_SOURCE).toContain(DESIGN_RUNTIME_PROTOCOL);
    expect(DESIGN_RUNTIME_SOURCE).toContain("MutationObserver");
    expect(DESIGN_RUNTIME_SOURCE).toContain("elementsFromPoint");
    expect(DESIGN_RUNTIME_SOURCE).toContain("captureScreenshot");
    expect(DESIGN_RUNTIME_SOURCE).toContain("previewStyles");
    expect(DESIGN_RUNTIME_SOURCE).toContain("clearPreviewStyles");
    expect(DESIGN_RUNTIME_SOURCE).toContain("previewStyleOverridesByOid");
    expect(DESIGN_RUNTIME_SOURCE).toContain("auditWarnings");
    expect(DESIGN_RUNTIME_SOURCE).toContain("contrastRatio");
    expect(DESIGN_RUNTIME_SOURCE).toContain("spacing-scale");
    expect(DESIGN_RUNTIME_SOURCE).toContain("__zerosDesignSourceVersion");
    expect(DESIGN_RUNTIME_SOURCE).toContain(
      "sourceVersion: SOURCE_VERSION,\n      oid: oid",
    );
    expect(DESIGN_RUNTIME_SOURCE).toContain("roots.push(treeNode(body))");
    expect(DESIGN_RUNTIME_SOURCE).toContain(
      "frame: frameDetailsOf(frameElement())",
    );
    expect(DESIGN_RUNTIME_SOURCE).toContain(
      'element.style.setProperty("display", "revert", "important")',
    );
    expect(DESIGN_RUNTIME_SOURCE).toContain("Math.max(0.01, scale)");
    expect(DESIGN_RUNTIME_SOURCE).toContain(
      "messageEvent.origin !== trustedParentOrigin",
    );
    expect(DESIGN_RUNTIME_SOURCE).toContain('message.type !== "handshake"');
    expect(DESIGN_RUNTIME_SOURCE).toContain("messageEvent.ports.length !== 1");
    expect(DESIGN_RUNTIME_SOURCE).not.toContain("parent.postMessage");
    expect(DESIGN_RUNTIME_SOURCE).not.toContain("</script");
    expect(() => new Function(DESIGN_RUNTIME_SOURCE)).not.toThrow();
  });

  it("accepts only versioned response and event messages", () => {
    const response: DesignRuntimeFrameMessage = {
      protocol: DESIGN_RUNTIME_PROTOCOL,
      version: DESIGN_RUNTIME_VERSION,
      type: "response",
      requestId: "request-1",
      ok: true,
      result: null,
    };
    expect(isDesignRuntimeFrameMessage(response)).toBe(true);
    expect(
      isDesignRuntimeFrameMessage({
        ...response,
        protocol: "some-other-frame",
      }),
    ).toBe(false);
    expect(
      isDesignRuntimeFrameMessage({
        ...response,
        version: DESIGN_RUNTIME_VERSION + 1,
      }),
    ).toBe(false);
    expect(
      isDesignRuntimeFrameMessage({
        protocol: DESIGN_RUNTIME_PROTOCOL,
        version: DESIGN_RUNTIME_VERSION,
        type: "event",
        event: "ready",
        payload: {},
      }),
    ).toBe(true);
    expect(isDesignRuntimeFrameMessage({ type: "response" })).toBe(false);
  });

  it("publishes a ready snapshot when the authored frame has no main wrapper", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const result = await page.evaluate(
        ({ source }) =>
          new Promise<{
            leakedBeforeHandshake: boolean;
            payload: Record<string, unknown>;
          }>((resolve, reject) => {
            document.body.innerHTML =
              '<section data-oid="hero"><h1 data-oid="heading">Hello</h1></section>';
            (
              window as Window & {
                __zerosDesignSourceVersion?: string;
              }
            ).__zerosDesignSourceVersion = "a".repeat(24);
            const timeout = window.setTimeout(
              () => reject(new Error("ready snapshot timed out")),
              2_000,
            );
            let leakedBeforeHandshake = false;
            window.addEventListener("message", (event) => {
              if (
                event.source !== window ||
                event.origin !== window.location.origin
              ) {
                return;
              }
              const message = event.data as {
                protocol?: string;
                type?: string;
                event?: string;
              };
              if (
                message.protocol === "zeros-design-runtime" &&
                message.type === "event" &&
                message.event === "ready"
              ) {
                leakedBeforeHandshake = true;
              }
            });
            try {
              new Function(source)();
            } catch (error) {
              window.clearTimeout(timeout);
              reject(error);
              return;
            }
            const channel = new MessageChannel();
            channel.port1.onmessage = (event) => {
              const message = event.data as {
                protocol?: string;
                type?: string;
                event?: string;
                payload?: Record<string, unknown>;
              };
              if (
                message.protocol !== "zeros-design-runtime" ||
                message.type !== "event" ||
                message.event !== "ready" ||
                !message.payload
              ) {
                return;
              }
              window.clearTimeout(timeout);
              resolve({ leakedBeforeHandshake, payload: message.payload });
            };
            channel.port1.start();
            window.setTimeout(() => {
              window.postMessage(
                {
                  protocol: "zeros-design-runtime",
                  version: 1,
                  type: "handshake",
                },
                "*",
                [channel.port2],
              );
              channel.port1.postMessage({
                protocol: "zeros-design-runtime",
                version: 1,
                type: "request",
                requestId: "initial-snapshot",
                method: "getSnapshot",
                args: {},
              });
            }, 0);
          }),
        { source: DESIGN_RUNTIME_SOURCE },
      );

      expect(result.leakedBeforeHandshake).toBe(false);
      expect(result.payload).toMatchObject({
        tree: [{ oid: "hero", tag: "section" }],
        frame: { oid: "", tag: "body", selector: "body" },
      });
    } finally {
      await browser.close();
    }
  }, 20_000);

  it("rasterizes embedded CSS and image pixels in a node screenshot", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const pixels = await page.evaluate(
        async ({ source }) => {
          document.documentElement.style.margin = "0";
          document.body.style.margin = "0";
          const seed = document.createElement("canvas");
          seed.width = 10;
          seed.height = 10;
          const seedContext = seed.getContext("2d")!;
          seedContext.fillStyle = "rgb(0, 0, 255)";
          seedContext.fillRect(0, 0, 10, 10);
          document.body.innerHTML =
            '<main data-oid="target" style="width:40px;height:20px;background:rgb(255,0,0)">' +
            `<img alt="Blue" src="${seed.toDataURL("image/png")}" style="display:block;width:10px;height:10px">` +
            `<span style="position:absolute;left:20px;top:10px;width:10px;height:10px;background-image:url(${seed.toDataURL("image/png")});background-size:100% 100%"></span>` +
            "</main>";
          await (document.querySelector("img") as HTMLImageElement).decode();
          (
            window as Window & { __zerosDesignSourceVersion?: string }
          ).__zerosDesignSourceVersion = "c".repeat(24);
          const requestId = "capture-self-contained";
          const channel = new MessageChannel();
          const response = new Promise<{ dataUrl: string }>(
            (resolve, reject) => {
              const timeout = window.setTimeout(
                () => reject(new Error("capture response timed out")),
                5_000,
              );
              channel.port1.onmessage = (event) => {
                const message = event.data as {
                  type?: string;
                  requestId?: string;
                  ok?: boolean;
                  result?: { dataUrl: string };
                  error?: string;
                };
                if (
                  message.type !== "response" ||
                  message.requestId !== requestId
                ) {
                  return;
                }
                window.clearTimeout(timeout);
                if (message.ok && message.result) resolve(message.result);
                else reject(new Error(message.error ?? "capture failed"));
              };
            },
          );
          new Function(source)();
          channel.port1.start();
          window.postMessage(
            {
              protocol: "zeros-design-runtime",
              version: 1,
              type: "handshake",
            },
            "*",
            [channel.port2],
          );
          channel.port1.postMessage({
            protocol: "zeros-design-runtime",
            version: 1,
            type: "request",
            requestId,
            method: "captureScreenshot",
            args: { nodeId: "target", scale: 1 },
          });
          const screenshot = await response;
          const image = new Image();
          image.src = screenshot.dataUrl;
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = image.width;
          canvas.height = image.height;
          const context = canvas.getContext("2d")!;
          context.drawImage(image, 0, 0);
          return {
            image: Array.from(context.getImageData(5, 5, 1, 1).data),
            cssImage: Array.from(context.getImageData(25, 15, 1, 1).data),
            background: Array.from(context.getImageData(30, 10, 1, 1).data),
          };
        },
        { source: DESIGN_RUNTIME_SOURCE },
      );

      expect(pixels.image).toEqual([0, 0, 255, 255]);
      expect(pixels.cssImage).toEqual([0, 0, 255, 255]);
      expect(pixels.background).toEqual([255, 0, 0, 255]);
    } finally {
      await browser.close();
    }
  }, 20_000);
});
