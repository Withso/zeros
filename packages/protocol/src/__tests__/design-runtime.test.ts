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
    expect(DESIGN_RUNTIME_SOURCE).toContain("setTheme");
    expect(DESIGN_RUNTIME_SOURCE).toContain("clearPreviewStyles");
    expect(DESIGN_RUNTIME_SOURCE).toContain("getMatchedStyles");
    expect(DESIGN_RUNTIME_SOURCE).toContain('message.type === "teardown"');
    expect(DESIGN_RUNTIME_SOURCE).toContain('message.type === "cancel"');
    expect(DESIGN_RUNTIME_SOURCE).toContain("previewStyleOverridesByOid");
    expect(DESIGN_RUNTIME_SOURCE).toContain("auditWarnings");
    expect(DESIGN_RUNTIME_SOURCE).toContain("contrastRatio");
    expect(DESIGN_RUNTIME_SOURCE).toContain("spacing-scale");
    expect(DESIGN_RUNTIME_SOURCE).toContain("MAX_TREE_NODES = 20000");
    expect(DESIGN_RUNTIME_SOURCE).toContain("MAX_TREE_DEPTH = 32");
    expect(DESIGN_RUNTIME_SOURCE).toContain("__zerosDesignSourceVersion");
    expect(DESIGN_RUNTIME_SOURCE).toContain(
      "sourceVersion: SOURCE_VERSION,\n      oid: oid",
    );
    expect(DESIGN_RUNTIME_SOURCE).toContain("treeNode(body, 0, treeBudget)");
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

  it("accepts only bounded, versioned response and event messages", () => {
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
    ).toBe(false);
    expect(
      isDesignRuntimeFrameMessage({
        protocol: DESIGN_RUNTIME_PROTOCOL,
        version: DESIGN_RUNTIME_VERSION,
        type: "response",
        requestId: "request-1",
        ok: false,
        error: {
          code: "NOT_A_REAL_CODE",
          message: "bad",
          retryable: false,
        },
      }),
    ).toBe(false);
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
            let nested = document.querySelector('[data-oid="hero"]')!;
            for (let index = 0; index < 33; index += 1) {
              const child = document.createElement("div");
              child.dataset.oid = `nested-${index}`;
              nested.append(child);
              nested = child;
            }
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
                  version: 2,
                  type: "handshake",
                  sourceVersion: "a".repeat(24),
                },
                "*",
                [channel.port2],
              );
              channel.port1.postMessage({
                protocol: "zeros-design-runtime",
                version: 2,
                type: "request",
                sourceVersion: "a".repeat(24),
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
        sourceVersion: "a".repeat(24),
        capabilities: {
          sourcePinned: true,
          cancellation: true,
          typedErrors: true,
        },
        snapshot: {
          tree: [{ oid: "hero", tag: "section" }],
          frame: { oid: "", tag: "body", selector: "body" },
        },
      });
      expect(
        (
          result.payload.snapshot as {
            warnings: Array<{ ruleId: string }>;
          }
        ).warnings,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ ruleId: "layer-tree-limit" }),
        ]),
      );
    } finally {
      await browser.close();
    }
  }, 20_000);

  it("preserves case-sensitive custom properties and restores previews on teardown", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const result = await page.evaluate(
        ({ source }) =>
          new Promise<{
            property: string;
            computedValue: string;
            previewWidth: string;
            restoredWidth: string;
          }>((resolve, reject) => {
            document.body.innerHTML =
              '<main data-oid="target" style="--BrandColor: rgb(1, 2, 3)"></main>';
            (
              window as Window & { __zerosDesignSourceVersion?: string }
            ).__zerosDesignSourceVersion = "b".repeat(24);
            const element = document.querySelector(
              '[data-oid="target"]',
            ) as HTMLElement;
            const channel = new MessageChannel();
            let matched: { property: string; computedValue: string } | null =
              null;
            const timeout = window.setTimeout(
              () => reject(new Error("runtime lifecycle timed out")),
              3_000,
            );
            channel.port1.onmessage = (event) => {
              const message = event.data as {
                type?: string;
                event?: string;
                requestId?: string;
                ok?: boolean;
                result?: { property?: string; computedValue?: string };
              };
              if (message.type === "event" && message.event === "ready") {
                channel.port1.postMessage({
                  protocol: "zeros-design-runtime",
                  version: 2,
                  type: "request",
                  sourceVersion: "b".repeat(24),
                  requestId: "matched",
                  method: "getMatchedStyles",
                  args: { nodeId: "target", property: "--BrandColor" },
                });
                return;
              }
              if (
                message.type === "response" &&
                message.requestId === "matched" &&
                message.ok &&
                message.result
              ) {
                matched = {
                  property: message.result.property ?? "",
                  computedValue: message.result.computedValue ?? "",
                };
                channel.port1.postMessage({
                  protocol: "zeros-design-runtime",
                  version: 2,
                  type: "request",
                  sourceVersion: "b".repeat(24),
                  requestId: "preview",
                  method: "previewStyles",
                  args: { nodeId: "target", styles: { width: "37px" } },
                });
                return;
              }
              if (
                message.type === "response" &&
                message.requestId === "preview" &&
                message.ok &&
                matched
              ) {
                const previewWidth = element.style.width;
                channel.port1.postMessage({
                  protocol: "zeros-design-runtime",
                  version: 2,
                  type: "teardown",
                  sourceVersion: "b".repeat(24),
                });
                window.setTimeout(() => {
                  window.clearTimeout(timeout);
                  resolve({
                    ...matched!,
                    previewWidth,
                    restoredWidth: element.style.width,
                  });
                }, 0);
              }
            };
            channel.port1.start();
            new Function(source)();
            window.postMessage(
              {
                protocol: "zeros-design-runtime",
                version: 2,
                type: "handshake",
                sourceVersion: "b".repeat(24),
              },
              "*",
              [channel.port2],
            );
          }),
        { source: DESIGN_RUNTIME_SOURCE },
      );
      expect(result).toEqual({
        property: "--BrandColor",
        computedValue: "rgb(1, 2, 3)",
        previewWidth: "37px",
        restoredWidth: "",
      });
    } finally {
      await browser.close();
    }
  }, 20_000);

  it("scrubs and clears a multi-keyframe motion preview", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const result = await page.evaluate(
        ({ source }) =>
          new Promise<{ previewOpacity: number; restoredOpacity: number }>(
            (resolve, reject) => {
              document.body.innerHTML =
                '<main data-oid="target" style="opacity: .2"></main>';
              (
                window as Window & { __zerosDesignSourceVersion?: string }
              ).__zerosDesignSourceVersion = "f".repeat(24);
              const element = document.querySelector(
                '[data-oid="target"]',
              ) as HTMLElement;
              const channel = new MessageChannel();
              let previewOpacity = 0;
              const timeout = window.setTimeout(
                () => reject(new Error("motion preview timed out")),
                3_000,
              );
              channel.port1.onmessage = (event) => {
                const message = event.data as {
                  type?: string;
                  event?: string;
                  requestId?: string;
                  ok?: boolean;
                  error?: { message?: string };
                };
                if (message.type === "event" && message.event === "ready") {
                  channel.port1.postMessage({
                    protocol: "zeros-design-runtime",
                    version: 2,
                    type: "request",
                    sourceVersion: "f".repeat(24),
                    requestId: "motion",
                    method: "previewMotion",
                    args: {
                      nodeId: "target",
                      keyframes: [
                        { offset: 0, styles: { opacity: "0" } },
                        { offset: 50, styles: { opacity: ".4" } },
                        { offset: 100, styles: { opacity: "1" } },
                      ],
                      duration: 1_000,
                      delay: 0,
                      easing: "linear",
                      iterations: 1,
                      direction: "normal",
                      fill: "both",
                      currentTime: 500,
                      playing: false,
                    },
                  });
                  return;
                }
                if (
                  message.type === "response" &&
                  message.requestId === "motion"
                ) {
                  if (!message.ok) {
                    reject(
                      new Error(message.error?.message ?? "motion failed"),
                    );
                    return;
                  }
                  previewOpacity = Number(getComputedStyle(element).opacity);
                  channel.port1.postMessage({
                    protocol: "zeros-design-runtime",
                    version: 2,
                    type: "request",
                    sourceVersion: "f".repeat(24),
                    requestId: "clear",
                    method: "clearPreviewStyles",
                    args: { nodeId: "target" },
                  });
                  return;
                }
                if (
                  message.type === "response" &&
                  message.requestId === "clear"
                ) {
                  window.clearTimeout(timeout);
                  resolve({
                    previewOpacity,
                    restoredOpacity: Number(getComputedStyle(element).opacity),
                  });
                }
              };
              channel.port1.start();
              new Function(source)();
              window.postMessage(
                {
                  protocol: "zeros-design-runtime",
                  version: 2,
                  type: "handshake",
                  sourceVersion: "f".repeat(24),
                },
                "*",
                [channel.port2],
              );
            },
          ),
        { source: DESIGN_RUNTIME_SOURCE },
      );
      expect(result.previewOpacity).toBeCloseTo(0.4, 2);
      expect(result.restoredOpacity).toBeCloseTo(0.2, 2);
    } finally {
      await browser.close();
    }
  }, 20_000);

  it("applies token themes and resolves nested canvas hit modes", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const result = await page.evaluate(
        ({ source }) =>
          new Promise<{
            topLevel: string;
            descended: string;
            deepestDescend: string;
            nestedPeer: string;
            authoredStyleProperties: string[];
            parentTextEditable: boolean;
            childTextEditable: boolean;
            marquee: string[];
            theme: string | null;
            background: string;
            repeatedThemeRevisionStable: boolean;
          }>((resolve, reject) => {
            document.head.innerHTML = `<style>
              :root { --accent: rgb(255, 0, 0); }
              [data-zd-theme="dark"] { --accent: rgb(0, 0, 255); }
              body { margin: 0; }
              [data-oid="parent"] { position: absolute; inset: 0; width: 200px; height: 100px; }
              [data-oid="child"], [data-oid="peer"] { position: absolute; top: 0; display: block; width: 100px; height: 100px; }
              [data-oid="child"] { left: 0; background: var(--accent); }
              [data-oid="peer"] { left: 100px; }
            </style>`;
            document.body.innerHTML =
              '<main data-oid="parent"><button data-oid="child" style="margin-right: 50px; padding: 10px 32px 32px; inset-inline-start: 4px">Child</button><button data-oid="peer">Peer</button></main>';
            (
              window as Window & { __zerosDesignSourceVersion?: string }
            ).__zerosDesignSourceVersion = "f".repeat(24);
            const channel = new MessageChannel();
            const values = {
              topLevel: "",
              descended: "",
              deepestDescend: "",
              nestedPeer: "",
              authoredStyleProperties: [] as string[],
              parentTextEditable: false,
              childTextEditable: false,
              marquee: [] as string[],
            };
            let firstThemeRevision: number | undefined;
            const timeout = window.setTimeout(
              () => reject(new Error("theme and hit-mode requests timed out")),
              3_000,
            );
            const request = (
              requestId: string,
              method: string,
              args: Record<string, unknown>,
            ) =>
              channel.port1.postMessage({
                protocol: "zeros-design-runtime",
                version: 2,
                type: "request",
                sourceVersion: "f".repeat(24),
                requestId,
                method,
                args,
              });
            channel.port1.onmessage = (event) => {
              const message = event.data as {
                type?: string;
                event?: string;
                requestId?: string;
                ok?: boolean;
                result?:
                  | {
                      oid?: string;
                      revision?: number;
                      textEditable?: boolean;
                      authoredStyleProperties?: string[];
                    }
                  | Array<{ oid?: string }>;
                error?: { message?: string };
              };
              if (message.type === "event" && message.event === "ready") {
                request("top", "getElementAtLoc", {
                  x: 50,
                  y: 50,
                  mode: "top-level",
                });
                return;
              }
              if (message.type !== "response") return;
              if (!message.ok) {
                window.clearTimeout(timeout);
                reject(new Error(message.error?.message ?? "runtime failed"));
                return;
              }
              const objectResult = Array.isArray(message.result)
                ? undefined
                : message.result;
              if (message.requestId === "top") {
                values.topLevel = objectResult?.oid ?? "";
                values.parentTextEditable = objectResult?.textEditable === true;
                request("descend", "getElementAtLoc", {
                  x: 50,
                  y: 50,
                  mode: "descend",
                  selectedNodeId: "parent",
                });
              } else if (message.requestId === "descend") {
                values.descended = objectResult?.oid ?? "";
                values.childTextEditable = objectResult?.textEditable === true;
                request("deepest-descend", "getElementAtLoc", {
                  x: 50,
                  y: 50,
                  mode: "descend",
                  selectedNodeId: "child",
                });
              } else if (message.requestId === "deepest-descend") {
                values.deepestDescend = objectResult?.oid ?? "";
                request("peer-preserve", "getElementAtLoc", {
                  x: 150,
                  y: 50,
                  mode: "preserve",
                  selectedNodeId: "child",
                });
              } else if (message.requestId === "peer-preserve") {
                values.nestedPeer = objectResult?.oid ?? "";
                request("child-details", "getNodeDetails", {
                  nodeId: "child",
                });
              } else if (message.requestId === "child-details") {
                values.authoredStyleProperties =
                  objectResult?.authoredStyleProperties ?? [];
                request("marquee", "getElementsInRect", {
                  x: 0,
                  y: 0,
                  width: 60,
                  height: 60,
                  scopeNodeId: "parent",
                });
              } else if (message.requestId === "marquee") {
                values.marquee = Array.isArray(message.result)
                  ? message.result.flatMap((item) =>
                      item.oid ? [item.oid] : [],
                    )
                  : [];
                request("theme", "setTheme", { theme: "dark" });
              } else if (message.requestId === "theme") {
                firstThemeRevision = objectResult?.revision;
                request("theme-again", "setTheme", { theme: "dark" });
              } else if (message.requestId === "theme-again") {
                window.clearTimeout(timeout);
                const child = document.querySelector(
                  '[data-oid="child"]',
                ) as HTMLElement;
                resolve({
                  ...values,
                  theme: document.documentElement.getAttribute("data-zd-theme"),
                  background: getComputedStyle(child).backgroundColor,
                  repeatedThemeRevisionStable:
                    firstThemeRevision === objectResult?.revision,
                });
              }
            };
            channel.port1.start();
            new Function(source)();
            window.postMessage(
              {
                protocol: "zeros-design-runtime",
                version: 2,
                type: "handshake",
                sourceVersion: "f".repeat(24),
              },
              "*",
              [channel.port2],
            );
          }),
        { source: DESIGN_RUNTIME_SOURCE },
      );

      expect(result).toEqual({
        topLevel: "parent",
        descended: "child",
        deepestDescend: "child",
        nestedPeer: "peer",
        authoredStyleProperties: expect.arrayContaining([
          "background",
          "inset-inline-start",
          "margin-right",
          "padding",
        ]),
        parentTextEditable: false,
        childTextEditable: true,
        marquee: ["child"],
        theme: "dark",
        background: "rgb(0, 0, 255)",
        repeatedThemeRevisionStable: true,
      });
    } finally {
      await browser.close();
    }
  }, 20_000);

  it("answers layout-sensitive requests when animation frames are suspended", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const width = await page.evaluate(
        ({ source }) =>
          new Promise<string>((resolve, reject) => {
            document.body.innerHTML = '<main data-oid="target"></main>';
            (
              window as Window & { __zerosDesignSourceVersion?: string }
            ).__zerosDesignSourceVersion = "e".repeat(24);
            window.requestAnimationFrame = () => 1;
            const target = document.querySelector(
              '[data-oid="target"]',
            ) as HTMLElement;
            const channel = new MessageChannel();
            const timeout = window.setTimeout(
              () => reject(new Error("preview response timed out")),
              500,
            );
            channel.port1.onmessage = (event) => {
              const message = event.data as {
                type?: string;
                event?: string;
                requestId?: string;
                ok?: boolean;
                error?: { message?: string };
              };
              if (message.type === "event" && message.event === "ready") {
                channel.port1.postMessage({
                  protocol: "zeros-design-runtime",
                  version: 2,
                  type: "request",
                  sourceVersion: "e".repeat(24),
                  requestId: "suspended-preview",
                  method: "previewStyles",
                  args: { nodeId: "target", styles: { width: "41px" } },
                });
                return;
              }
              if (
                message.type !== "response" ||
                message.requestId !== "suspended-preview"
              ) {
                return;
              }
              window.clearTimeout(timeout);
              if (message.ok) resolve(target.style.width);
              else
                reject(new Error(message.error?.message ?? "preview failed"));
            };
            channel.port1.start();
            new Function(source)();
            window.postMessage(
              {
                protocol: "zeros-design-runtime",
                version: 2,
                type: "handshake",
                sourceVersion: "e".repeat(24),
              },
              "*",
              [channel.port2],
            );
          }),
        { source: DESIGN_RUNTIME_SOURCE },
      );

      expect(width).toBe("41px");
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
                  error?: { message?: string };
                };
                if (
                  message.type !== "response" ||
                  message.requestId !== requestId
                ) {
                  return;
                }
                window.clearTimeout(timeout);
                if (message.ok && message.result) resolve(message.result);
                else
                  reject(new Error(message.error?.message ?? "capture failed"));
              };
            },
          );
          new Function(source)();
          channel.port1.start();
          window.postMessage(
            {
              protocol: "zeros-design-runtime",
              version: 2,
              type: "handshake",
              sourceVersion: "c".repeat(24),
            },
            "*",
            [channel.port2],
          );
          channel.port1.postMessage({
            protocol: "zeros-design-runtime",
            version: 2,
            type: "request",
            sourceVersion: "c".repeat(24),
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
