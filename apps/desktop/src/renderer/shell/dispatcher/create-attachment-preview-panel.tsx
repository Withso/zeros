import { useEffect, useRef, useState } from "react";
import { Download, X } from "lucide-react";
import DOMPurify from "dompurify";
import type { ComposerAttachment } from "../../features/agent/composer-attachments";
import { FileTypeIcon } from "../../features/agent/composer-editor/file-type-icon";
import { Button, PanelHeader, Tabs, TabsContent, TabsList, TabsTrigger, Tooltip } from "../../shared/ui/primitives";
import { WorkbenchEmptyState, WorkbenchTabBanner } from "../workbench/tab-status";
import { readCreateAttachmentPreview, type CreateAttachmentPreview } from "./create-attachment-preview";

/** Source preview has no workspace/bridge lifetime. Its parent unmounts it on
 * hide or owner changes; every read and object URL belongs to this one file. */
export function CreateAttachmentPreviewPanel({ attachment, onClose }: {
  attachment: ComposerAttachment;
  onClose: () => void;
}) {
  const [loaded, setLoaded] = useState<{ preview: CreateAttachmentPreview; url: string; markdown: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [showCode, setShowCode] = useState(false);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { closeButton.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    let disposed = false;
    let url: string | undefined;
    setError(null);
    setLoaded(null);
    void readCreateAttachmentPreview(attachment).then(async preview => {
      if (disposed) return;
      let markdown = "";
      if (preview.kind === "markdown") {
        // Only the active preview needs the browser Markdown renderer. Cold
        // and paused Create routes do not initialize its DOM hooks.
        const { renderMarkdown } = await import("../../features/agent/markdown");
        if (disposed) return;
        markdown = DOMPurify.sanitize(renderMarkdown(preview.text ?? ""), {
          // Drafts have no asset root. Documents must not load trackers,
          // embed executable content or style controls outside the preview.
          FORBID_TAGS: ["style", "img", "video", "audio", "iframe", "object", "embed", "svg", "math", "form", "input", "button", "textarea", "select"],
          FORBID_ATTR: ["style", "class", "id", "name", "src", "srcset"],
        });
      }
      url = URL.createObjectURL(preview.blob);
      setLoaded({ preview, url, markdown });
    }).catch(() => {
      if (!disposed) setError("This attachment couldn't be opened. Retry, or attach the file again.");
    });
    return () => {
      disposed = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [attachment, attempt]);
  const preview = loaded?.preview;
  const mediaFailed = () => setError("This format can't be previewed here. You can download the attachment to open it.");
  return (
    <Tabs value={showCode ? "code" : "preview"} onValueChange={value => setShowCode(value === "code")} asChild>
    <aside
      aria-label="Attachment preview"
      data-create-attachment-preview=""
      className="border-border1 bg-bg1 flex h-full min-h-0 w-1/2 min-w-0 shrink-0 flex-col border-l"
      onKeyDown={event => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <PanelHeader size="window">
        <FileTypeIcon name={attachment.name} size={14} />
        <span className="text-fg1 min-w-0 flex-1 truncate text-xs" title={attachment.name}>{attachment.name}</span>
        {preview?.kind === "markdown" && (
          <TabsList aria-label="Markdown view" className="h-7 shrink-0 rounded-md p-0.5">
            <TabsTrigger value="preview" className="h-6 rounded-sm px-2 py-0 text-xs">Preview</TabsTrigger>
            <TabsTrigger value="code" className="h-6 rounded-sm px-2 py-0 text-xs">Code</TabsTrigger>
          </TabsList>
        )}
        {loaded && (
          <Tooltip label="Download attachment">
            <Button variant="ghost" size="icon-sm" asChild>
              <a href={loaded.url} download={attachment.name} aria-label="Download attachment"><Download size={14} /></a>
            </Button>
          </Tooltip>
        )}
        <Tooltip label="Close preview">
          <Button type="button" ref={closeButton} variant="ghost" size="icon-sm" aria-label="Close attachment preview" onClick={onClose}><X size={14} /></Button>
        </Tooltip>
      </PanelHeader>
      <WorkbenchTabBanner type="files" singleFile active busy={!loaded && !error}
        status={error ? { tone: "error", message: error, action: "Retry" } : null}
        retry={() => setAttempt(value => value + 1)} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto" aria-busy={!loaded && !error || undefined}>
        {!loaded && <WorkbenchEmptyState type="files" message={error ? "Attachment preview unavailable." : "Opening attachment…"} />}
        {loaded && !error && preview?.kind === "markdown" && (
          <TabsContent value="preview" className="zeros-agent-md text-fg1 m-0 min-w-0 select-text p-5 text-sm">
            <div className="zeros-md-prose" dangerouslySetInnerHTML={{ __html: loaded.markdown }} />
          </TabsContent>
        )}
        {loaded && !error && preview?.kind === "markdown" && (
          <TabsContent value="code" className="m-0 min-w-0" asChild>
            <pre className="text-fg1 select-text p-4 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap"><code>{preview.text}</code></pre>
          </TabsContent>
        )}
        {loaded && !error && preview?.kind === "text" && (
          <pre className="text-fg1 m-0 min-w-0 select-text p-4 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap"><code>{preview.text}</code></pre>
        )}
        {preview?.truncated && <p className="text-fg3 px-4 py-2 text-xs">Preview limited to the first 1 MB. Download the attachment to read the full file.</p>}
        {loaded && !error && preview?.kind === "image" && (
          <div className="flex min-h-0 flex-1 items-center justify-center p-4"><img src={loaded.url} alt={attachment.name} className="max-h-full max-w-full object-contain" onError={mediaFailed} /></div>
        )}
        {loaded && !error && preview?.kind === "video" && (
          <div className="flex min-h-0 flex-1 items-center justify-center p-4"><video src={loaded.url} controls preload="metadata" className="max-h-full max-w-full" aria-label={attachment.name} onError={mediaFailed} /></div>
        )}
        {loaded && !error && preview?.kind === "audio" && (
          <div className="flex flex-1 items-center justify-center p-4"><audio src={loaded.url} controls preload="metadata" className="w-full" aria-label={attachment.name} onError={mediaFailed} /></div>
        )}
        {loaded && (error || preview?.kind === "unsupported") && <WorkbenchEmptyState type="files" message="Download this attachment to view it. It will still be included when you create the workspace." />}
      </div>
    </aside>
    </Tabs>
  );
}
