import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesignHeadlessRenderer } from "@zeros/design-web";
import { createHash } from "node:crypto";
import { DesignApi } from "@zeros/design-web";
import { DesignDraftStore, designDocumentIdForFrame } from "../design-api";
import { readDesignWebDocumentState } from "../document-transactions";
import type { DesignEvidenceRenderer } from "../capture-client";
import { createDesignContextReference } from "../context";
import {
  createDesignFrame,
  initializeDesignDocument,
  prepareDesignNavigationFrames,
  readDesignFrameRenderIdentity,
  readDesignNavigationSnapshot,
  readDesignWorkspaceSnapshot,
} from "../document";
import { designDirectoryNameFor, forgetDesignDirectoryName } from "../directory-registry";
import { designDirectoryEntry } from "../metadata";
import { readDesignProtocolResource } from "../protocol-resource";
import { renderDesignRecordings } from "../recording-batch";
import { resetDesignRecordingStoreCachesForTests } from "../recording-store";
import { createDesignResult } from "../results";
import { settleDesignFontDownloadsForTests, resetDesignFontsForTests } from "../style-fonts";
import { composeDesignThumbnailBatches } from "../thumbnail-batch";
import { resetDesignThumbnailStoreForTests, settleDesignThumbnailStoreForTests } from "../thumbnail-store";
import { startDesignVerificationService } from "../verification-service";
import { runDesignVerificationCli } from "../verification-cli";

// Items are canvas chrome: no export, capture or preview path may carry their
// text, a link card's title or its path, in what it renders or returns.
const SENTINELS = ["Section-text-00a1", "Note-text-00a1", "Link-title-00a1", "link-target-00a1"];
const leaks = (value: unknown) => {
  const text = typeof value === "string" ? value : Buffer.isBuffer(value) ? value.toString("latin1") : JSON.stringify(value);
  return SENTINELS.filter((sentinel) => text.includes(sentinel));
};

const png = (width: number, height: number) => {
  const bytes = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(bytes);
  bytes.write("IHDR", 12); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
  return bytes;
};

describe("canvas items never reach an export", () => {
  let root: string;
  let directory: string;
  let directoryId: string;
  let frame: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "zeros-design-items-exports-"));
    process.env.ZEROS_DATA_DIR = path.join(root, "private");
    execFileSync("git", ["init", "-q"], { cwd: root });
    await initializeDesignDocument(root);
    directory = designDirectoryNameFor(root);
    directoryId = designDirectoryEntry(root, directory)!.id;
    frame = (await createDesignFrame(root, { title: "Phone", geometry: { x: 0, y: 0, w: 390, h: 844, z: 0 } })).file;
    await mkdir(path.join(root, "docs"));
    await writeFile(path.join(root, "docs/link-target-00a1.md"), "# Linked\n");
    const canvasFile = path.join(root, directory, "meta/canvas.json");
    const canvas = JSON.parse(await readFile(canvasFile, "utf8"));
    canvas.pages[0].items = [
      { id: "s1", kind: "section", x: 0, y: -60, width: 400, text: SENTINELS[0] },
      { id: "n1", kind: "note", x: 420, y: 0, width: 240, height: 160, text: SENTINELS[1] },
      { id: "l1", kind: "link", x: 420, y: 200, width: 280, title: SENTINELS[2], target: `docs/${SENTINELS[3]}.md` },
    ];
    await writeFile(canvasFile, JSON.stringify(canvas, null, 2));
    // The items are real: the canvas draws all three.
    const snapshot = await readDesignWorkspaceSnapshot(root);
    expect(snapshot.pages![0]!.items).toHaveLength(3);
    // and the detector sees every sentinel where items do belong.
    expect(leaks(snapshot.pages)).toEqual(SENTINELS);
  });
  afterEach(async () => {
    await settleDesignFontDownloadsForTests();
    resetDesignFontsForTests();
    await settleDesignThumbnailStoreForTests();
    resetDesignThumbnailStoreForTests();
    resetDesignRecordingStoreCachesForTests();
    delete process.env.ZEROS_DATA_DIR;
    forgetDesignDirectoryName(root);
    await rm(root, { recursive: true, force: true });
  });

  const headless = () => {
    const renders: unknown[] = [];
    const renderer: DesignHeadlessRenderer = {
      async render(input) {
        renders.push(input);
        const size = input.rasterSize ?? input.viewport;
        const { sourceVersion } = await readDesignFrameRenderIdentity(root, frame);
        return { mimeType: "image/png", bytes: png(size.width, size.height), width: size.width, height: size.height,
          revision: input.state.revision, metadata: { sourceVersion } };
      },
    };
    return { renders, renderer };
  };

  it("design.capture and the canvas preview: neither the render input nor the PNG", async () => {
    const { renders, renderer } = headless();
    // design.capture renders the frame's document through the Design API.
    const api = new DesignApi(new DesignDraftStore(root), { authorization: { kind: "trusted-in-process" }, renderer, maxSessions: 1,
      maxSessionBytes: 32 * 1024 * 1024 });
    const artifact = await api.render({ documentId: designDocumentIdForFrame(frame),
      viewport: { width: 390, height: 844, deviceScaleFactor: 1, reducedMotion: "reduce" } });
    const { previewWorkspaceDesign } = await import("../workspace-capture");
    const { sourceVersion } = await readDesignFrameRenderIdentity(root, frame);
    const preview = await previewWorkspaceDesign(root, { workspaceId: "w", frame, sourceVersion, theme: null, maxDimension: 256 }, { renderer });
    expect(renders).toHaveLength(2);
    expect(leaks(renders)).toEqual([]);
    expect(leaks(Buffer.from(artifact.bytes))).toEqual([]);
    expect(leaks(preview)).toEqual([]);
  });

  it("thumbnails and recordings: no batch request carries item text", async () => {
    const navigation = await readDesignNavigationSnapshot(root);
    const prepared = await prepareDesignNavigationFrames(root, navigation.catalogRevision, [frame]);
    const frames = prepared.frames.map((entry) => ({ file: entry.file, sourceVersion: entry.sourceVersion! }));
    const thumbnails = await composeDesignThumbnailBatches(root, { workspaceId: "w", directoryId, theme: null, colorScheme: "light",
      maxDimension: 128, frames });
    expect(thumbnails.batches).toHaveLength(1);
    expect(leaks(thumbnails)).toEqual([]);
    const requests: unknown[] = [];
    const record = vi.fn(async (request: { revision: string; items: Array<{ id: string }> }) => {
      requests.push(request);
      return { version: 1 as const, revision: request.revision, recorder: "recorder-1", items: request.items.map((item) => ({ id: item.id, error: "not recorded here", permanent: true as const })) };
    });
    const recordings = await renderDesignRecordings(root, { workspaceId: "w", directoryId, theme: null, frames },
      { record: record as never, recorder: "recorder-1" });
    expect(record).toHaveBeenCalledOnce();
    expect(leaks(requests)).toEqual([]);
    expect(leaks(recordings)).toEqual([]);
  });

  it("the frame HTTP document, the verification preview, design.context.capture and design validate's frame", async () => {
    const identity = await readDesignFrameRenderIdentity(root, frame);
    const resource = await readDesignProtocolResource(root, { path: frame, sourceVersion: identity.sourceVersion, surface: true, theme: null });
    expect(resource.status).toBe(200);
    expect(leaks(resource.body)).toEqual([]);
    const runtime = await readDesignProtocolResource(root, { path: frame, sourceVersion: identity.sourceVersion });
    expect(leaks(runtime.body)).toEqual([]);

    const composed: unknown[] = [];
    const render = vi.fn<NonNullable<DesignEvidenceRenderer["renderComposed"]>>(async (input) => {
      composed.push(input);
      return { bytes: png(input.viewport.width, input.viewport.height), mimeType: "image/png", revision: input.state.revision,
        width: input.viewport.width, height: input.viewport.height, metadata: { sourceVersion: input.sourceVersion } };
    });
    const service = await startDesignVerificationService({ renderer: () => ({ render, renderComposed: render }) });
    try {
      const reference = await createDesignContextReference(root, "workspace", frame);
      const url = service.register({ workspaceId: "workspace", workspacePath: root, directory, directoryId: reference.directoryId }).url;
      const state = await (await fetch(`${url}/${frame}/state`)).json() as { reference: { revision: string } };
      expect(leaks(state)).toEqual([]);
      expect(leaks(await (await fetch(`${url}/${frame}/`)).text())).toEqual([]);
      expect(leaks(await (await fetch(`${url}/${frame}/document?revision=${state.reference.revision}`)).text())).toEqual([]);
      // design.context.capture fetches exactly this capture endpoint.
      const capture = await fetch(`${url}/${frame}/capture?revision=${state.reference.revision}&frameId=${encodeURIComponent(reference.frameId ?? "")}`);
      expect(capture.ok).toBe(true);
      expect(leaks(Buffer.from(await capture.arrayBuffer()))).toEqual([]);
      const output = path.join(root, ".context", "phone.png");
      expect(await runDesignVerificationCli(["capture", "--url", url, "--frame", frame, "--output", output], () => {})).toBe(0);
      expect(render).toHaveBeenCalledTimes(2);
      expect(leaks(composed)).toEqual([]);
      expect(leaks(await readFile(output))).toEqual([]);
    } finally {
      await service.stop();
    }
  });

  it("review capture: the evidence render and its manifest", async () => {
    const renders: unknown[] = [];
    const render = vi.fn<NonNullable<DesignEvidenceRenderer["renderComposed"]>>(async (input) => {
      renders.push(input);
      // A qualified host attests the exact composed bytes it rendered.
      return { bytes: png(input.viewport.width, input.viewport.height), mimeType: "image/png", revision: input.state.revision,
        width: input.viewport.width, height: input.viewport.height,
        metadata: { sourceVersion: input.sourceVersion, htmlSha256: createHash("sha256").update(input.html).digest("hex") } };
    });
    const { revision } = await readDesignWebDocumentState(root, frame);
    const manifest = await createDesignResult(root, directoryId, "actor-00a1", { requestId: "review:00000000000000a1", createdAt: 1,
      documentId: designDocumentIdForFrame(frame), expectedRevision: revision, width: 1024, height: 768, capture: true },
      { renderer: { render, renderComposed: render } });
    expect(render).toHaveBeenCalled();
    expect(leaks(renders)).toEqual([]);
    expect(leaks(manifest)).toEqual([]);
  });
});
