// Development-only fixture for the recorded GPU Design canvas: the real
// scene, CanvasKit worker, chunk cache and compositor draw a page of frames
// recorded in this page with CanvasKit, under a minimal canvas world.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import "../features/design-workspace/design-workspace-ui.css";
import React, { useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { externalizeDesignPictureTypefaces } from "../../../shared/design-picture-typefaces";
import { paintDesignCanvasCamera } from "../features/design-workspace/design-canvas-camera";
import type { DesignViewport } from "../features/design-workspace/design-canvas-math";
import CanvasKitInit from "../features/design-workspace/gpu/canvaskit/canvaskit.js";
import wasmUrl from "../features/design-workspace/gpu/canvaskit/canvaskit.wasm?url";
import geistUrl from "@fontsource-variable/geist/files/geist-latin-wght-normal.woff2?url";
import { useDesignGpuAvailable, useDesignGpuCanvas } from "../features/design-workspace/gpu/design-gpu-canvas";
import { createDesignGpuRuntime } from "../features/design-workspace/gpu/design-gpu-runtime";
import type { DesignGpuSceneFrame } from "../features/design-workspace/gpu/design-gpu-scene";
import type { DesignRecordingsSource } from "../features/design-workspace/gpu/design-recordings";
import type { DesignRecording, DesignRecordingTypeface, DesignRecordingsReadReply,
  DesignRecordingsReply } from "../features/design-workspace/gpu/design-recordings-wire";

const params = new URLSearchParams(location.search);
const enabled = params.get("enabled") !== "0";
// The smoke page is 6 × 4 frames; `?frames=1000&columns=40` is a bench-sized page.
const COUNT = Math.min(2_000, Math.max(1, Number(params.get("frames")) || 24));
const COLUMNS = Math.max(1, Number(params.get("columns")) || 6);
/** `?unreadable=<index>`: that frame's recording is bytes CanvasKit can't read. */
const UNREADABLE = params.has("unreadable") ? Number(params.get("unreadable")) : -1;
const WIDTH = 320, HEIGHT = 200, GAP = 40, SCALE = 2;
const CHUNK_BYTES = 16 * 1024;
const VIEWPORT = { width: 1040, height: 520 };

/** Each frame's fill is distinct; the smoke reads it back from screen pixels. */
export const designGpuHarnessFill = (index: number): [number, number, number] =>
  [40 + (index * 37) % 180, 60 + (index * 53) % 160, 90 + (index * 71) % 150];

/** XMLHttpRequest, unlike fetch, also reads file:// in a packaged build. */
function load(url: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("GET", url);
    request.responseType = "arraybuffer";
    request.onload = () => request.response ? resolve(new Uint8Array(request.response as ArrayBuffer)) : reject(new Error(url));
    request.onerror = () => reject(new Error(url));
    request.send();
  });
}

async function sha(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  return Array.from(digest.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
};

interface Store { recordings: Map<string, DesignRecording>; typefaces: Map<string, DesignRecordingTypeface>; chunks: Map<string, string> }

async function chunked(bytes: Uint8Array, store: Store): Promise<string[]> {
  const ids: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
    const part = bytes.subarray(offset, offset + CHUNK_BYTES);
    const id = await sha(part);
    store.chunks.set(id, toBase64(part));
    ids.push(id);
  }
  return ids;
}

async function recordPage(frames: readonly DesignGpuSceneFrame[]): Promise<Store> {
  const ck = await CanvasKitInit({ locateFile: () => wasmUrl });
  const font = await load(geistUrl);
  const manager = ck.FontMgr.FromData(font.slice().buffer)!;
  const typeface = manager.matchFamilyStyle(manager.getFamilyName(0), {})!;
  const store: Store = { recordings: new Map(), typefaces: new Map(), chunks: new Map() };
  for (const [index, frame] of frames.entries()) {
    const recorder = new ck.PictureRecorder();
    const canvas = recorder.beginRecording(ck.LTRBRect(0, 0, frame.width * SCALE, frame.height * SCALE));
    const paint = new ck.Paint();
    paint.setAntiAlias(true);
    const [r, g, b] = designGpuHarnessFill(index);
    paint.setColor(ck.Color(r, g, b, 1));
    canvas.drawRect(ck.LTRBRect(0, 0, frame.width * SCALE, frame.height * SCALE), paint);
    paint.setColor(ck.Color(250, 250, 250, 1));
    canvas.drawRect(ck.LTRBRect(40 * SCALE, 120 * SCALE, 280 * SCALE, 170 * SCALE), paint);
    paint.setColor(ck.Color(20, 20, 20, 1));
    const label = new ck.Font(typeface, 28 * SCALE);
    canvas.drawText(`Frame ${index + 1}`, 24 * SCALE, 64 * SCALE, paint, label);
    const picture = recorder.finishRecordingAsPicture();
    const skp = picture.serialize()!;
    picture.delete(); label.delete(); paint.delete(); recorder.delete();
    const external = await externalizeDesignPictureTypefaces(skp);
    const layer = index === UNREADABLE ? new TextEncoder().encode(`not a Skia picture: frame ${index + 1} `.repeat(32)) : external.skp;
    for (const { id, bytes } of external.typefaces)
      if (!store.typefaces.has(id)) store.typefaces.set(id, { id, bytes: bytes.length, chunks: await chunked(bytes, store) });
    store.recordings.set(frame.file, { file: frame.file, sourceVersion: frame.sourceVersion!, width: frame.width, height: frame.height,
      scale: SCALE, layers: [{ x: 0, y: 0, width: frame.width * SCALE, height: frame.height * SCALE, bytes: layer.length,
        chunks: await chunked(layer, store), typefaces: external.typefaces.map((entry) => entry.id) }] });
  }
  manager.delete();
  return store;
}

const frames: DesignGpuSceneFrame[] = Array.from({ length: COUNT }, (_, index) => ({
  file: `page-1/frame-${index + 1}.html`, sourceVersion: (index + 1).toString(16).padStart(24, "0"),
  x: (index % COLUMNS) * (WIDTH + GAP), y: Math.floor(index / COLUMNS) * (HEIGHT + GAP), width: WIDTH, height: HEIGHT,
}));

/** `at` is epoch ms, comparable with the bench snapshot's `openedAt`. */
const requests: Array<{ op: string; theme: string | null; frames: number; known: number; chunks: number; aborted: boolean; at: number }> = [];
const epoch = () => performance.timeOrigin + performance.now();
let store: Promise<Store> | null = null;
function reply(frames: ReadonlyArray<{ file: string }>, known: readonly string[]) {
  return store!.then((recorded) => {
    const recordings = frames.map((frame) => recorded.recordings.get(frame.file)!).filter(Boolean);
    const typefaceIds = [...new Set(recordings.flatMap((recording) => recording.layers.flatMap((layer) => layer.typefaces)))];
    const typefaces = typefaceIds.map((id) => recorded.typefaces.get(id)!);
    const ids = [...new Set([...recordings.flatMap((recording) => recording.layers.flatMap((layer) => layer.chunks)),
      ...typefaces.flatMap((typeface) => typeface.chunks)])].filter((id) => !known.includes(id));
    return { recordings, typefaces, chunks: ids.map((id) => ({ id, data: recorded.chunks.get(id)! })) };
  });
}
/** The "held" theme's renders never answer: only an abort ends them. */
const HELD_THEME = "held";
const source: DesignRecordingsSource = {
  async read(owner, asked, known) {
    requests.push({ op: "read", theme: owner.theme, frames: asked.length, known: known.length, chunks: 0, aborted: false, at: epoch() });
    // A first open: nothing is stored yet.
    return { recordings: [], typefaces: [], chunks: [], missing: asked.map((frame) => frame.file), deferred: [] } satisfies DesignRecordingsReadReply;
  },
  async render(owner, asked, known, signal) {
    const entry = { op: "render", theme: owner.theme, frames: asked.length, known: known.length, chunks: 0, aborted: false, at: epoch() };
    requests.push(entry);
    if (owner.theme === HELD_THEME) {
      await new Promise((_resolve, reject) => signal.addEventListener("abort", () => { entry.aborted = true; reject(signal.reason); }, { once: true }));
    }
    const { recordings, typefaces, chunks } = await reply(asked, known);
    entry.chunks = chunks.length;
    return { pipeline: "harness-1", recordings, typefaces, chunks, stale: [], failed: [], deferred: [] } satisfies DesignRecordingsReply;
  },
};
const runtime = createDesignGpuRuntime(source, () => new Worker(
  new URL("../features/design-workspace/gpu/design-gpu-raster.worker.ts", import.meta.url), { type: "module" }));

declare global {
  interface Window {
    designGpuHarness: {
      frames: readonly DesignGpuSceneFrame[];
      requests: typeof requests;
      setView(view: DesignViewport): void;
      /** Shows a frame with the canvas's selection stroke, or none. */
      select(index: number | null): void;
      setTheme(theme: string | null): void;
      fill: typeof designGpuHarnessFill;
      /** Files of the shown theme whose recordings failed, here or in the engine. */
      failed(): string[];
    };
  }
}

function Harness() {
  const worldRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState<DesignViewport>({ zoom: 0.5, panX: 20, panY: 20 });
  const [selected, select] = useState<number | null>(null);
  const [theme, setTheme] = useState<string | null>(null);
  // The canvas's mount order: the recorded canvas mounts first, the camera
  // paints next, and the viewport size is measured last (it starts at 0 × 0).
  const [size, setSize] = useState({ width: 0, height: 0 });
  const owner = useMemo(() => ({ workspaceId: "/harness/workspace", directoryId: "design_harness", theme }), [theme]);
  window.designGpuHarness = { frames, requests, setView, select, setTheme, fill: designGpuHarnessFill,
    failed: () => [...runtime.recordings.failedFiles(owner)].sort() };
  const live = useMemo(() => new Set<string>(), []);
  const available = useDesignGpuAvailable(runtime);
  useDesignGpuCanvas({ enabled: enabled && available, active: true, worldRef, documentOwner: "harness", owner,
    openKey: "harness:page-1", frames, live, runtime });
  useLayoutEffect(() => { paintDesignCanvasCamera(worldRef.current, view, false, size); }, [size, view, selected]);
  useLayoutEffect(() => { setSize(VIEWPORT); }, []);
  return (
    <div data-design-canvas-viewport="" className="bg-bg2 relative overflow-clip" style={{ width: VIEWPORT.width, height: VIEWPORT.height }}>
      <div className="pointer-events-none absolute inset-0 isolate">
        <div ref={worldRef} data-design-canvas-world="" className="pointer-events-none absolute inset-0 origin-top-left">
          {frames.map((frame, index) => (
            <article key={frame.file} data-design-frame={frame.file} data-design-frame-controls="automatic"
              className={`zd-design-frame zd-design-stroke ${index === selected ? "zd-design-selection-outline" : "zd-design-frame-edge"} bg-bg1 pointer-events-auto absolute`}
              style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height, zIndex: 0,
                ...(index === selected ? { "--design-stroke-width": 2 } : {}) } as React.CSSProperties} />
          ))}
        </div>
      </div>
    </div>
  );
}

store = recordPage(frames);
createRoot(document.getElementById("root")!).render(<Harness />);
