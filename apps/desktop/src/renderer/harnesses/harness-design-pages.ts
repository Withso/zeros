// Development-only persisted engine fixture for the production page picker.
import { designPageTitleSchema } from "@zeros/protocol/design-pages";
import type {
  DesignCanvasFrameWire,
  DesignFrameDocumentWire,
  DesignWorkspaceSnapshotWire,
} from "../platform/git";

const STORAGE_KEY = "zeros:harness-design-pages-v1";
export function createDesignPagesHarness(
  base: DesignWorkspaceSnapshotWire,
  homeSource: string,
) {
  const home: DesignCanvasFrameWire = {
    ...base.frames[0],
    file: "page-1/home.html",
    pageId: "page_1",
    frameId: "home",
  };
  let snapshot: DesignWorkspaceSnapshotWire = {
    ...base,
    directoryId: "design_harness",
    directory: "North One - Design",
    frames: [home],
    pages: [
      {
        id: "page_1",
        title: "Page 1",
        folder: "page-1",
        frameFiles: [home.file],
        frameIds: ["home"],
      },
    ],
    lint: { ...base.lint, checkedFiles: [home.file], violations: [] },
  };
  const documents = new Map<string, DesignFrameDocumentWire>([
    [home.file, { ...home, source: homeSource, srcDoc: "", tree: [] }],
  ]);
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (saved?.snapshot?.pages && saved.documents) {
      snapshot = saved.snapshot;
      documents.clear();
      for (const document of saved.documents)
        documents.set(document.file, document);
    }
  } catch {
    /* A malformed development fixture starts fresh. */
  }
  const save = () =>
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ snapshot, documents: [...documents.values()] }),
    );
  const calls: Array<{ op: string; params: Record<string, unknown> }> = [];
  const control = { calls, holdCreate: false, releaseCreate: () => {} };
  (
    window as Window & { __zerosHarnessPages?: typeof control }
  ).__zerosHarnessPages = control;
  const refreshMembership = () => {
    snapshot = {
      ...snapshot,
      pages: snapshot.pages!.map((page) => {
        const frames = snapshot.frames.filter(
          (frame) => frame.pageId === page.id,
        );
        return {
          ...page,
          frameFiles: frames.map((frame) => frame.file),
          frameIds: frames.map((frame) => frame.frameId!),
        };
      }),
    };
    save();
  };
  const foundation = (frame: DesignCanvasFrameWire) => ({
    summary: {
      apiVersion: 1,
      documentId: "harness:" + frame.file,
      revision: "harness:" + frame.sourceVersion,
      entryFile: frame.file,
      fileCount: 1,
      nodeCount: frame.nodeCount,
      valid: true,
      diagnostics: [],
      lastValidRevision: "harness:" + frame.sourceVersion,
      history: {
        canUndo: false,
        canRedo: false,
        undoDepth: 0,
        redoDepth: 0,
        retainedBytes: 0,
        retainedReceiptBytes: 0,
        revision: "harness:" + frame.sourceVersion,
        lastReconciliationReason: null,
      },
    },
    foundation: {
      documentId: "harness:" + frame.file,
      revision: "harness:" + frame.sourceVersion,
      manifest: {
        schemaVersion: 1,
        parameters: [],
        variants: [],
        components: [],
      },
      keyframes: [],
    },
  });
  const frameUndo: DesignCanvasFrameWire[] = [];
  const frameRedo: DesignCanvasFrameWire[] = [];
  return {
    get snapshot() {
      return snapshot;
    },
    get documents() {
      return [...documents.values()];
    },
    foundation,
    async request(
      op: string | undefined,
      params: Record<string, unknown> = {},
    ): Promise<unknown> {
      if (!op) return undefined;
      calls.push({ op, params: { ...params } });
      const pages = snapshot.pages!;
      if (op === "file.tree")
        return {
          files: [
            "README.md",
            "North One - Design/meta/design.toml",
            "North One - Design/meta/canvas.json",
            "North One - Design/rules.md",
            "North One - Design/tokens.css",
            ...pages.map((page) => "North One - Design/" + page.folder + "/"),
            ...snapshot.frames.map(
              (frame) => "North One - Design/" + frame.file,
            ),
          ],
          truncated: false,
          designDirectories: ["North One - Design"],
        };
      if (op === "design.snapshot") return { snapshot };
      if (op === "design.page.select") return { ok: true };
      if (op === "design.page.create") {
        let n = pages.length + 1;
        while (
          pages.some(
            (page) => page.title === "Page " + n || page.folder === "page-" + n,
          )
        )
          n++;
        const page = {
          id: "page_" + crypto.randomUUID().replaceAll("-", ""),
          title: String(params.title ?? "Page " + n),
          folder: "page-" + n,
          frameFiles: [],
          frameIds: [],
        };
        snapshot = { ...snapshot, pages: [...pages, page] };
        save();
        return { page, snapshot };
      }
      if (op === "design.page.rename") {
        const title = designPageTitleSchema.parse(params.title);
        snapshot = {
          ...snapshot,
          pages: pages.map((page) =>
            page.id === params.pageId ? { ...page, title } : page,
          ),
        };
        save();
        return {
          page: snapshot.pages!.find((page) => page.id === params.pageId),
          snapshot,
        };
      }
      if (op === "design.page.delete") {
        const page = pages.find((page) => page.id === params.pageId)!;
        if (!page || pages.length === 1)
          throw new Error("Cannot delete the last page.");
        if (
          JSON.stringify([...page.frameIds!].sort()) !==
          JSON.stringify([...(params.expectedFrameIds as string[])].sort())
        )
          throw new Error("Page membership changed. Refresh before deleting.");
        for (const file of page.frameFiles) documents.delete(file);
        snapshot = {
          ...snapshot,
          pages: pages.filter((candidate) => candidate.id !== page.id),
          frames: snapshot.frames.filter((frame) => frame.pageId !== page.id),
        };
        save();
        return { deleted: { pageId: page.id }, snapshot };
      }
      if (op === "design.frame.create" || op === "design.frame.duplicate") {
        // Capture the target before the delayed engine reply, just like the real write lane.
        const page =
          pages.find((page) => page.id === params.pageId) ??
          (pages.length === 1 ? pages[0] : undefined);
        if (!page) throw new Error("pageId required");
        if (control.holdCreate) {
          await new Promise<void>((resolve) => {
            control.releaseCreate = () => {
              control.holdCreate = false;
              resolve();
            };
          });
        }
        const original = snapshot.frames.find(
          (frame) => frame.file === params.frame,
        );
        let n = 1;
        while (documents.has(page.folder + "/frame-" + n + ".html")) n++;
        const file = page.folder + "/frame-" + n + ".html";
        const id = "frame_" + crypto.randomUUID().replaceAll("-", "");
        const index = snapshot.frames.filter(
          (frame) => frame.pageId === page.id,
        ).length;
        const frame: DesignCanvasFrameWire = {
          file,
          pageId: page.id,
          frameId: id,
          title: String(params.title ?? original?.title ?? "Frame"),
          kind: params.kind === "text" ? "text" : "frame",
          width: Number(params.w ?? original?.width ?? 1440),
          height: Number(params.h ?? original?.height ?? 900),
          x: Number(params.x ?? index * 1560),
          y: Number(params.y ?? 0),
          z: Number(params.z ?? index),
          nodeCount: 1,
          modifiedAt: Date.now(),
          sourceVersion: id.slice(-24),
        };
        const text = String(params.text ?? "")
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;");
        const source = original
          ? documents.get(original.file)!.source
          : '<!doctype html><html><head><style>*{box-sizing:border-box}body{margin:0;background:white;font-family:system-ui}</style></head><body><main data-oid="' +
            String(params.textNodeId ?? id) +
            '" data-zeros-frame-root style="width:100%;height:100vh">' +
            text +
            "</main></body></html>";
        documents.set(file, { ...frame, source, srcDoc: "", tree: [] });
        snapshot = { ...snapshot, frames: [...snapshot.frames, frame] };
        refreshMembership();
        return { frame, snapshot };
      }
      if (op === "design.frame") {
        const frame = snapshot.frames.find(
          (frame) => frame.file === params.frame,
        );
        const document = frame ? documents.get(frame.file) : undefined;
        if (!frame || !document)
          throw new Error("The harness frame is unavailable.");
        return { frame: { ...document, ...frame } };
      }
      if (op === "design.foundation.open") {
        const frame = snapshot.frames.find(
          (frame) => frame.file === params.frame,
        );
        if (!frame) throw new Error("The harness foundation is unavailable.");
        return foundation(frame);
      }
      if (op === "design.canvas.update") {
        const geometry = {
          x: Number(params.x),
          y: Number(params.y),
          w: Number(params.w),
          h: Number(params.h),
          z: Number(params.z),
        };
        snapshot = {
          ...snapshot,
          frames: snapshot.frames.map((frame) =>
            frame.file === params.frame
              ? {
                  ...frame,
                  x: geometry.x,
                  y: geometry.y,
                  width: geometry.w,
                  height: geometry.h,
                  z: geometry.z,
                }
              : frame,
          ),
        };
        save();
        return { geometry, snapshot };
      }
      if (op === "design.frame.delete") {
        const frame = snapshot.frames.find(
          (frame) => frame.file === params.frame,
        )!;
        frameUndo.push(frame);
        frameRedo.length = 0;
        snapshot = {
          ...snapshot,
          frames: snapshot.frames.filter((candidate) => candidate !== frame),
        };
        refreshMembership();
        return { deleted: { file: frame.file }, snapshot };
      }
      if (op === "design.history.undo" || op === "design.history.redo") {
        const undo = op.endsWith("undo");
        const frame = (undo ? frameUndo : frameRedo).pop();
        if (frame) {
          (undo ? frameRedo : frameUndo).push(frame);
          snapshot = {
            ...snapshot,
            frames: undo
              ? [...snapshot.frames, frame]
              : snapshot.frames.filter(
                  (candidate) => candidate.file !== frame.file,
                ),
          };
          refreshMembership();
        }
        return {
          result: null,
          historyFrame: frame?.file,
          historySelection: undo ? frame?.file : null,
          snapshot,
        };
      }
      return undefined;
    },
  };
}
