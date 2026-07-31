import { describe, expect, it, vi } from "vitest";

import {
  DESIGN_RUNTIME_PROTOCOL,
  DESIGN_RUNTIME_VERSION,
  type DesignRuntimeSnapshot,
} from "@zeros/core/design-runtime";

import { connectDesignFrameRuntime } from "../design-frame-runtime";

function snapshot(revision: number): DesignRuntimeSnapshot {
  return {
    sourceVersion: "111111111111111111111111",
    revision,
    tree: [],
    warnings: [],
    frame: {
      sourceVersion: "111111111111111111111111",
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
    const listenerRef: {
      current: ((event: MessageEvent) => void) | null;
    } = { current: null };
    const source = { postMessage: vi.fn() };
    const host = {
      addEventListener: vi.fn(
        (_type: "message", next: (event: MessageEvent) => void) => {
          listenerRef.current = next;
        },
      ),
      removeEventListener: vi.fn(),
      setTimeout: vi.fn(() => 7),
      clearTimeout: vi.fn(),
    };
    const onSnapshot = vi.fn();
    const connection = connectDesignFrameRuntime(
      "workspace-a",
      "home.html",
      { contentWindow: source } as unknown as HTMLIFrameElement,
      { onSnapshot },
      host,
    );

    const pending = connection.getSnapshot();
    const request = source.postMessage.mock.calls[0]?.[0] as {
      requestId: string;
    };
    listenerRef.current?.({
      source: {},
      data: {
        protocol: DESIGN_RUNTIME_PROTOCOL,
        version: DESIGN_RUNTIME_VERSION,
        type: "response",
        requestId: request.requestId,
        ok: true,
        result: snapshot(1),
      },
    } as unknown as MessageEvent);
    expect(source.postMessage).toHaveBeenCalledTimes(1);

    listenerRef.current?.({
      source,
      data: {
        protocol: DESIGN_RUNTIME_PROTOCOL,
        version: DESIGN_RUNTIME_VERSION,
        type: "response",
        requestId: request.requestId,
        ok: true,
        result: snapshot(2),
      },
    } as unknown as MessageEvent);
    await expect(pending).resolves.toMatchObject({ revision: 2 });

    const preview = connection.previewStyles("frame", {
      "background-color": "var(--bg1)",
    });
    const previewRequest = source.postMessage.mock.calls[1]?.[0] as {
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
    listenerRef.current?.({
      source,
      data: {
        protocol: DESIGN_RUNTIME_PROTOCOL,
        version: DESIGN_RUNTIME_VERSION,
        type: "response",
        requestId: previewRequest.requestId,
        ok: true,
        result: snapshot(2).frame,
      },
    } as unknown as MessageEvent);
    await expect(preview).resolves.toMatchObject({ oid: "frame" });

    listenerRef.current?.({
      source,
      data: {
        protocol: DESIGN_RUNTIME_PROTOCOL,
        version: DESIGN_RUNTIME_VERSION,
        type: "event",
        event: "mutation",
        payload: snapshot(3),
      },
    } as unknown as MessageEvent);
    expect(onSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 3 }),
      "mutation",
    );

    connection.destroy();
    expect(host.removeEventListener).toHaveBeenCalledOnce();
  });
});
