import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createDesignCaptureRenderer } from "../capture-client";
import { startDesignCaptureService, type DesignCaptureService } from "../capture-service";
import { createDesignFrame, initializeDesignDocument, readDesignWebDocumentState } from "../document";
import { forgetDesignDirectoryName } from "../directory-registry";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1XcAAAAASUVORK5CYII=",
  "base64",
);
const viewport = { width: 1, height: 1, deviceScaleFactor: 1, colorScheme: "light" as const, reducedMotion: "reduce" as const };

let root: string;
let frame: string;
let service: DesignCaptureService | undefined;
let release: () => void;
let held: Promise<void>;
let hosted: number;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "zeros-design-capture-client-"));
  await initializeDesignDocument(root);
  frame = (await createDesignFrame(root, { title: "Capacity" })).file;
  hosted = 0;
  held = new Promise((resolve) => { release = resolve; });
  // The first capture holds the host's single slot until released.
  service = await startDesignCaptureService(async () => {
    if (hosted++ === 0) await held;
    return { bytes: png, renderer: "fixture" };
  });
});

afterEach(async () => {
  release();
  await service?.stop();
  service = undefined;
  forgetDesignDirectoryName(root);
  await rm(root, { recursive: true, force: true });
});

function renderer(options?: Parameters<typeof createDesignCaptureRenderer>[3]) {
  return createDesignCaptureRenderer(root, { url: service!.url, token: service!.token }, fetch, options)!;
}

async function holdSlot() {
  const state = await readDesignWebDocumentState(root, frame);
  const first = renderer({ capacityRetry: false }).render({ state, viewport });
  await expect.poll(() => hosted).toBe(1);
  return { state, first };
}

it("waits for a busy capture slot instead of failing an explicit capture", async () => {
  const { state, first } = await holdSlot();
  const explicit = renderer().render({ state, viewport });
  setTimeout(release, 250);
  await expect(explicit).resolves.toMatchObject({ width: 1, height: 1, revision: state.revision });
  await expect(first).resolves.toMatchObject({ width: 1, height: 1 });
  expect(hosted).toBe(2);
});

it("lets a background preview yield the busy slot at once", async () => {
  const { state, first } = await holdSlot();
  await expect(renderer({ capacityRetry: false }).render({ state, viewport }))
    .rejects.toThrow("Design capture capacity reached.");
  release();
  await first;
  expect(hosted).toBe(1);
});

it("stops waiting for the slot when the capture is cancelled", async () => {
  const { state, first } = await holdSlot();
  const controller = new AbortController();
  const explicit = renderer().render({ state, viewport, signal: controller.signal });
  setTimeout(() => controller.abort(new Error("Capture cancelled.")), 150);
  await expect(explicit).rejects.toThrow("Capture cancelled.");
  release();
  await first;
  expect(hosted).toBe(1);
});
