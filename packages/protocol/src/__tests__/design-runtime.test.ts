import { describe, expect, it } from "vitest";
import { chromium } from "@playwright/test";

import {
  DESIGN_RUNTIME_PROTOCOL,
  DESIGN_RUNTIME_SOURCE,
  DESIGN_RUNTIME_VERSION,
  isDesignRuntimeFrameMessage,
  type DesignRuntimeFrameMessage,
  type DesignRuntimeNodeBox,
  type DesignRuntimeNodeDetails,
  type DesignRuntimeNodeGeometry,
  type DesignRuntimeRect,
} from "../design-runtime";

describe("design runtime protocol", () => {
  it("ships one self-contained runtime with the stable protocol marker", () => {
    expect(DESIGN_RUNTIME_SOURCE).toContain(DESIGN_RUNTIME_PROTOCOL);
    expect(DESIGN_RUNTIME_SOURCE).toContain("MutationObserver");
    expect(DESIGN_RUNTIME_SOURCE).toContain("elementsFromPoint");
    expect(DESIGN_RUNTIME_SOURCE).toContain("captureScreenshot");
    expect(DESIGN_RUNTIME_SOURCE).toContain("previewStyles");
    expect(DESIGN_RUNTIME_SOURCE).toContain("previewGeometry");
    // The gesture path must not pay for the inspector's style catalog.
    expect(DESIGN_RUNTIME_SOURCE).toContain("GEOMETRY_STYLE_PROPERTIES");
    expect(DESIGN_RUNTIME_SOURCE).toContain("previewText");
    expect(DESIGN_RUNTIME_SOURCE).toContain("clearPreviewText");
    expect(DESIGN_RUNTIME_SOURCE).toContain("commitStyles");
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
    expect(DESIGN_RUNTIME_SOURCE).toContain("publishGenerationNow");
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

  it("previews direct text and restores the authored value on cancellation", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const result = await page.evaluate(
        ({ source }) =>
          new Promise<{
            authored: string;
            sizing: string;
            preview: string;
            restored: string;
            previewPaint: string;
            previewFill: string;
            restoredPaint: string;
            restoredFill: string;
          }>((resolve, reject) => {
            const sourceVersion = "9".repeat(24);
            const authored = `  Original line\n  ${"extended ".repeat(24)}tail  `;
            document.body.innerHTML =
              '<main data-oid="root"><p data-oid="copy" style="color:rgb(1, 2, 3);width:max-content;white-space:pre-wrap"></p></main>';
            (
              window as Window & { __zerosDesignSourceVersion?: string }
            ).__zerosDesignSourceVersion = sourceVersion;
            const element = document.querySelector(
              '[data-oid="copy"]',
            ) as HTMLElement;
            element.textContent = authored;
            const channel = new MessageChannel();
            const timeout = window.setTimeout(
              () => reject(new Error("text preview timed out")),
              3_000,
            );
            channel.port1.onmessage = (event) => {
              const message = event.data as {
                type?: string;
                event?: string;
                requestId?: string;
                ok?: boolean;
              };
              if (message.type === "event" && message.event === "ready") {
                channel.port1.postMessage({
                  protocol: "zeros-design-runtime",
                  version: 2,
                  type: "request",
                  sourceVersion,
                  requestId: "text-details",
                  method: "getNodeDetails",
                  args: { nodeId: "copy" },
                });
                return;
              }
              if (
                message.type === "response" &&
                message.requestId === "text-details" &&
                message.ok
              ) {
                (window as Window & { __authored?: string }).__authored = (
                  message as { result?: { text?: string } }
                ).result?.text;
                (window as Window & { __sizing?: string }).__sizing = (
                  message as { result?: { textSizing?: { width?: string } } }
                ).result?.textSizing?.width;
                channel.port1.postMessage({
                  protocol: "zeros-design-runtime",
                  version: 2,
                  type: "request",
                  sourceVersion,
                  requestId: "preview-text",
                  method: "previewText",
                  args: { nodeId: "copy", text: "Live\ncopy" },
                });
                return;
              }
              if (
                message.type === "response" &&
                message.requestId === "preview-text" &&
                message.ok
              ) {
                const preview = element.textContent ?? "";
                channel.port1.postMessage({
                  protocol: "zeros-design-runtime",
                  version: 2,
                  type: "request",
                  sourceVersion,
                  requestId: "clear-text",
                  method: "clearPreviewText",
                  args: { nodeId: "copy" },
                });
                (window as Window & { __preview?: string }).__preview = preview;
                (
                  window as Window & { __previewPaint?: string }
                ).__previewPaint = getComputedStyle(element).color;
                (window as Window & { __previewFill?: string }).__previewFill =
                  getComputedStyle(element).webkitTextFillColor;
                return;
              }
              if (
                message.type === "response" &&
                message.requestId === "clear-text" &&
                message.ok
              ) {
                window.clearTimeout(timeout);
                resolve({
                  authored:
                    (window as Window & { __authored?: string }).__authored ??
                    "",
                  sizing:
                    (window as Window & { __sizing?: string }).__sizing ?? "",
                  preview:
                    (window as Window & { __preview?: string }).__preview ?? "",
                  restored: element.textContent ?? "",
                  previewPaint:
                    (window as Window & { __previewPaint?: string })
                      .__previewPaint ?? "",
                  previewFill:
                    (window as Window & { __previewFill?: string })
                      .__previewFill ?? "",
                  restoredPaint: getComputedStyle(element).color,
                  restoredFill: getComputedStyle(element).webkitTextFillColor,
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
                sourceVersion,
              },
              "*",
              [channel.port2],
            );
          }),
        { source: DESIGN_RUNTIME_SOURCE },
      );
      expect(result).toEqual({
        authored: `  Original line\n  ${"extended ".repeat(24)}tail  `,
        sizing: "max-content",
        preview: "Live\ncopy",
        restored: `  Original line\n  ${"extended ".repeat(24)}tail  `,
        // Runtime paint suppression must never poison semantic/computed color
        // readback used by the host contenteditable on the next edit.
        previewPaint: "rgb(1, 2, 3)",
        previewFill: "rgba(0, 0, 0, 0)",
        restoredPaint: "rgb(1, 2, 3)",
        restoredFill: "rgb(1, 2, 3)",
      });
    } finally {
      await browser.close();
    }
  }, 20_000);

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

  it("republishes the layer tree so a hidden node can be shown again", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const result = await page.evaluate(
        ({ source }) =>
          new Promise<{
            timeline: string[];
            hiddenDetails: boolean | null;
            shownDetails: boolean | null;
            painted: string[];
          }>((resolve, reject) => {
            const sourceVersion = "b".repeat(24);
            document.body.innerHTML =
              '<main data-oid="root"><p data-oid="copy">Hide me</p></main>';
            (
              window as Window & { __zerosDesignSourceVersion?: string }
            ).__zerosDesignSourceVersion = sourceVersion;
            const element = document.querySelector(
              '[data-oid="copy"]',
            ) as HTMLElement;
            const timeline: string[] = [];
            const painted: string[] = [];
            let hiddenDetails: boolean | null = null;
            let shownDetails: boolean | null = null;
            const channel = new MessageChannel();
            const timeout = window.setTimeout(
              () => reject(new Error("visibility publication timed out")),
              3_000,
            );
            interface TreeNode {
              oid: string;
              visible: boolean;
              children: TreeNode[];
            }
            const treeVisible = (nodes: TreeNode[]): boolean | null => {
              for (const node of nodes) {
                if (node.oid === "copy") return node.visible;
                const found = treeVisible(node.children);
                if (found !== null) return found;
              }
              return null;
            };
            const toggle = (requestId: string, visible: boolean) => {
              channel.port1.postMessage({
                protocol: "zeros-design-runtime",
                version: 2,
                type: "request",
                sourceVersion,
                requestId,
                method: "setNodeVisibility",
                args: { nodeId: "copy", visible },
              });
            };
            channel.port1.onmessage = (event) => {
              const message = event.data as {
                type?: string;
                event?: string;
                requestId?: string;
                ok?: boolean;
                payload?: { tree?: TreeNode[] };
                result?: { visible?: boolean };
              };
              if (message.type === "event" && message.event === "ready") {
                toggle("hide", false);
                return;
              }
              if (message.type === "event") {
                // The Layers tree only ever learns a node is hidden from a
                // republished generation; a details response cannot carry it.
                timeline.push(
                  `mutation:${String(treeVisible(message.payload?.tree ?? []))}`,
                );
                painted.push(getComputedStyle(element).display);
                return;
              }
              if (
                message.type === "response" &&
                message.requestId === "hide" &&
                message.ok
              ) {
                timeline.push("response:hide");
                hiddenDetails = message.result?.visible ?? null;
                toggle("show", true);
                return;
              }
              if (
                message.type === "response" &&
                message.requestId === "show" &&
                message.ok
              ) {
                timeline.push("response:show");
                shownDetails = message.result?.visible ?? null;
                window.clearTimeout(timeout);
                resolve({ timeline, hiddenDetails, shownDetails, painted });
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
        { source: DESIGN_RUNTIME_SOURCE },
      );
      expect(result).toEqual({
        // Each toggle publishes its own generation before answering, so the
        // host never has to guess the next toggle's direction.
        timeline: [
          "mutation:false",
          "response:hide",
          "mutation:true",
          "response:show",
        ],
        hiddenDetails: false,
        shownDetails: true,
        painted: ["none", "block"],
      });
    } finally {
      await browser.close();
    }
  }, 20_000);

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
            document.body.style.cssText =
              "display:grid;grid-auto-columns:37px;outline:2px solid;font-style:italic;text-indent:7px;overflow-wrap:anywhere;perspective-origin:25% 75%";
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
      expect(
        isDesignRuntimeFrameMessage({
          protocol: DESIGN_RUNTIME_PROTOCOL,
          version: DESIGN_RUNTIME_VERSION,
          type: "event",
          event: "ready",
          payload: result.payload,
        }),
      ).toBe(true);
      expect(result.payload).toMatchObject({
        sourceVersion: "a".repeat(24),
        capabilities: {
          sourcePinned: true,
          cancellation: true,
          typedErrors: true,
        },
        snapshot: {
          tree: [{ oid: "hero", tag: "section" }],
          frame: {
            oid: "",
            tag: "body",
            selector: "body",
            styles: {
              gridAutoColumns: "37px",
              outlineWidth: "2px",
              fontStyle: "italic",
              textIndent: "7px",
              overflowWrap: "anywhere",
              perspectiveOrigin: expect.any(String),
            },
          },
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

  it("does not publish ready pixels before text fonts finish layout", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const result = await page.evaluate(
        ({ source }) =>
          new Promise<{
            readyBeforeFonts: boolean;
            textStayedConnected: boolean;
          }>((resolve, reject) => {
            let releaseFonts: (() => void) | null = null;
            const fontsReady = new Promise<void>((release) => {
              releaseFonts = release;
            });
            Object.defineProperty(document, "fonts", {
              configurable: true,
              value: { ready: fontsReady },
            });
            document.body.innerHTML =
              '<main data-oid="target">Canvas typography</main>';
            (
              window as Window & { __zerosDesignSourceVersion?: string }
            ).__zerosDesignSourceVersion = "f".repeat(24);
            const textNode = document.querySelector(
              '[data-oid="target"]',
            )?.firstChild;
            const channel = new MessageChannel();
            let fontsReleased = false;
            const timeout = window.setTimeout(
              () => reject(new Error("font-ready runtime handshake timed out")),
              2_000,
            );
            channel.port1.onmessage = (event) => {
              const message = event.data as {
                type?: string;
                event?: string;
              };
              if (message.type !== "event" || message.event !== "ready") {
                return;
              }
              window.clearTimeout(timeout);
              resolve({
                readyBeforeFonts: !fontsReleased,
                textStayedConnected:
                  textNode !== null &&
                  textNode !== undefined &&
                  textNode.isConnected,
              });
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
            window.setTimeout(() => {
              fontsReleased = true;
              releaseFonts?.();
            }, 50);
          }),
        { source: DESIGN_RUNTIME_SOURCE },
      );

      expect(result).toEqual({
        readyBeforeFonts: false,
        textStayedConnected: true,
      });
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

  it("adopts a confirmed style generation without tearing down the painted document", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const result = await page.evaluate(
        ({ source }) =>
          new Promise<{
            commitVersion: string;
            patchVersion: string;
            detailsVersion: string;
            committedWidth: string;
            committedInlineWidth: string;
            committedPriority: string;
            committedKeyframeCount: number;
            committedKeyframeOpacity: string;
            committedTokenColor: string;
            generationStyleStable: boolean;
            keyframeRuleStable: boolean;
            textNodeStable: boolean;
            previewWidth: string;
          }>((resolve, reject) => {
            const previousVersion = "c".repeat(24);
            const nextVersion = "d".repeat(24);
            const patchVersion = "e".repeat(24);
            document.documentElement.dataset.zdTheme = "dark";
            document.head.innerHTML =
              '<style>[data-oid="target"] { width: 10px !important; color: var(--accent, rgb(0, 0, 0)); }</style>';
            document.body.innerHTML =
              '<main data-oid="target">Canvas copy</main>';
            (
              window as Window & { __zerosDesignSourceVersion?: string }
            ).__zerosDesignSourceVersion = previousVersion;
            const element = document.querySelector(
              '[data-oid="target"]',
            ) as HTMLElement;
            const channel = new MessageChannel();
            let commitVersion = "";
            let committedGenerationStyle: HTMLStyleElement | null = null;
            let committedKeyframeRule: CSSKeyframesRule | null = null;
            const textNode = element.firstChild;
            let previewWidth = "";
            const timeout = window.setTimeout(
              () => reject(new Error("style generation adoption timed out")),
              3_000,
            );
            channel.port1.onmessage = (event) => {
              const message = event.data as {
                type?: string;
                event?: string;
                requestId?: string;
                ok?: boolean;
                result?: {
                  sourceVersion?: string;
                  sourceVersionDetails?: string;
                };
              };
              if (message.type === "event" && message.event === "ready") {
                channel.port1.postMessage({
                  protocol: "zeros-design-runtime",
                  version: 2,
                  type: "request",
                  sourceVersion: previousVersion,
                  requestId: "preview",
                  method: "previewStyles",
                  args: { nodeId: "target", styles: { width: "240px" } },
                });
                return;
              }
              if (
                message.type === "response" &&
                message.requestId === "preview" &&
                message.ok
              ) {
                previewWidth = getComputedStyle(element).width;
                channel.port1.postMessage({
                  protocol: "zeros-design-runtime",
                  version: 2,
                  type: "request",
                  sourceVersion: previousVersion,
                  requestId: "commit",
                  method: "commitStyles",
                  args: {
                    nextSourceVersion: nextVersion,
                    updates: [{ nodeId: "target", styles: { width: "240px" } }],
                    patch: {
                      keyframes: [
                        {
                          name: "hero-enter",
                          keyframes: [
                            { offset: 0, styles: { opacity: "0" } },
                            { offset: 100, styles: { opacity: "1" } },
                          ],
                        },
                      ],
                      tokens: [
                        {
                          name: "--accent",
                          theme: "dark",
                          value: "rgb(9, 8, 7)",
                        },
                      ],
                    },
                  },
                });
                return;
              }
              if (
                message.type === "response" &&
                message.requestId === "commit" &&
                message.ok
              ) {
                commitVersion = message.result?.sourceVersion ?? "";
                committedGenerationStyle = document.querySelector(
                  "style[data-zeros-runtime-generation]",
                );
                committedKeyframeRule =
                  Array.from(
                    committedGenerationStyle?.sheet?.cssRules ?? [],
                  ).find(
                    (rule): rule is CSSKeyframesRule =>
                      rule instanceof CSSKeyframesRule &&
                      rule.name === "hero-enter",
                  ) ?? null;
                channel.port1.postMessage({
                  protocol: "zeros-design-runtime",
                  version: 2,
                  type: "request",
                  sourceVersion: nextVersion,
                  requestId: "commit-token",
                  method: "commitStyles",
                  args: {
                    nextSourceVersion: patchVersion,
                    updates: [],
                    patch: {
                      tokens: [
                        {
                          name: "--accent",
                          theme: "dark",
                          value: "rgb(7, 6, 5)",
                        },
                        {
                          name: "--accent",
                          theme: null,
                          value: "rgb(1, 2, 3)",
                        },
                      ],
                    },
                  },
                });
                return;
              }
              if (
                message.type === "response" &&
                message.requestId === "commit-token" &&
                message.ok
              ) {
                channel.port1.postMessage({
                  protocol: "zeros-design-runtime",
                  version: 2,
                  type: "request",
                  sourceVersion: patchVersion,
                  requestId: "details",
                  method: "getNodeDetails",
                  args: { nodeId: "target" },
                });
                return;
              }
              if (
                message.type === "response" &&
                message.requestId === "details" &&
                message.ok
              ) {
                const detailsVersion = message.result?.sourceVersion ?? "";
                channel.port1.postMessage({
                  protocol: "zeros-design-runtime",
                  version: 2,
                  type: "teardown",
                  sourceVersion: patchVersion,
                });
                window.setTimeout(() => {
                  window.clearTimeout(timeout);
                  const committedKeyframes = Array.from(
                    document.styleSheets,
                  ).flatMap((sheet) => {
                    try {
                      return Array.from(sheet.cssRules).filter(
                        (rule): rule is CSSKeyframesRule =>
                          rule instanceof CSSKeyframesRule &&
                          rule.name === "hero-enter",
                      );
                    } catch {
                      return [];
                    }
                  });
                  resolve({
                    commitVersion,
                    patchVersion,
                    detailsVersion,
                    committedWidth: getComputedStyle(element).width,
                    committedInlineWidth: element.style.width,
                    committedPriority: (
                      document.styleSheets[0]!.cssRules[0] as CSSStyleRule
                    ).style.getPropertyPriority("width"),
                    committedKeyframeCount: committedKeyframes.length,
                    committedKeyframeOpacity:
                      (
                        committedKeyframes[0]?.cssRules[1] as
                          | CSSKeyframeRule
                          | undefined
                      )?.style.opacity ?? "",
                    committedTokenColor: getComputedStyle(element).color,
                    generationStyleStable:
                      document.querySelector(
                        "style[data-zeros-runtime-generation]",
                      ) === committedGenerationStyle,
                    keyframeRuleStable: committedGenerationStyle?.sheet
                      ? Array.from(
                          committedGenerationStyle.sheet.cssRules,
                        ).includes(committedKeyframeRule!)
                      : false,
                    textNodeStable:
                      textNode !== null &&
                      textNode.isConnected &&
                      element.firstChild === textNode,
                    previewWidth,
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
                sourceVersion: previousVersion,
              },
              "*",
              [channel.port2],
            );
          }),
        { source: DESIGN_RUNTIME_SOURCE },
      );

      expect(result).toEqual({
        commitVersion: "d".repeat(24),
        patchVersion: "e".repeat(24),
        detailsVersion: "e".repeat(24),
        committedWidth: "240px",
        committedInlineWidth: "",
        committedPriority: "important",
        committedKeyframeCount: 1,
        committedKeyframeOpacity: "1",
        committedTokenColor: "rgb(7, 6, 5)",
        generationStyleStable: true,
        keyframeRuleStable: true,
        textNodeStable: true,
        previewWidth: "240px",
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
                      delay: 200,
                      easing: "linear",
                      iterations: 1,
                      direction: "normal",
                      fill: "both",
                      currentTime: 1_200,
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
      expect(result.previewOpacity).toBeCloseTo(1, 2);
      expect(result.restoredOpacity).toBeCloseTo(0.2, 2);
    } finally {
      await browser.close();
    }
  }, 20_000);

  it("keeps authored CSS animations static until an explicit motion preview", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const opacity = await page.evaluate(
        ({ source }) =>
          new Promise<{ initial: number; preview: number }>(
            (resolve, reject) => {
              document.head.innerHTML = `<style>
              @keyframes authored-opacity { from { opacity: 0 } to { opacity: 0 } }
              [data-oid="target"] {
                animation: authored-opacity 10s linear infinite;
                transition: opacity 10s linear;
              }
            </style>`;
              document.body.innerHTML =
                '<main data-oid="target" style="opacity: .2"></main>';
              (
                window as Window & { __zerosDesignSourceVersion?: string }
              ).__zerosDesignSourceVersion = "9".repeat(24);
              const element = document.querySelector(
                '[data-oid="target"]',
              ) as HTMLElement;
              const channel = new MessageChannel();
              let initial = 0;
              const timeout = window.setTimeout(
                () => reject(new Error("static motion guard timed out")),
                3_000,
              );
              channel.port1.onmessage = (event) => {
                const message = event.data as {
                  type?: string;
                  event?: string;
                  requestId?: string;
                  ok?: boolean;
                };
                if (message.type === "event" && message.event === "ready") {
                  initial = Number(getComputedStyle(element).opacity);
                  channel.port1.postMessage({
                    protocol: "zeros-design-runtime",
                    version: 2,
                    type: "request",
                    sourceVersion: "9".repeat(24),
                    requestId: "preview-static",
                    method: "previewStyles",
                    args: { nodeId: "target", styles: { opacity: ".8" } },
                  });
                  return;
                }
                if (
                  message.type !== "response" ||
                  message.requestId !== "preview-static" ||
                  !message.ok
                ) {
                  return;
                }
                window.clearTimeout(timeout);
                resolve({
                  initial,
                  preview: Number(getComputedStyle(element).opacity),
                });
              };
              channel.port1.start();
              new Function(source)();
              window.postMessage(
                {
                  protocol: "zeros-design-runtime",
                  version: 2,
                  type: "handshake",
                  sourceVersion: "9".repeat(24),
                },
                "*",
                [channel.port2],
              );
            },
          ),
        { source: DESIGN_RUNTIME_SOURCE },
      );
      expect(opacity.initial).toBeCloseTo(0.2, 2);
      expect(opacity.preview).toBeCloseTo(0.8, 2);
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
            peerAuthoredStyleProperties: string[];
            repeatedAuthoredScanStable: boolean;
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
              [data-oid="peer"] { left: 100px; background-color: red; }
            </style>`;
            document.body.dataset.oid = "frame-body";
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
              peerAuthoredStyleProperties: [] as string[],
              repeatedAuthoredScanStable: false,
              parentTextEditable: false,
              childTextEditable: false,
              marquee: [] as string[],
            };
            let firstThemeRevision: number | undefined;
            let authoredMatchesBeforeRepeat = 0;
            let authoredMatchCalls = 0;
            const originalMatches = Element.prototype.matches;
            Element.prototype.matches = function (selector: string) {
              authoredMatchCalls += 1;
              return originalMatches.call(this, selector);
            };
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
                values.peerAuthoredStyleProperties =
                  objectResult?.authoredStyleProperties ?? [];
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
                authoredMatchesBeforeRepeat = authoredMatchCalls;
                request("peer-details-again", "getNodeDetails", {
                  nodeId: "peer",
                });
              } else if (message.requestId === "peer-details-again") {
                values.repeatedAuthoredScanStable =
                  authoredMatchesBeforeRepeat === authoredMatchCalls;
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
        peerAuthoredStyleProperties: expect.arrayContaining([
          "background-color",
        ]),
        repeatedAuthoredScanStable: true,
        parentTextEditable: false,
        childTextEditable: true,
        marquee: ["child"],
        theme: "dark",
        background: "rgb(0, 0, 255)",
        repeatedThemeRevisionStable: true,
      });
      expect(result.peerAuthoredStyleProperties).not.toContain("background");
      expect(result.peerAuthoredStyleProperties).not.toContain(
        "background-image",
      );
    } finally {
      await browser.close();
    }
  }, 20_000);

  it("keeps preserve and descend depth aligned below an oid-bearing body", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const result = await page.evaluate(
        ({ source }) =>
          new Promise<{ preserve: string; descend: string }>(
            (resolve, reject) => {
              document.head.innerHTML = `<style>
                body { margin: 0; }
                [data-oid="left-1"], [data-oid="right-1"] {
                  position: absolute; top: 0; width: 100px; height: 100px;
                }
                [data-oid="left-1"] { left: 0; }
                [data-oid="right-1"] { left: 120px; }
                [data-oid$="-2"], [data-oid$="-3"], [data-oid$="-4"] {
                  position: absolute; inset: 0;
                }
              </style>`;
              document.body.dataset.oid = "frame-body";
              document.body.innerHTML =
                '<section data-oid="left-1"><div data-oid="left-2"><div data-oid="left-3"></div></div></section>' +
                '<section data-oid="right-1"><div data-oid="right-2"><div data-oid="right-3"><div data-oid="right-4"></div></div></div></section>';
              (
                window as Window & { __zerosDesignSourceVersion?: string }
              ).__zerosDesignSourceVersion = "d".repeat(24);
              const channel = new MessageChannel();
              const values = { preserve: "", descend: "" };
              const timeout = window.setTimeout(
                () => reject(new Error("nested hit requests timed out")),
                3_000,
              );
              const request = (
                requestId: string,
                mode: "preserve" | "descend",
                selectedNodeId: string,
              ) =>
                channel.port1.postMessage({
                  protocol: "zeros-design-runtime",
                  version: 2,
                  type: "request",
                  sourceVersion: "d".repeat(24),
                  requestId,
                  method: "getElementAtLoc",
                  args: { x: 150, y: 50, mode, selectedNodeId },
                });
              channel.port1.onmessage = (event) => {
                const message = event.data as {
                  type?: string;
                  event?: string;
                  requestId?: string;
                  ok?: boolean;
                  result?: { oid?: string };
                  error?: { message?: string };
                };
                if (message.type === "event" && message.event === "ready") {
                  request("preserve", "preserve", "left-3");
                  return;
                }
                if (message.type !== "response") return;
                if (!message.ok) {
                  window.clearTimeout(timeout);
                  reject(new Error(message.error?.message ?? "runtime failed"));
                  return;
                }
                if (message.requestId === "preserve") {
                  values.preserve = message.result?.oid ?? "";
                  request("descend", "descend", "left-2");
                } else if (message.requestId === "descend") {
                  window.clearTimeout(timeout);
                  values.descend = message.result?.oid ?? "";
                  resolve(values);
                }
              };
              channel.port1.start();
              new Function(source)();
              window.postMessage(
                {
                  protocol: "zeros-design-runtime",
                  version: 2,
                  type: "handshake",
                  sourceVersion: "d".repeat(24),
                },
                "*",
                [channel.port2],
              );
            },
          ),
        { source: DESIGN_RUNTIME_SOURCE },
      );

      expect(result).toEqual({ preserve: "right-3", descend: "right-3" });
    } finally {
      await browser.close();
    }
  }, 20_000);

  it("reports rotated geometry the axis-aligned rect cannot describe", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const result = await page.evaluate(
        ({ source }) =>
          new Promise<{
            boxes: Record<string, DesignRuntimeNodeBox | undefined>;
            rects: Record<string, DesignRuntimeRect | undefined>;
            truth: Record<string, Array<{ x: number; y: number }>>;
          }>((resolve, reject) => {
            const sourceVersion = "e".repeat(24);
            document.head.innerHTML = "<style>body { margin: 0 }</style>";
            document.body.innerHTML = `<main data-oid="root" style="position:relative;width:900px;height:900px">
                <div data-oid="plain" style="position:absolute;left:20px;top:20px;width:120px;height:60px;padding:5px;border:2px solid"></div>
                <div data-oid="turned" style="position:absolute;left:200px;top:20px;width:120px;height:60px;transform:rotate(30deg)"></div>
                <div data-oid="pivoted" style="position:absolute;left:400px;top:20px;width:120px;height:60px;transform:rotate(30deg);transform-origin:0 0"></div>
                <div data-oid="outer" style="position:absolute;left:100px;top:200px;width:300px;height:200px;transform:rotate(20deg)">
                  <div data-oid="inner" style="position:absolute;left:30px;top:15px;width:100px;height:50px;transform:rotate(25deg)"></div>
                </div>
                <div data-oid="skewed" style="position:absolute;left:500px;top:500px;width:120px;height:60px;transform:skewX(12deg)"></div>
                <div data-oid="scaled" style="position:absolute;left:700px;top:500px;width:120px;height:60px;transform:rotate(15deg) scale(2)"></div>
              </main>`;
            (
              window as Window & { __zerosDesignSourceVersion?: string }
            ).__zerosDesignSourceVersion = sourceVersion;
            // Ground truth: a zero-size absolutely positioned child maps to a
            // single point under its parent's transform chain, so four of them
            // report exactly where the corners are painted.
            const cornersOf = (oid: string) => {
              const element = document.querySelector(
                `[data-oid="${oid}"]`,
              ) as HTMLElement;
              return [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 1],
              ].map(([fx = 0, fy = 0]) => {
                const marker = document.createElement("i");
                marker.style.cssText = `position:absolute;width:0;height:0;margin:0;left:${fx * 100}%;top:${fy * 100}%`;
                element.appendChild(marker);
                const rect = marker.getBoundingClientRect();
                marker.remove();
                return { x: rect.left, y: rect.top };
              });
            };
            const boxes: Record<string, DesignRuntimeNodeBox | undefined> = {};
            const rects: Record<string, DesignRuntimeRect | undefined> = {};
            const channel = new MessageChannel();
            const timeout = window.setTimeout(
              () => reject(new Error("geometry requests timed out")),
              3_000,
            );
            const request = (requestId: string, scopeNodeId: string) =>
              channel.port1.postMessage({
                protocol: "zeros-design-runtime",
                version: 2,
                type: "request",
                sourceVersion,
                requestId,
                method: "getElementsInRect",
                args: { x: 0, y: 0, width: 5_000, height: 5_000, scopeNodeId },
              });
            channel.port1.onmessage = (event) => {
              const message = event.data as {
                type?: string;
                event?: string;
                requestId?: string;
                ok?: boolean;
                result?: DesignRuntimeNodeDetails[];
                error?: { message?: string };
              };
              if (message.type === "event" && message.event === "ready") {
                request("roots", "root");
                return;
              }
              if (message.type !== "response") return;
              if (!message.ok) {
                window.clearTimeout(timeout);
                reject(new Error(message.error?.message ?? "runtime failed"));
                return;
              }
              for (const details of message.result ?? []) {
                boxes[details.oid] = details.box;
                rects[details.oid] = details.rect;
              }
              if (message.requestId === "roots") {
                request("nested", "outer");
                return;
              }
              window.clearTimeout(timeout);
              resolve({
                boxes,
                rects,
                truth: {
                  turned: cornersOf("turned"),
                  inner: cornersOf("inner"),
                },
              });
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
        { source: DESIGN_RUNTIME_SOURCE },
      );

      // An untransformed element keeps the bounding box, resolved to its border
      // box even though the authored width is a content-box value.
      expect(result.boxes.plain).toMatchObject({
        x: 20,
        y: 20,
        width: 134,
        height: 74,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        originX: 0.5,
        originY: 0.5,
      });
      // The bounding box of a 30°-rotated 120×60 box grows to 133.9 × 112; the
      // box keeps the element's own size and reports the rotation instead.
      expect(result.rects.turned?.width).toBeCloseTo(133.923, 2);
      expect(result.rects.turned?.height).toBeCloseTo(111.962, 2);
      expect(result.boxes.turned).toMatchObject({ width: 120, height: 60 });
      expect(result.boxes.turned?.rotation).toBeCloseTo(30, 4);
      // Rotating about the top-left leaves that corner exactly where it was.
      expect(result.boxes.pivoted).toMatchObject({
        x: 400,
        y: 20,
        originX: 0,
        originY: 0,
      });
      // A layer inside a rotated container reports the rotation the user sees.
      expect(result.boxes.inner?.rotation).toBeCloseTo(45, 4);
      expect(result.boxes.inner).toMatchObject({ width: 100, height: 50 });
      // Skew paints a parallelogram, so the axis-aligned fallback is honest.
      expect(result.boxes.skewed).toMatchObject({
        x: result.rects.skewed?.x,
        rotation: 0,
        scaleX: 1,
      });
      // Scale stays out of the layout size a resize gesture has to write.
      expect(result.boxes.scaled).toMatchObject({ width: 120, height: 60 });
      expect(result.boxes.scaled?.scaleX).toBeCloseTo(2, 4);
      expect(result.boxes.scaled?.scaleY).toBeCloseTo(2, 4);

      for (const oid of ["turned", "inner"] as const) {
        const box = result.boxes[oid];
        if (!box) throw new Error(`missing box for ${oid}`);
        const radians = (box.rotation * Math.PI) / 180;
        const width = box.width * box.scaleX;
        const height = box.height * box.scaleY;
        const painted = [
          [0, 0],
          [width, 0],
          [width, height],
          [0, height],
        ].map(([x = 0, y = 0]) => ({
          x: box.x + x * Math.cos(radians) - y * Math.sin(radians),
          y: box.y + x * Math.sin(radians) + y * Math.cos(radians),
        }));
        result.truth[oid]?.forEach((corner, index) => {
          expect(painted[index]?.x).toBeCloseTo(corner.x, 2);
          expect(painted[index]?.y).toBeCloseTo(corner.y, 2);
        });
      }
    } finally {
      await browser.close();
    }
  }, 20_000);

  it("measures a gesture preview in the same task it applied it", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const result = await page.evaluate(
        ({ source }) =>
          new Promise<{
            order: string[];
            geometry: DesignRuntimeNodeGeometry;
            detailsStyleCount: number;
            geometryStyleKeys: string[];
            restoredWidth: number;
          }>((resolve, reject) => {
            const sourceVersion = "b".repeat(24);
            document.head.innerHTML = "<style>body { margin: 0 }</style>";
            document.body.innerHTML = `<main data-oid="root" style="position:absolute;left:0;top:0;width:600px;height:400px;display:flex;gap:12px;padding:8px 16px;transform:rotate(10deg)">
                <div data-oid="a" style="width:100px;height:50px"></div>
                <div data-oid="b" style="width:100px;height:50px"></div>
                <div style="width:10px;height:50px"></div>
                <div data-oid="hidden" style="display:none"></div>
              </main>`;
            (
              window as Window & { __zerosDesignSourceVersion?: string }
            ).__zerosDesignSourceVersion = sourceVersion;
            const order: string[] = [];
            let geometry: DesignRuntimeNodeGeometry | null = null;
            let detailsStyleCount = 0;
            const channel = new MessageChannel();
            const timeout = window.setTimeout(
              () => reject(new Error("gesture preview timed out")),
              3_000,
            );
            const send = (
              requestId: string,
              method: string,
              args: Record<string, unknown>,
            ) =>
              channel.port1.postMessage({
                protocol: "zeros-design-runtime",
                version: 2,
                type: "request",
                sourceVersion,
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
                result?: unknown;
                error?: { message?: string };
              };
              if (message.type === "event" && message.event === "ready") {
                // Both requests leave in one task. previewStyles waits for an
                // animation frame by contract; a gesture measurement must not,
                // so its answer has to come back first.
                send("geometry", "previewGeometry", {
                  nodeId: "root",
                  styles: { width: "500px", "padding-left": "40px" },
                  children: true,
                });
                send("details", "previewStyles", {
                  nodeId: "root",
                  styles: { height: "300px" },
                });
                return;
              }
              if (message.type !== "response") return;
              if (!message.ok) {
                window.clearTimeout(timeout);
                reject(new Error(message.error?.message ?? "runtime failed"));
                return;
              }
              order.push(message.requestId ?? "");
              if (message.requestId === "geometry") {
                geometry = message.result as DesignRuntimeNodeGeometry;
                return;
              }
              if (message.requestId === "details") {
                detailsStyleCount = Object.keys(
                  (message.result as DesignRuntimeNodeDetails).styles,
                ).length;
                send("cleared", "clearPreviewStyles", { nodeId: "root" });
                return;
              }
              if (message.requestId === "cleared") {
                // No styles at all: a settle measures without authoring.
                send("restored", "previewGeometry", { nodeId: "root" });
                return;
              }
              window.clearTimeout(timeout);
              if (!geometry) {
                reject(new Error("no geometry"));
                return;
              }
              resolve({
                order,
                geometry,
                detailsStyleCount,
                geometryStyleKeys: Object.keys(geometry.styles),
                restoredWidth: (message.result as DesignRuntimeNodeGeometry).box
                  .width,
              });
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
        { source: DESIGN_RUNTIME_SOURCE },
      );

      // The whole point: no animation frame between the write and the answer.
      expect(result.order[0]).toBe("geometry");
      expect(result.order[1]).toBe("details");
      // The measurement reflects the styles this very call applied: a
      // content-box element grows its border box by the new padding too.
      expect(result.geometry.box.width).toBe(500 + 40 + 16);
      expect(result.geometry.box.rotation).toBeCloseTo(10, 4);
      expect(result.geometry.styles.paddingLeft).toBe("40px");
      expect(result.geometry.styles.display).toBe("flex");
      expect(result.geometry.styles.columnGap).toBe("12px");
      // Only children the canvas can draw a gap handle between: an oid, real
      // pixels, and its own position — never the inspector's whole catalog.
      expect(result.geometry.children.map((child) => child.oid)).toEqual([
        "a",
        "b",
      ]);
      expect(result.geometry.children[0]?.rect.x).toBeGreaterThan(0);
      expect(Object.keys(result.geometry.children[0]?.styles ?? {})).toEqual([
        "position",
      ]);
      // A gesture frame carries a fraction of the inspector payload.
      expect(result.geometryStyleKeys.length).toBeLessThan(20);
      expect(result.detailsStyleCount).toBeGreaterThan(100);
      // And it shares previewStyles' bookkeeping, so one clear restores both
      // the width this call authored and the height the other one did.
      expect(result.restoredWidth).toBe(600 + 16 + 16);
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

  it("rerasterizes a tiny logical viewport crop at its requested screen resolution", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const capture = await page.evaluate(
        async ({ source }) => {
          document.documentElement.style.margin = "0";
          document.body.style.margin = "0";
          document.body.innerHTML =
            '<main data-oid="frame" style="position:relative;width:1000px;height:700px;background:white">' +
            '<div style="position:absolute;left:502px;top:352px;width:2px;height:2px;background:#111"></div>' +
            "</main>";
          (
            window as Window & { __zerosDesignSourceVersion?: string }
          ).__zerosDesignSourceVersion = "b".repeat(24);
          const requestId = "capture-viewport-tile";
          const channel = new MessageChannel();
          const response = new Promise<{
            dataUrl: string;
            width: number;
            height: number;
            scale: number;
          }>((resolve, reject) => {
            const timeout = window.setTimeout(
              () => reject(new Error("viewport capture timed out")),
              5_000,
            );
            channel.port1.onmessage = (event) => {
              const message = event.data as {
                type?: string;
                requestId?: string;
                ok?: boolean;
                result?: {
                  dataUrl: string;
                  width: number;
                  height: number;
                  scale: number;
                };
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
          });
          new Function(source)();
          channel.port1.start();
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
          channel.port1.postMessage({
            protocol: "zeros-design-runtime",
            version: 2,
            type: "request",
            sourceVersion: "b".repeat(24),
            requestId,
            method: "captureScreenshot",
            args: {
              crop: { x: 500, y: 350, width: 4, height: 4 },
              outputSize: { width: 600, height: 600 },
            },
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
            ...screenshot,
            light: Array.from(context.getImageData(40, 40, 1, 1).data),
            dark: Array.from(context.getImageData(560, 560, 1, 1).data),
          };
        },
        { source: DESIGN_RUNTIME_SOURCE },
      );

      expect(capture.width).toBe(600);
      expect(capture.height).toBe(600);
      expect(capture.scale).toBeCloseTo(150);
      expect(capture.light.slice(0, 3)).toEqual([255, 255, 255]);
      expect(capture.dark.slice(0, 3)).toEqual([17, 17, 17]);
    } finally {
      await browser.close();
    }
  }, 20_000);
});
