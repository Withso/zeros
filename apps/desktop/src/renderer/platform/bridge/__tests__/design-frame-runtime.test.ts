import { describe, expect, it, vi } from "vitest";

import {
  DESIGN_RUNTIME_PROTOCOL,
  DESIGN_RUNTIME_VERSION,
  type DesignRuntimeSnapshot,
} from "@zeros/protocol/design-runtime";

import {
  connectDesignFrameRuntime,
  DesignFrameRuntimeError,
} from "../design-frame-runtime";

const SOURCE_VERSION = "111111111111111111111111";
const NEXT_SOURCE_VERSION = "222222222222222222222222";

const capabilities = {
  methods: [
    "getSnapshot",
    "getElementAtLoc",
    "getElementsInRect",
    "getNodeDetails",
    "getMatchedStyles",
    "setNodeVisibility",
    "setTheme",
    "previewStyles",
    "commitStyles",
    "previewText",
    "clearPreviewText",
    "previewMotion",
    "clearPreviewStyles",
    "captureScreenshot",
  ] as const,
  cancellation: true as const,
  typedErrors: true as const,
  sourcePinned: true as const,
  maxStyleProperties: 64,
  maxMatchedDeclarations: 256,
  maxCapturePixels: 2_000_000,
};

function snapshot(
  revision: number,
  sourceVersion = SOURCE_VERSION,
): DesignRuntimeSnapshot {
  return {
    sourceVersion,
    revision,
    tree: [],
    warnings: [],
    frame: {
      sourceVersion,
      oid: "frame",
      tag: "main",
      name: "Frame",
      text: null,
      selector: '[data-oid="frame"]',
      visible: true,
      breadcrumb: ["main · Frame"],
      rect: { x: 0, y: 0, width: 100, height: 80 },
      styles: {},
    },
    viewport: { width: 100, height: 80, scrollX: 0, scrollY: 0 },
  };
}

describe("design frame runtime client", () => {
  it("routes exact-source responses and versioned snapshot events", async () => {
    const source = { postMessage: vi.fn() };
    const host = {
      setTimeout: vi.fn(() => 7),
      clearTimeout: vi.fn(),
    };
    const onSnapshot = vi.fn();
    const onReady = vi.fn();
    const connection = connectDesignFrameRuntime(
      "workspace-a",
      "home.html",
      SOURCE_VERSION,
      { contentWindow: source } as unknown as HTMLIFrameElement,
      { onSnapshot, onReady },
      host,
    );
    const handshake = source.postMessage.mock.calls[0];
    expect(handshake?.[0]).toEqual({
      protocol: DESIGN_RUNTIME_PROTOCOL,
      version: DESIGN_RUNTIME_VERSION,
      type: "handshake",
      sourceVersion: SOURCE_VERSION,
    });
    expect(handshake?.[1]).toMatchObject({ targetOrigin: "*" });
    const framePort = handshake?.[1]?.transfer?.[0] as MessagePort;
    const requests: Array<Record<string, unknown>> = [];
    framePort.onmessage = (event) => {
      requests.push(event.data as Record<string, unknown>);
    };
    framePort.start();

    framePort.postMessage({
      protocol: DESIGN_RUNTIME_PROTOCOL,
      version: DESIGN_RUNTIME_VERSION,
      type: "event",
      event: "ready",
      payload: {
        sourceVersion: SOURCE_VERSION,
        capabilities,
        snapshot: snapshot(1),
      },
    });
    await vi.waitFor(() => {
      expect(onReady).toHaveBeenCalledWith(capabilities);
      expect(onSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({ revision: 1 }),
        "ready",
      );
    });

    const pending = connection.getSnapshot();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    const request = requests[0] as {
      requestId: string;
    };
    expect(requests[0]).toMatchObject({ sourceVersion: SOURCE_VERSION });
    framePort.postMessage({
      protocol: DESIGN_RUNTIME_PROTOCOL,
      version: DESIGN_RUNTIME_VERSION,
      type: "response",
      requestId: request.requestId,
      ok: true,
      result: snapshot(2),
    });
    expect(source.postMessage).toHaveBeenCalledTimes(1);
    await expect(pending).resolves.toMatchObject({ revision: 2 });

    const theme = connection.setTheme("dark");
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    const themeRequest = requests[1] as { requestId: string };
    expect(themeRequest).toMatchObject({
      method: "setTheme",
      args: { theme: "dark" },
    });
    framePort.postMessage({
      protocol: DESIGN_RUNTIME_PROTOCOL,
      version: DESIGN_RUNTIME_VERSION,
      type: "response",
      requestId: themeRequest.requestId,
      ok: true,
      result: snapshot(2),
    });
    await expect(theme).resolves.toMatchObject({ revision: 2 });

    const preview = connection.previewStyles("frame", {
      "background-color": "var(--bg1)",
    });
    await vi.waitFor(() => expect(requests).toHaveLength(3));
    const previewRequest = requests[2] as {
      requestId: string;
      method: string;
      args: Record<string, unknown>;
    };
    expect(previewRequest).toMatchObject({
      method: "previewStyles",
      args: {
        nodeId: "frame",
        styles: { "background-color": "var(--bg1)" },
      },
    });
    framePort.postMessage({
      protocol: DESIGN_RUNTIME_PROTOCOL,
      version: DESIGN_RUNTIME_VERSION,
      type: "response",
      requestId: previewRequest.requestId,
      ok: true,
      result: snapshot(2).frame,
    });
    await expect(preview).resolves.toMatchObject({ oid: "frame" });

    const textPreview = connection.previewText("frame", "Live copy");
    await vi.waitFor(() => expect(requests).toHaveLength(4));
    const textPreviewRequest = requests[3] as { requestId: string };
    expect(textPreviewRequest).toMatchObject({
      method: "previewText",
      args: { nodeId: "frame", text: "Live copy" },
    });
    framePort.postMessage({
      protocol: DESIGN_RUNTIME_PROTOCOL,
      version: DESIGN_RUNTIME_VERSION,
      type: "response",
      requestId: textPreviewRequest.requestId,
      ok: true,
      result: snapshot(2).frame,
    });
    await expect(textPreview).resolves.toMatchObject({ oid: "frame" });

    const clearTextPreview = connection.clearPreviewText("frame");
    await vi.waitFor(() => expect(requests).toHaveLength(5));
    const clearTextRequest = requests[4] as { requestId: string };
    expect(clearTextRequest).toMatchObject({
      method: "clearPreviewText",
      args: { nodeId: "frame" },
    });
    framePort.postMessage({
      protocol: DESIGN_RUNTIME_PROTOCOL,
      version: DESIGN_RUNTIME_VERSION,
      type: "response",
      requestId: clearTextRequest.requestId,
      ok: true,
      result: snapshot(2).frame,
    });
    await expect(clearTextPreview).resolves.toMatchObject({ oid: "frame" });

    const motion = connection.previewMotion("frame", {
      keyframes: [
        { offset: 0, styles: { opacity: "0" } },
        { offset: 100, styles: { opacity: "1" } },
      ],
      duration: 300,
      delay: 0,
      easing: "ease-out",
      iterations: 1,
      direction: "normal",
      fill: "both",
      currentTime: 150,
      playing: false,
    });
    await vi.waitFor(() => expect(requests).toHaveLength(6));
    const motionRequest = requests[5] as { requestId: string };
    expect(motionRequest).toMatchObject({
      method: "previewMotion",
      args: {
        nodeId: "frame",
        duration: 300,
        currentTime: 150,
        playing: false,
      },
    });
    framePort.postMessage({
      protocol: DESIGN_RUNTIME_PROTOCOL,
      version: DESIGN_RUNTIME_VERSION,
      type: "response",
      requestId: motionRequest.requestId,
      ok: true,
      result: snapshot(2).frame,
    });
    await expect(motion).resolves.toMatchObject({ oid: "frame" });

    framePort.postMessage({
      protocol: DESIGN_RUNTIME_PROTOCOL,
      version: DESIGN_RUNTIME_VERSION,
      type: "event",
      event: "mutation",
      payload: snapshot(3),
    });
    await vi.waitFor(() =>
      expect(onSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({ revision: 3 }),
        "mutation",
      ),
    );

    connection.destroy();
    await vi.waitFor(() =>
      expect(requests.at(-1)).toMatchObject({
        type: "teardown",
        sourceVersion: SOURCE_VERSION,
      }),
    );
    framePort.close();
  });

  it("atomically adopts a committed style generation on the existing channel", async () => {
    const source = { postMessage: vi.fn() };
    const host = {
      setTimeout: vi.fn(() => 11),
      clearTimeout: vi.fn(),
    };
    const connection = connectDesignFrameRuntime(
      "workspace-a",
      "adopt.html",
      SOURCE_VERSION,
      { contentWindow: source } as unknown as HTMLIFrameElement,
      {},
      host,
    );
    const framePort = source.postMessage.mock.calls[0]?.[1]
      ?.transfer?.[0] as MessagePort;
    const requests: Array<Record<string, unknown>> = [];
    framePort.onmessage = (event) => {
      requests.push(event.data as Record<string, unknown>);
    };
    framePort.start();

    expect(connection.sourceVersion).toBe(SOURCE_VERSION);
    const adopting = connection.commitStyles(
      [{ nodeId: "frame", styles: { width: "240px" } }],
      NEXT_SOURCE_VERSION,
      {
        keyframes: [
          {
            name: "frame-enter",
            keyframes: [
              { offset: 0, styles: { opacity: "0" } },
              { offset: 100, styles: { opacity: "1" } },
            ],
          },
        ],
      },
    );
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({
      method: "commitStyles",
      sourceVersion: SOURCE_VERSION,
      args: {
        nextSourceVersion: NEXT_SOURCE_VERSION,
        updates: [{ nodeId: "frame", styles: { width: "240px" } }],
        patch: {
          keyframes: [
            {
              name: "frame-enter",
              keyframes: [
                { offset: 0, styles: { opacity: "0" } },
                { offset: 100, styles: { opacity: "1" } },
              ],
            },
          ],
        },
      },
    });
    framePort.postMessage({
      protocol: DESIGN_RUNTIME_PROTOCOL,
      version: DESIGN_RUNTIME_VERSION,
      type: "response",
      requestId: requests[0]?.requestId,
      ok: true,
      result: {
        sourceVersion: NEXT_SOURCE_VERSION,
        treeUnchanged: true,
        snapshot: snapshot(2, NEXT_SOURCE_VERSION),
        details: [snapshot(2, NEXT_SOURCE_VERSION).frame],
      },
    });

    await expect(adopting).resolves.toMatchObject({
      sourceVersion: NEXT_SOURCE_VERSION,
      treeUnchanged: true,
      snapshot: { sourceVersion: NEXT_SOURCE_VERSION },
      details: [{ sourceVersion: NEXT_SOURCE_VERSION, oid: "frame" }],
    });
    expect(connection.sourceVersion).toBe(NEXT_SOURCE_VERSION);

    const refreshed = connection.getSnapshot();
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]).toMatchObject({ sourceVersion: NEXT_SOURCE_VERSION });
    framePort.postMessage({
      protocol: DESIGN_RUNTIME_PROTOCOL,
      version: DESIGN_RUNTIME_VERSION,
      type: "response",
      requestId: requests[1]?.requestId,
      ok: true,
      result: snapshot(3, NEXT_SOURCE_VERSION),
    });
    await expect(refreshed).resolves.toMatchObject({ revision: 3 });

    connection.destroy();
    await vi.waitFor(() =>
      expect(requests.at(-1)).toMatchObject({
        type: "teardown",
        sourceVersion: NEXT_SOURCE_VERSION,
      }),
    );
    framePort.close();
  });

  it("accepts a token-only generation without manufacturing node details", async () => {
    const source = { postMessage: vi.fn() };
    const host = {
      setTimeout: vi.fn(() => 11),
      clearTimeout: vi.fn(),
    };
    const connection = connectDesignFrameRuntime(
      "workspace-a",
      "tokens.html",
      SOURCE_VERSION,
      { contentWindow: source } as unknown as HTMLIFrameElement,
      {},
      host,
    );
    const framePort = source.postMessage.mock.calls[0]?.[1]
      ?.transfer?.[0] as MessagePort;
    const requests: Array<Record<string, unknown>> = [];
    framePort.onmessage = (event) => {
      requests.push(event.data as Record<string, unknown>);
    };
    framePort.start();

    const adopting = connection.commitStyles([], NEXT_SOURCE_VERSION, {
      tokens: [{ name: "--accent", theme: "dark", value: "orchid" }],
    });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    framePort.postMessage({
      protocol: DESIGN_RUNTIME_PROTOCOL,
      version: DESIGN_RUNTIME_VERSION,
      type: "response",
      requestId: requests[0]?.requestId,
      ok: true,
      result: {
        sourceVersion: NEXT_SOURCE_VERSION,
        treeUnchanged: true,
        snapshot: snapshot(2, NEXT_SOURCE_VERSION),
        details: [],
      },
    });

    await expect(adopting).resolves.toMatchObject({
      sourceVersion: NEXT_SOURCE_VERSION,
      details: [],
    });
    expect(connection.sourceVersion).toBe(NEXT_SOURCE_VERSION);

    connection.destroy();
    framePort.close();
  });

  it("requests an exact viewport crop without persisting a frame-wide bitmap", async () => {
    const source = { postMessage: vi.fn() };
    const host = {
      setTimeout: vi.fn(() => 13),
      clearTimeout: vi.fn(),
    };
    const connection = connectDesignFrameRuntime(
      "workspace-a",
      "home.html",
      SOURCE_VERSION,
      { contentWindow: source } as unknown as HTMLIFrameElement,
      {},
      host,
    );
    const framePort = source.postMessage.mock.calls[0]?.[1]
      ?.transfer?.[0] as MessagePort;
    const requests: Array<Record<string, unknown>> = [];
    framePort.onmessage = (event) => {
      requests.push(event.data as Record<string, unknown>);
    };
    framePort.start();

    const capture = connection.captureViewportScreenshot(
      { x: 505, y: 351, width: 2.5, height: 3 },
      { width: 1_280, height: 1_536 },
    );
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({
      method: "captureScreenshot",
      args: {
        crop: { x: 505, y: 351, width: 2.5, height: 3 },
        outputSize: { width: 1_280, height: 1_536 },
      },
    });
    framePort.postMessage({
      protocol: DESIGN_RUNTIME_PROTOCOL,
      version: DESIGN_RUNTIME_VERSION,
      type: "response",
      requestId: requests[0]?.requestId,
      ok: true,
      result: {
        sourceVersion: SOURCE_VERSION,
        dataUrl: "data:image/png;base64,AA==",
        mimeType: "image/png",
        width: 1_280,
        height: 1_536,
        scale: 512,
        nodeId: null,
      },
    });
    await expect(capture).resolves.toMatchObject({
      width: 1_280,
      height: 1_536,
      scale: 512,
    });

    connection.destroy();
    framePort.close();
  });

  it("cancels an abandoned request and preserves typed runtime errors", async () => {
    const source = { postMessage: vi.fn() };
    const host = {
      setTimeout: vi.fn(() => 9),
      clearTimeout: vi.fn(),
    };
    const connection = connectDesignFrameRuntime(
      "workspace-a",
      "cancel.html",
      SOURCE_VERSION,
      { contentWindow: source } as unknown as HTMLIFrameElement,
      {},
      host,
    );
    const framePort = source.postMessage.mock.calls[0]?.[1]
      ?.transfer?.[0] as MessagePort;
    const messages: Array<Record<string, unknown>> = [];
    framePort.onmessage = (event) => {
      messages.push(event.data as Record<string, unknown>);
    };
    framePort.start();

    const controller = new AbortController();
    const cancelled = connection.getSnapshot(controller.signal);
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: "CANCELLED" });
    await vi.waitFor(() =>
      expect(messages[1]).toMatchObject({
        type: "cancel",
        requestId: messages[0]?.requestId,
        sourceVersion: SOURCE_VERSION,
      }),
    );

    const failed = connection.getNodeDetails("missing");
    await vi.waitFor(() => expect(messages).toHaveLength(3));
    framePort.postMessage({
      protocol: DESIGN_RUNTIME_PROTOCOL,
      version: DESIGN_RUNTIME_VERSION,
      type: "response",
      requestId: messages[2]?.requestId,
      ok: false,
      error: {
        code: "NODE_NOT_FOUND",
        message: "Element not found: missing",
        retryable: false,
      },
    });
    await expect(failed).rejects.toEqual(
      expect.objectContaining({
        name: "DesignFrameRuntimeError",
        code: "NODE_NOT_FOUND",
        retryable: false,
      }),
    );
    await expect(failed).rejects.toBeInstanceOf(DesignFrameRuntimeError);
    connection.destroy();
    framePort.close();
  });
});
