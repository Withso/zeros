import { describe, expect, it, vi } from "vitest";

import {
  DESIGN_RUNTIME_PROTOCOL,
  DESIGN_RUNTIME_VERSION,
  type DesignRuntimeSnapshot,
} from "@zeros/protocol/design-runtime";

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
    const source = { postMessage: vi.fn() };
    const host = {
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
    const handshake = source.postMessage.mock.calls[0];
    expect(handshake?.[0]).toEqual({
      protocol: DESIGN_RUNTIME_PROTOCOL,
      version: DESIGN_RUNTIME_VERSION,
      type: "handshake",
    });
    expect(handshake?.[1]).toMatchObject({ targetOrigin: "*" });
    const framePort = handshake?.[1]?.transfer?.[0] as MessagePort;
    const requests: Array<Record<string, unknown>> = [];
    framePort.onmessage = (event) => {
      requests.push(event.data as Record<string, unknown>);
    };
    framePort.start();

    const pending = connection.getSnapshot();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    const request = requests[0] as {
      requestId: string;
    };
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

    const preview = connection.previewStyles("frame", {
      "background-color": "var(--bg1)",
    });
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    const previewRequest = requests[1] as {
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
    framePort.close();
  });
});
