import { useEffect, useState, type ReactElement } from "react";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/renderer/shared/ui/primitives";
import {
  loadWorkspaceFileRead,
  prefetchWorkspaceFileRead,
  useWorkspaceFileReadSnapshot,
} from "@/renderer/shell/workspace-file-data-cache";
import { filePillPath } from "@/renderer/shell/workbench/file-pill-navigation";
import type { FileMediaDescriptor } from "@zeros/protocol/file-media";
import { openWorkspaceMedia, type FileMediaLease } from "@/renderer/platform/file-media";
import { workspaceFileAccessKey } from "@/renderer/platform/workspace-file-scope";

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jfif: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
  heic: "image/heic",
  heif: "image/heif",
  tif: "image/tiff",
  tiff: "image/tiff",
};
// Hover keeps its own small bound; larger images can be opened in Files without
// decoding them just because the pointer crossed an attachment.
const MAX_IMAGE_PREVIEW_BYTES = 5 * 1024 * 1024;

export function imagePreviewMimeType(
  name: string,
  mimeType?: string,
): string | null {
  const mime = mimeType?.split(";", 1)[0].trim().toLowerCase();
  if (mime?.startsWith("video/")) return null;
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  return (
    (Object.hasOwn(IMAGE_MIME, extension) ? IMAGE_MIME[extension] : null) ??
    (mime?.startsWith("image/") ? mime : null)
  );
}

interface ImageHoverCardProps {
  name: string;
  cwd?: string | null;
  path?: string;
  mimeType?: string;
  sourceFile?: Blob;
  legacyUri?: string;
  enabled?: boolean;
  /** Upload/validation details remain visible alongside the image. */
  status?: string;
  children: ReactElement;
}

/** The card owns its image only while open. SVGs stay in an img document,
 * GIFs keep their original bytes/animation, and no authored markup executes. */
export function ImageHoverCard({
  enabled = true,
  children,
  ...source
}: ImageHoverCardProps) {
  const [requestedOpen, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const path = source.path ? filePillPath(source.cwd, source.path) : null;
  const interactive = enabled && !dismissed;
  const open = interactive && requestedOpen;
  useEffect(() => {
    if (!enabled) {
      setOpen(false);
      setDismissed(true);
    }
  }, [enabled]);
  const warm = () => {
    setDismissed(false);
    if (enabled && !source.sourceFile && !source.legacyUri && path)
      prefetchWorkspaceFileRead(source.cwd ?? undefined, path);
  };
  return (
    <HoverCard
      enabled={interactive}
      open={open}
      onOpenChange={setOpen}
      openDelay={350}
      closeDelay={120}
    >
      <HoverCardTrigger
        asChild
        onPointerEnter={warm}
        onFocus={warm}
        onClick={() => { setOpen(false); setDismissed(true); }}
      >
        {children}
      </HoverCardTrigger>
      <HoverCardContent
        side="top"
        align="start"
        collisionPadding={12}
        className="w-[450px] max-w-[calc(100vw-24px)] overflow-hidden p-1"
      >
        <ImagePreviewContent
          key={JSON.stringify([source.cwd, path, source.name])}
          {...source}
          path={path ?? undefined}
        />
      </HoverCardContent>
    </HoverCard>
  );
}

function ImagePreviewContent({
  name,
  cwd,
  path,
  mimeType,
  sourceFile,
  legacyUri,
  status,
}: Omit<ImageHoverCardProps, "children" | "enabled">) {
  const mime = imagePreviewMimeType(name, mimeType);
  const [blobSource, setBlobSource] = useState<{
    blob: Blob;
    uri: string;
  } | null>(null);
  const tooLarge = !!sourceFile && sourceFile.size > MAX_IMAGE_PREVIEW_BYTES;
  useEffect(() => {
    if (!sourceFile || tooLarge || !mime) return;
    const uri = URL.createObjectURL(sourceFile.slice(0, sourceFile.size, mime));
    setBlobSource({ blob: sourceFile, uri });
    return () => URL.revokeObjectURL(uri);
  }, [sourceFile, tooLarge, mime]);
  const localSource = sourceFile
    ? blobSource?.blob === sourceFile
      ? blobSource.uri
      : undefined
    : legacyUri;
  return (
    <section
      data-image-hover-preview=""
      aria-label={`Image preview for ${name}`}
      className="flex min-w-0 flex-col gap-1"
    >
      {tooLarge ? (
        <PreviewUnavailable message="Image is too large to preview" />
      ) : localSource ? (
        <PreviewImage key={localSource} source={localSource} name={name} />
      ) : !sourceFile && cwd && path ? (
        <DiskImagePreview cwd={cwd} path={path} name={name} />
      ) : (
        <PreviewUnavailable
          message={sourceFile ? "Loading image…" : "Image preview unavailable"}
        />
      )}
      <div className="text-fg2 px-1 py-0.5 text-xs">
        <div className="truncate" title={name}>
          {name}
        </div>
        {status && status !== name && (
          <div className="text-fg3 break-words">{status}</div>
        )}
      </div>
    </section>
  );
}

function DiskImagePreview({
  cwd,
  path,
  name,
}: {
  cwd: string;
  path: string;
  name: string;
}) {
  const snapshot = useWorkspaceFileReadSnapshot({ cwd, path });
  useEffect(() => {
    void loadWorkspaceFileRead({ cwd, path }, { maxAgeMs: 15_000 }).catch(
      () => {},
    );
  }, [cwd, path]);
  if (snapshot.data?.kind === "image" && snapshot.data.bytes > MAX_IMAGE_PREVIEW_BYTES)
    return <PreviewUnavailable message="Image is too large to preview" />;
  if (snapshot.data?.kind === "image" && snapshot.data.dataUrl)
    return (
      <PreviewImage
        key={snapshot.data.dataUrl}
        source={snapshot.data.dataUrl}
        name={name}
      />
    );
  if (snapshot.data?.kind === "image" && snapshot.data.media)
    return (
      <StreamedImagePreview
        key={JSON.stringify([workspaceFileAccessKey(cwd), path, snapshot.data.bytes, snapshot.data.media])}
        cwd={cwd}
        path={path}
        bytes={snapshot.data.bytes}
        media={snapshot.data.media}
        name={name}
      />
    );
  return (
    <PreviewUnavailable
      message={
        snapshot.data?.kind === "too-large"
          ? "Image is too large to preview"
          : snapshot.data || snapshot.error
            ? "Image preview unavailable"
            : "Loading image…"
      }
    />
  );
}

/** The shared read cache retains metadata. The open hover alone owns this
 * native URL, including when a pending open finishes after dismissal. */
function StreamedImagePreview({ cwd, path, bytes, media: { version, mimeType }, name }: {
  cwd: string;
  path: string;
  bytes: number;
  media: FileMediaDescriptor;
  name: string;
}) {
  const [source, setSource] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let lease: FileMediaLease | undefined;
    void openWorkspaceMedia({ cwd, path, bytes, media: { version, mimeType } }).then(value => {
      lease = value;
      if (cancelled) value.release();
      else setSource(value.url);
    }, () => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; lease?.release(); };
  }, [cwd, path, bytes, version, mimeType]);
  return source ? <PreviewImage source={source} name={name} /> :
    <PreviewUnavailable message={failed ? "Image preview unavailable" : "Loading image…"} />;
}

function PreviewImage({ source, name }: { source: string; name: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <PreviewUnavailable message="Image preview unavailable" />;
  return (
    <img
      src={source}
      alt={name}
      onError={() => setFailed(true)}
      className="bg-bg1 max-h-[300px] w-full rounded-sm object-contain"
    />
  );
}

function PreviewUnavailable({ message }: { message: string }) {
  return (
    <div
      className="text-fg3 flex min-h-20 items-center justify-center px-3 py-4 text-xs"
      role="status"
    >
      {message}
    </div>
  );
}
