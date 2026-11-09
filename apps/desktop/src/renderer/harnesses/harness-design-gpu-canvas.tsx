// Development-only fixture for the recorded GPU Design canvas: the real
// scene, CanvasKit worker, chunk cache and compositor draw a page of frames
// recorded in this page with CanvasKit, under a minimal canvas world.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import "../features/design-workspace/design-workspace-ui.css";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { externalizeDesignPictureTypefaces } from "../../../shared/design-picture-typefaces";
import { paintDesignCanvasCamera } from "../features/design-workspace/design-canvas-camera";
import type { DesignViewport } from "../features/design-workspace/design-canvas-math";
import CanvasKitInit from "../features/design-workspace/gpu/canvaskit/canvaskit.js";
import wasmUrl from "../features/design-workspace/gpu/canvaskit/canvaskit.wasm?url";
import { createDesignGpuRuntime, useDesignGpuCanvas } from "../features/design-workspace/gpu/design-gpu-canvas";
import type { DesignGpuSceneFrame } from "../features/design-workspace/gpu/design-gpu-scene";
import type { DesignRecordingsSource } from "../features/design-workspace/gpu/design-recordings";
import type { DesignRecording, DesignRecordingTypeface, DesignRecordingsReadReply,
  DesignRecordingsReply } from "../features/design-workspace/gpu/design-recordings-wire";

const COLUMNS = 6, ROWS = 4, WIDTH = 320, HEIGHT = 200, GAP = 40, SCALE = 2;
const CHUNK_BYTES = 16 * 1024;
const params = new URLSearchParams(location.search);
const enabled = params.get("enabled") !== "0";

/** Each frame's fill is distinct; the smoke reads it back from screen pixels. */
export const designGpuHarnessFill = (index: number): [number, number, number] =>
  [40 + (index * 37) % 180, 60 + (index * 53) % 160, 90 + (index * 71) % 150];

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
  const font = new Uint8Array(await (await fetch("/node_modules/@fontsource-variable/geist/files/geist-latin-wght-normal.woff2")).arrayBuffer());
  const manager = ck.FontMgr.FromData(font.buffer)!;
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
    for (const { id, bytes } of external.typefaces)
      if (!store.typefaces.has(id)) store.typefaces.set(id, { id, bytes: bytes.length, chunks: await chunked(bytes, store) });
    store.recordings.set(frame.file, { file: frame.file, sourceVersion: frame.sourceVersion!, width: frame.width, height: frame.height,
      scale: SCALE, layers: [{ x: 0, y: 0, width: frame.width * SCALE, height: frame.height * SCALE, bytes: external.skp.length,
        chunks: await chunked(external.skp, store), typefaces: external.typefaces.map((entry) => entry.id) }] });
  }
  manager.delete();
  return store;
}

const frames: DesignGpuSceneFrame[] = Array.from({ length: COLUMNS * ROWS }, (_, index) => ({
  file: `page-1/frame-${index + 1}.html`, sourceVersion: (index + 1).toString(16).padStart(24, "0"),
  x: (index % COLUMNS) * (WIDTH + GAP), y: Math.floor(index / COLUMNS) * (HEIGHT + GAP), width: WIDTH, height: HEIGHT,
}));

const requests: Array<{ op: string; frames: number; known: number; chunks: number }> = [];
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
const source: DesignRecordingsSource = {
  async read(_owner, asked, known) {
    requests.push({ op: "read", frames: asked.length, known: known.length, chunks: 0 });
    // A first open: nothing is stored yet.
    return { recordings: [], typefaces: [], chunks: [], missing: asked.map((frame) => frame.file), deferred: [] } satisfies DesignRecordingsReadReply;
  },
  async render(_owner, asked, known) {
    const { recordings, typefaces, chunks } = await reply(asked, known);
    requests.push({ op: "render", frames: asked.length, known: known.length, chunks: chunks.length });
    return { pipeline: "harness-1", recordings, typefaces, chunks, stale: [], failed: [], deferred: [] } satisfies DesignRecordingsReply;
  },
};
const runtime = createDesignGpuRuntime(source);

declare global {
  interface Window {
    designGpuHarness: {
      frames: readonly DesignGpuSceneFrame[];
      requests: typeof requests;
      setView(view: DesignViewport): void;
      fill: typeof designGpuHarnessFill;
    };
  }
}

function Harness() {
  const worldRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState<DesignViewport>({ zoom: 0.5, panX: 20, panY: 20 });
  const size = useMemo(() => ({ width: 1040, height: 520 }), []);
  window.designGpuHarness = { frames, requests, setView, fill: designGpuHarnessFill };
  useLayoutEffect(() => { paintDesignCanvasCamera(worldRef.current, view, false, size); }, [size, view]);
  const owner = useMemo(() => ({ workspaceId: "/harness/workspace", directoryId: "design_harness", theme: null }), []);
  const live = useMemo(() => new Set<string>(), []);
  useDesignGpuCanvas({ enabled, active: true, worldRef, documentOwner: "harness", owner, openKey: "harness:page-1", frames, live, runtime });
  return (
    <div data-design-canvas-viewport="" className="bg-bg2 relative overflow-clip" style={{ width: size.width, height: size.height }}>
      <div className="pointer-events-none absolute inset-0 isolate">
        <div ref={worldRef} data-design-canvas-world="" className="pointer-events-none absolute inset-0 origin-top-left">
          {frames.map((frame) => (
            <article key={frame.file} data-design-frame={frame.file} data-design-frame-controls="automatic"
              className="zd-design-frame zd-design-stroke zd-design-frame-edge bg-bg1 pointer-events-auto absolute"
              style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height, zIndex: 0 }} />
          ))}
        </div>
      </div>
    </div>
  );
}

store = recordPage(frames);
createRoot(document.getElementById("root")!).render(<Harness />);
