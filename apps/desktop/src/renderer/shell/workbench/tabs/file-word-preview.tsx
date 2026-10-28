import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Download } from "lucide-react";
import { IconButton, Tooltip } from "@/renderer/shared/ui/primitives";
import { DocumentControls } from "./document-controls";
import { toast } from "@/renderer/shared/ui/primitives/elements";
import { useDocumentActive } from "@/renderer/state/use-document-active";
import { openWorkspaceMedia } from "@/renderer/platform/file-media";
import { WorkbenchEmptyState } from "../tab-status";
import { WORKBENCH_TITLE_ACTION_CLS } from "../tab-chrome";
import {
  DocumentPreviewError,
  readDocumentBytes,
  validateDocxArchive,
} from "./document-preview-source";
import type { PdfSource } from "./file-pdf-runtime";

interface WordPage {
  html: string;
  width: number;
  height: number;
}
const dimension = (value: string, fallback: number) => {
  const match = /^(\d+(?:\.\d+)?)(pt|px|in|cm|mm)$/.exec(value);
  if (!match) return fallback;
  const unit =
    { pt: 4 / 3, px: 1, in: 96, cm: 96 / 2.54, mm: 96 / 25.4 }[match[2]] ?? 1;
  return Math.max(200, Math.min(4000, Number(match[1]) * unit));
};

export function FileWordPreview({
  source,
  active,
  actionsContainer,
}: {
  source: PdfSource;
  active: boolean;
  actionsContainer: HTMLElement | null;
}) {
  const visible = useDocumentActive(active),
    host = useRef<HTMLDivElement>(null);
  const [pages, setPages] = useState<WordPage[]>([]),
    [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null),
    [zoom, setZoom] = useState<number | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const { cwd, path, bytes, blob } = source,
    version = source.media?.version;
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    setError(null);
    void (async () => {
      const [data, renderer, { default: purify }] = await Promise.all([
        readDocumentBytes(
          {
            cwd,
            path,
            bytes,
            blob,
            media: version
              ? {
                  version,
                  mimeType:
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                }
              : undefined,
          },
          controller.signal,
        ),
        import("docx-preview"),
        import("dompurify"),
      ]);
      controller.signal.throwIfAborted();
      await validateDocxArchive(data, controller.signal);
      // Rendering takes place in a detached document. Only the sanitized
      // result enters a scriptless, opaque-origin iframe with no network access.
      const detached = document.implementation.createHTMLDocument("");
      const body = detached.createElement("div"),
        styles = detached.createElement("div");
      await renderer.renderAsync(data, body, styles, {
        inWrapper: false,
        useBase64URL: true,
        ignoreLastRenderedPageBreak: false,
        renderAltChunks: false,
        renderComments: false,
        ignoreFonts: true,
        h: (input) => {
          if (typeof input === "string") return detached.createTextNode(input);
          if (input instanceof Node) return input;
          const { tagName, ns, children, className, style, ...props } = input;
          if (tagName === "#comment") return detached.createComment("");
          const node =
            tagName === "#fragment"
              ? detached.createDocumentFragment()
              : ns
                ? detached.createElementNS(ns, tagName)
                : detached.createElement(tagName);
          if (node instanceof Element) {
            if (className) node.setAttribute("class", className);
            if (typeof style === "string") node.setAttribute("style", style);
            else if (style && "style" in node)
              Object.assign((node as HTMLElement).style, style);
            for (const [key, value] of Object.entries(props)) {
              if (
                key === "href" &&
                typeof value === "string" &&
                value.startsWith("#")
              )
                node.setAttribute(key, value);
              else if (
                [
                  "colSpan",
                  "rowSpan",
                  "start",
                  "id",
                  "title",
                  "alt",
                  "width",
                  "height",
                  "viewBox",
                  "d",
                ].includes(key)
              )
                node.setAttribute(key, String(value));
            }
          }
          for (const child of children ?? [])
            node.appendChild(renderChild(child));
          return node;
          function renderChild(
            child: Parameters<NonNullable<typeof renderer.defaultOptions.h>>[0],
          ): Node {
            return child instanceof Node
              ? child
              : typeof child === "string"
                ? detached.createTextNode(child)
                : renderer.defaultOptions.h(child);
          }
        },
      });
      controller.signal.throwIfAborted();
      const css = purify.sanitize(styles.innerHTML, {
        ADD_TAGS: ["style"],
        FORCE_BODY: true,
      });
      const sections = Array.from(
        body.querySelectorAll<HTMLElement>("section.docx"),
      );
      if (!sections.length || sections.length > 1000)
        throw new DocumentPreviewError("This Word document can't be previewed.");
      const result = sections.map((section) => {
        const content = purify.sanitize(section.outerHTML, {
          ADD_ATTR: ["style"],
          FORBID_TAGS: [
            "iframe",
            "object",
            "embed",
            "form",
            "input",
            "button",
            "video",
            "audio",
          ],
          FORBID_ATTR: ["href", "xlink:href", "srcset"],
        });
        return {
          width: dimension(section.style.width, 816),
          height: dimension(
            section.style.minHeight || section.style.height,
            1056,
          ),
          html: `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">${css}<style>html,body{margin:0;padding:0;background:white;color:black}section.docx{box-shadow:none!important;margin:0!important}body{overflow-wrap:anywhere}</style></head><body>${content}</body></html>`,
        };
      });
      setPages(result);
      setPage((current) => Math.min(current, result.length));
    })().catch((value) => {
      if (!controller.signal.aborted)
        setError(
          value instanceof DocumentPreviewError
            ? value.message
            : "This Word document couldn't be loaded.",
        );
    });
    return () => {
      controller.abort();
      setPages([]);
    };
  }, [visible, cwd, path, bytes, blob, version]);
  useEffect(() => {
    if (!host.current || !visible) return;
    const observer = new ResizeObserver(([entry]) =>
      setSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      }),
    );
    observer.observe(host.current);
    return () => observer.disconnect();
  }, [visible, pages]);
  const go = (value: number) => {
    const next =
      Number.isFinite(value) && pages.length
        ? Math.min(pages.length, Math.max(1, Math.floor(value)))
        : page;
    setPage(next);
  };
  const current = visible ? pages[page - 1] : undefined;
  const scale =
    zoom ??
    (current
      ? Math.min(
          1,
          Math.max(
            0.1,
            Math.min(size.width / current.width, size.height / current.height),
          ),
        )
      : 1);
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
      data-file-document-preview="docx"
      className="relative flex h-full min-h-0 flex-col overflow-hidden"
    >
      {actionsContainer &&
        active &&
        createPortal(
          <Tooltip label="Download document">
            {source.media ? (
              <IconButton
                label="Download document"
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
                label="Download document"
                size="compact"
                className={WORKBENCH_TITLE_ACTION_CLS}
                asChild
                disabled={!source.dataUrl}
              >
                <a href={source.dataUrl} download={path.split("/").pop()}>
                  <Download className="size-3.5" />
                </a>
              </IconButton>
            )}
          </Tooltip>,
          actionsContainer,
        )}
      <div
        ref={host}
        className="zeros-document-viewport bg-bg2 min-h-0 min-w-0 flex-1 overflow-auto p-4"
      >
        {error ? (
          <WorkbenchEmptyState type="files" message={error} />
        ) : current ? (
          <div
            className="relative mx-auto"
            style={{
              width: current.width * scale,
              height: current.height * scale,
            }}
          >
            <iframe
              sandbox=""
              title={`Word document page ${page}`}
              srcDoc={current.html}
              className="absolute top-0 left-0 border-0"
              style={{
                width: current.width,
                height: current.height,
                transform: `scale(${scale})`,
                transformOrigin: "top left",
              }}
            />
          </div>
        ) : (
          <WorkbenchEmptyState type="files" message="Opening document…" />
        )}
      </div>
      {current && !error && (
        <DocumentControls
          label="Word controls"
          page={page}
          pageCount={pages.length}
          scale={scale}
          fit={zoom === null}
          maxScale={3}
          onPage={go}
          onZoom={setZoom}
        />
      )}
    </div>
  );
}
