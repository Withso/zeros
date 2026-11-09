// @vitest-environment jsdom

import { act, createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useDesignGpuAvailable, useDesignGpuCanvas } from "../gpu/design-gpu-canvas";
import { createDesignGpuRuntime, type DesignGpuRuntime } from "../gpu/design-gpu-runtime";
import type { DesignRecordingsSource } from "../gpu/design-recordings";

const source: DesignRecordingsSource = { read: () => new Promise(() => {}), render: () => new Promise(() => {}) };
type InstrumentedWindow = Window & { __zerosDesignGpu?: { snapshot(): Promise<{ error: string | null }> } };

function Canvas({ runtime, renders }: { runtime: DesignGpuRuntime; renders: boolean[] }) {
  const worldRef = useRef<HTMLDivElement | null>(null);
  const enabled = useDesignGpuAvailable(runtime);
  renders.push(enabled);
  useDesignGpuCanvas({ enabled, active: true, worldRef, documentOwner: "page-1", runtime,
    owner: { workspaceId: "/work/a", directoryId: "design_a", theme: null, colorScheme: "light" }, openKey: "page-1\0", frames: [], live: new Set() });
  return createElement("div", null, createElement("div", { ref: worldRef }));
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe("Design GPU canvas fallback", () => {
  it("shows pictures for the rest of the session when WebGL2 is unavailable, instead of covering frames nothing paints", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const workers: unknown[] = [];
    const runtime = createDesignGpuRuntime(source, () => { workers.push(new EventTarget()); return workers.at(-1) as Worker; });
    const renders: boolean[] = [];
    await act(async () => root.render(createElement(Canvas, { runtime, renders })));
    expect(runtime.unavailable).toBe("WebGL2 is unavailable to the recorded Design canvas.");
    // The canvas renders again with the recorded canvas off, so its bitmap
    // path covers every frame; nothing of the plane or worker remains.
    expect(renders).toEqual([true, false]);
    expect(host.querySelector("[data-design-gpu-plane]")).toBeNull();
    expect(workers).toHaveLength(0);
    expect((await (window as InstrumentedWindow).__zerosDesignGpu!.snapshot()).error).toBe(runtime.unavailable);
  });
});
