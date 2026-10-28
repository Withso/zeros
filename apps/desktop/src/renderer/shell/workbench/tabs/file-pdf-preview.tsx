import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Download, PanelLeft, RotateCw } from "lucide-react";
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
  RenderTask,
  TextLayer,
} from "pdfjs-dist";
import {
  Button,
  IconButton,
  Input,
  Tooltip,
} from "@/renderer/shared/ui/primitives";
import { toast } from "@/renderer/shared/ui/primitives/elements";
import { useDocumentActive } from "@/renderer/state/use-document-active";
import { WorkbenchEmptyState } from "../tab-status";
import { openWorkspaceMedia } from "@/renderer/platform/file-media";
import { WORKBENCH_TITLE_ACTION_CLS } from "../tab-chrome";
import type { PdfSource } from "./file-pdf-runtime";
import "pdfjs-dist/web/pdf_viewer.css";
import "./file-pdf-preview.css";
import { DocumentControls } from "./document-controls";

export function FilePdfPreview({
  source,
  active,
  actionsContainer,
}: {
  source: PdfSource;
  active: boolean;
  actionsContainer: HTMLElement | null;
}) {
  const visible = useDocumentActive(active);
  const { cwd, path, bytes, blob, dataUrl } = source;
  const version = source.media?.version;
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [passwordRequired, setPasswordRequired] = useState(false);
  const passwordId = useId();
  const unlock = useRef<((password: string) => void) | null>(null);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState<number | null>(null);
  const [renderedScale, setRenderedScale] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [sidebar, setSidebar] = useState(true);
  useEffect(() => {
    if (!visible) return;
    let retired = false,
      task: PDFDocumentLoadingTask | undefined;
    setError(null);
    setPasswordRequired(false);
    void import("./file-pdf-runtime")
      .then((runtime) => {
        if (retired) return;
        task = runtime.openPdfDocument(
          {
            cwd,
            path,
            bytes,
            blob,
            dataUrl,
            media: version
              ? { version, mimeType: "application/pdf" }
              : undefined,
          },
          () => {
            if (!retired) {
              setError("This document couldn't be loaded.");
              void task?.destroy();
            }
          },
        );
        task.onPassword = (update: (password: string) => void) => {
          if (!retired) {
            unlock.current = update;
            setPasswordRequired(true);
          }
        };
        return task.promise.then((pdf) => {
          if (retired) return;
          if (pdf.numPages > 5000) {
            setError("This document has too many pages to preview.");
            void task?.destroy();
            return;
          }
          setPage((current) => Math.min(current, pdf.numPages));
          setDocument(pdf);
          setPasswordRequired(false);
        });
      })
      .catch(() => {
        if (!retired) setError("This document couldn't be loaded.");
      });
    return () => {
      retired = true;
      unlock.current = null;
      setDocument(null);
      setPassword("");
      void task?.destroy();
    };
  }, [visible, cwd, path, bytes, blob, dataUrl, version]);
  const go = (number: number) => {
    if (!document || !Number.isFinite(number)) {
      return;
    }
    const next = Math.min(document.numPages, Math.max(1, Math.floor(number)));
    setPage(next);
  };
  const download = async () => {
    if (!cwd || !source.media) return;
    const lease = await openWorkspaceMedia({
      cwd,
      path,
      bytes,
      media: source.media,
    });
    try {
      await lease.download(path.split("/").pop() ?? path);
    } finally {
      lease.release();
    }
  };
  return (
    <div
      data-file-document-preview="pdf"
      className="relative flex h-full min-h-0 flex-col overflow-hidden"
    >
      {actionsContainer &&
        active &&
        createPortal(
          <>
            <Tooltip label="Toggle page thumbnails">
              <IconButton
                label="Toggle page thumbnails"
                aria-pressed={sidebar}
                size="compact"
                className={WORKBENCH_TITLE_ACTION_CLS}
                disabled={!document}
                onClick={() => setSidebar((value) => !value)}
              >
                <PanelLeft className="size-3.5" />
              </IconButton>
            </Tooltip>
            <Tooltip label="Rotate page">
              <IconButton
                label="Rotate page"
                size="compact"
                className={WORKBENCH_TITLE_ACTION_CLS}
                disabled={!document}
                onClick={() => setRotation((value) => (value + 90) % 360)}
              >
                <RotateCw className="size-3.5" />
              </IconButton>
            </Tooltip>
            <Tooltip label="Download PDF">
              {source.media ? (
                <IconButton
                  label="Download PDF"
                  size="compact"
                  className={WORKBENCH_TITLE_ACTION_CLS}
                  onClick={() =>
                    void download().catch(() =>
                      toast.error("Couldn't download this file."),
                    )
                  }
                >
                  <Download className="size-3.5" />
                </IconButton>
              ) : (
                <IconButton
                  label="Download PDF"
                  size="compact"
                  className={WORKBENCH_TITLE_ACTION_CLS}
                  asChild
                  disabled={!dataUrl}
                >
                  <a href={dataUrl} download={path.split("/").pop()}>
                    <Download className="size-3.5" />
                  </a>
                </IconButton>
              )}
            </Tooltip>
          </>,
          actionsContainer,
        )}
      {passwordRequired ? (
        <form
          className="flex flex-1 flex-col items-center justify-center gap-3 p-4"
          onSubmit={(event) => {
            event.preventDefault();
            unlock.current?.(password);
            setPassword("");
            setPasswordRequired(false);
          }}
        >
          <label htmlFor={passwordId} className="text-fg2 text-xs">
            This PDF is password protected.
          </label>
          <Input
            id={passwordId}
            type="password"
            aria-label="PDF password"
            autoComplete="off"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="max-w-64"
          />
          <Button type="submit" size="compact" disabled={!password}>
            Open PDF
          </Button>
        </form>
      ) : error ? (
        <WorkbenchEmptyState type="files" message={error} />
      ) : document && visible ? (
        <div className="flex min-h-0 flex-1">
          {sidebar && (
            <PdfThumbnails document={document} page={page} onSelect={go} />
          )}
          <PdfPage
            document={document}
            page={page}
            zoom={zoom}
            rotation={rotation}
            onScale={setRenderedScale}
          />
        </div>
      ) : (
        <WorkbenchEmptyState type="files" message="Opening document…" />
      )}
      {document && visible && !error && !passwordRequired && (
        <DocumentControls
          label="PDF controls"
          page={page}
          pageCount={document.numPages}
          scale={renderedScale}
          fit={zoom === null}
          maxScale={4}
          onPage={go}
          onZoom={setZoom}
        />
      )}
    </div>
  );
}

function PdfThumbnails({
  document,
  page,
  onSelect,
}: {
  document: PDFDocumentProxy;
  page: number;
  onSelect(page: number): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const rows = useVirtualizer({
    count: document.numPages,
    getScrollElement: () => host.current,
    estimateSize: () => 156,
    overscan: 3,
  });
  useEffect(() => {
    rows.scrollToIndex(page - 1, { align: "auto" });
  }, [page, rows]);
  return (
    <div
      ref={host}
      role="navigation"
      aria-label="PDF pages"
      className="zeros-document-viewport border-border1 bg-bg2 w-32 shrink-0 overflow-y-auto border-r p-2"
    >
      <div className="relative w-full" style={{ height: rows.getTotalSize() }}>
        {rows.getVirtualItems().map((row) => (
          <div
            key={row.key}
            data-index={row.index}
            ref={rows.measureElement}
            className="absolute top-0 left-0 w-full"
            style={{ transform: `translateY(${row.start}px)` }}
          >
            <PdfThumbnail
              document={document}
              page={row.index + 1}
              selected={page === row.index + 1}
              onSelect={() => onSelect(row.index + 1)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function PdfThumbnail({
  document,
  page,
  selected,
  onSelect,
}: {
  document: PDFDocumentProxy;
  page: number;
  selected: boolean;
  onSelect(): void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!canvas.current) return;
    const node = canvas.current;
    let cancelled = false,
      task: RenderTask | undefined,
      resource: PDFPageProxy | undefined;
    void document
      .getPage(page)
      .then((pdfPage) => {
        if (cancelled) return;
        resource = pdfPage;
        const base = pdfPage.getViewport({ scale: 1 }),
          viewport = pdfPage.getViewport({ scale: 92 / base.width });
        node.width = Math.ceil(viewport.width);
        node.height = Math.ceil(viewport.height);
        task = pdfPage.render({ canvas: node, viewport });
        return task.promise;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      task?.cancel();
      node.width = node.height = 0;
      void task?.promise.catch(() => {}).finally(() => resource?.cleanup());
    };
  }, [document, page]);
  return (
    <Button
      variant="ghost"
      aria-label={`Page ${page}`}
      aria-current={selected ? "page" : undefined}
      onClick={onSelect}
      className={`mb-2 flex h-auto w-full flex-col gap-1 p-1 ${selected ? "bg-bg2-hover text-fg1" : "text-fg3"}`}
    >
      <canvas
        ref={canvas}
        className="zeros-pdf-thumbnail max-w-full"
        aria-hidden="true"
      />
      <span className="text-xxs tabular-nums">{page}</span>
    </Button>
  );
}

function PdfPage({
  document,
  page,
  zoom,
  rotation,
  onScale,
}: {
  document: PDFDocumentProxy;
  page: number;
  zoom: number | null;
  rotation: number;
  onScale(scale: number): void;
}) {
  const host = useRef<HTMLDivElement>(null),
    canvas = useRef<HTMLCanvasElement>(null),
    text = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [dimensions, setDimensions] = useState({
    width: 0,
    height: 0,
    scale: 1,
  });
  const [failed, setFailed] = useState(false);
  useLayoutEffect(() => {
    if (!host.current) return;
    const observer = new ResizeObserver(([entry]) =>
      setSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      }),
    );
    observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!canvas.current || !text.current || !size.width || !size.height) return;
    const bitmap = canvas.current,
      layer = text.current;
    let retired = false,
      render: RenderTask | undefined,
      textLayer: TextLayer | undefined,
      pdfPage: PDFPageProxy | undefined;
    setFailed(false);
    layer.replaceChildren();
    void Promise.all([document.getPage(page), import("pdfjs-dist")])
      .then(async ([value, pdf]) => {
        if (retired) return;
        pdfPage = value;
        const base = value.getViewport({
          scale: 1,
          rotation: value.rotate + rotation,
        });
        const scale =
          zoom ??
          Math.min(size.width / base.width, size.height / base.height, 2);
        const viewport = value.getViewport({
          scale: Math.max(0.1, scale),
          rotation: value.rotate + rotation,
        });
        onScale(viewport.scale);
        const density = Math.min(
          window.devicePixelRatio || 1,
          2,
          Math.sqrt(16_000_000 / (viewport.width * viewport.height)),
        );
        setDimensions({
          width: viewport.width,
          height: viewport.height,
          scale: viewport.scale,
        });
        bitmap.width = Math.ceil(viewport.width * density);
        bitmap.height = Math.ceil(viewport.height * density);
        render = value.render({
          canvas: bitmap,
          viewport,
          transform: [density, 0, 0, density, 0, 0],
        });
        textLayer = new pdf.TextLayer({
          textContentSource: value.streamTextContent(),
          container: layer,
          viewport,
        });
        await Promise.all([render.promise, textLayer.render()]);
      })
      .catch(() => {
        if (!retired) setFailed(true);
      });
    return () => {
      retired = true;
      render?.cancel();
      textLayer?.cancel();
      layer.replaceChildren();
      bitmap.width = bitmap.height = 0;
      // Wait until rendering releases page resources before cleanup.
      void render?.promise.catch(() => {}).finally(() => pdfPage?.cleanup());
    };
  }, [document, page, zoom, rotation, size.width, size.height, onScale]);
  return (
    <div
      ref={host}
      className="zeros-document-viewport bg-bg2 min-h-0 min-w-0 flex-1 overflow-auto p-4"
      role="region"
      aria-label={`PDF page ${page}`}
    >
      {failed && (
        <WorkbenchEmptyState
          type="files"
          message="This page couldn't be rendered."
        />
      )}
      <div
        hidden={failed}
        className="zeros-pdf-page relative mx-auto shrink-0"
        style={
          {
            width: dimensions.width || undefined,
            height: dimensions.height || undefined,
            "--scale-factor": dimensions.scale,
            "--total-scale-factor": dimensions.scale,
          } as CSSProperties
        }
      >
        <canvas
          ref={canvas}
          className="block h-full w-full"
          aria-label={`Page ${page}`}
        />
        <div ref={text} className="textLayer select-text" />
      </div>
    </div>
  );
}
