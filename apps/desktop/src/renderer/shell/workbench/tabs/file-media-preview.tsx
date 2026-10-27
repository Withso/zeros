import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Copy,
  Download,
  Minus,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Volume2,
  VolumeX,
} from "lucide-react";
import { IconButton, Input, Tooltip } from "@/renderer/shared/ui/primitives";
import { toast } from "@/renderer/shared/ui/primitives/elements";
import { useDocumentActive } from "@/renderer/state/use-document-active";
import { WorkbenchEmptyState } from "../tab-status";
import { WORKBENCH_TITLE_ACTION_CLS } from "../tab-chrome";
import { copyFileMediaImage } from "./file-media-actions";
import { useFileMediaViewport } from "./file-media-viewport";
import { cn } from "@/renderer/shared/ui/cn";

interface FileMediaPreviewProps {
  kind: "image" | "video";
  source: string;
  path: string;
  active: boolean;
  actionsContainer: HTMLElement | null;
}

/** Owns only this file's transient camera and media lifetime. FileViewer keys
 * it by workspace/tab/path/revision; the existing read cache owns source bytes. */
export function FileMediaPreview({
  kind,
  source,
  path,
  active,
  actionsContainer,
}: FileMediaPreviewProps) {
  const visible = useDocumentActive(active);
  const [displayedSource, setDisplayedSource] = useState<string | null>(
    visible ? source : null,
  );
  // A warm file snapshot must not start a hidden decoder. Admit in the same
  // render when selected; retain a visited source only while it is still current.
  const nextDisplayedSource = visible
    ? source
    : displayedSource === source
      ? displayedSource
      : null;
  if (displayedSource !== nextDisplayedSource)
    setDisplayedSource(nextDisplayedSource);
  const [media, setMedia] = useState<
    HTMLImageElement | HTMLVideoElement | null
  >(null);
  const [loaded, setLoaded] = useState<{
    source: string;
    error: boolean;
  } | null>(null);
  if (loaded && loaded.source !== source) setLoaded(null);
  const [copying, setCopying] = useState<AbortController | null>(null);
  const pendingCopy = useRef<AbortController | null>(null);
  const ready = loaded?.source === source && !loaded.error;
  const failed = loaded?.source === source && loaded.error;
  const camera = useFileMediaViewport(media, source, visible, ready);

  useLayoutEffect(() => {
    if (!visible && media?.tagName === "VIDEO")
      (media as HTMLVideoElement).pause();
    return () => {
      pendingCopy.current?.abort();
      pendingCopy.current = null;
      if (media?.tagName === "VIDEO") (media as HTMLVideoElement).pause();
    };
  }, [media, source, visible]);

  const copy = () => {
    if (!media || !visible || !ready || pendingCopy.current) return;
    const controller = new AbortController();
    pendingCopy.current = controller;
    setCopying(controller);
    void copyFileMediaImage(media, source, controller.signal)
      .then(() => {
        if (!controller.signal.aborted)
          toast.success(
            kind === "video" ? "Video frame copied" : "Image copied",
          );
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          toast.error("Couldn't copy image", {
            description:
              error instanceof Error && error.name !== "NotAllowedError"
                ? error.message
                : "Allow clipboard access or download the file instead.",
          });
      })
      .finally(() => {
        if (pendingCopy.current === controller) {
          pendingCopy.current = null;
          setCopying(null);
        }
      });
  };
  const copyLabel = kind === "video" ? "Copy current frame" : "Copy image";
  const downloadLabel = kind === "video" ? "Download video" : "Download image";
  const loadedMedia = () => {
    if (displayedSource) setLoaded({ source: displayedSource, error: false });
  };
  const failedMedia = () => {
    if (displayedSource) setLoaded({ source: displayedSource, error: true });
  };

  return (
    <div
      data-file-media-preview={kind}
      className="flex h-full min-h-0 flex-col overflow-hidden"
    >
      {actionsContainer &&
        active &&
        createPortal(
          <>
            <Tooltip label={copyLabel}>
              <IconButton
                label={copyLabel}
                size="compact"
                className={WORKBENCH_TITLE_ACTION_CLS}
                disabled={
                  !ready || (!!copying && !copying.signal.aborted) || !visible
                }
                onClick={copy}
              >
                <Copy className="size-3.5" />
              </IconButton>
            </Tooltip>
            <Tooltip label={downloadLabel}>
              <IconButton
                label={downloadLabel}
                size="compact"
                className={WORKBENCH_TITLE_ACTION_CLS}
                asChild
              >
                <a href={source} download={path.split("/").pop()}>
                  <Download className="size-3.5" />
                </a>
              </IconButton>
            </Tooltip>
          </>,
          actionsContainer,
        )}
      <div
        ref={camera.viewport}
        data-testid="file-media-viewport"
        role="region"
        aria-label={`${kind === "video" ? "Video" : "Image"} preview. Drag to pan; scroll to zoom.`}
        aria-keyshortcuts="+ - 0 ArrowLeft ArrowRight ArrowUp ArrowDown"
        tabIndex={visible && ready ? 0 : -1}
        className={cn(
          "focus-visible:outline-highlighted-bright relative flex min-h-0 flex-1 touch-none items-center justify-center overflow-hidden p-4 -outline-offset-2 focus-visible:outline-2 data-[dragging=true]:cursor-grabbing",
          ready ? "cursor-grab" : "cursor-default",
        )}
      >
        {failed && (
          <WorkbenchEmptyState
            type="files"
            message={`This ${kind} can't be previewed. Download it to open it.`}
          />
        )}
        {displayedSource &&
          (kind === "image" ? (
            <img
              ref={setMedia}
              src={displayedSource}
              alt={path}
              draggable={false}
              onLoad={loadedMedia}
              onError={failedMedia}
              className="max-h-full max-w-full shrink-0 object-contain select-none"
              hidden={!!failed}
            />
          ) : (
            <video
              ref={setMedia}
              src={displayedSource}
              aria-label={path}
              playsInline
              preload="metadata"
              draggable={false}
              onLoadedData={loadedMedia}
              onError={failedMedia}
              className="max-h-full max-w-full shrink-0 object-contain select-none"
              hidden={!!failed}
            />
          ))}
      </div>
      <div className="relative z-1 flex shrink-0 flex-wrap items-center gap-2 px-3 pb-3">
        <div
          role="group"
          aria-label="Preview zoom"
          className="border-border2 bg-bg2 text-fg2 flex shrink-0 items-center gap-1 rounded-lg border p-1 shadow-[var(--shadow-dropdown)]"
        >
          <Tooltip label="Zoom out">
            <IconButton
              ref={camera.zoomOut}
              label="Zoom out"
              size="compact"
              disabled={!ready || !visible}
              onClick={() => camera.actions.current.zoomOut()}
            >
              <Minus className="size-3.5" />
            </IconButton>
          </Tooltip>
          <output
            ref={camera.percentage}
            aria-label="Zoom percentage"
            aria-live="off"
            className="w-10 text-center text-xs tabular-nums"
          >
            100%
          </output>
          <Tooltip label="Zoom in">
            <IconButton
              ref={camera.zoomIn}
              label="Zoom in"
              size="compact"
              disabled={!ready || !visible}
              onClick={() => camera.actions.current.zoomIn()}
            >
              <Plus className="size-3.5" />
            </IconButton>
          </Tooltip>
          <Tooltip label="Reset zoom and position (100%)">
            <IconButton
              label="Reset zoom and position"
              size="compact"
              disabled={!ready || !visible}
              onClick={() => camera.actions.current.reset()}
            >
              <RotateCcw className="size-3.5" />
            </IconButton>
          </Tooltip>
        </div>
        {kind === "video" && media && (
          <FileVideoControls
            video={media as HTMLVideoElement}
            active={visible}
            ready={ready}
            source={source}
          />
        )}
      </div>
    </div>
  );
}

function videoTime(seconds: number) {
  const value = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

/** Native events drive this small control strip only while visible. There is
 * no time polling, and playback never reconciles the preview or its camera. */
function FileVideoControls({
  video,
  active,
  ready,
  source,
}: {
  video: HTMLVideoElement;
  active: boolean;
  ready: boolean;
  source: string;
}) {
  const [state, setState] = useState({
    playing: false,
    time: 0,
    duration: 0,
    muted: false,
  });
  const generation = useRef(0);
  useLayoutEffect(() => {
    generation.current += 1;
    return () => {
      generation.current += 1;
    };
  }, [video, active, source]);
  useEffect(() => {
    if (!active) return;
    const update = () =>
      setState({
        playing: !video.paused && !video.ended,
        time: video.currentTime,
        duration: video.duration,
        muted: video.muted,
      });
    update();
    const events = [
      "play",
      "pause",
      "ended",
      "timeupdate",
      "durationchange",
      "loadedmetadata",
      "volumechange",
    ];
    for (const event of events) video.addEventListener(event, update);
    return () => {
      for (const event of events) video.removeEventListener(event, update);
    };
  }, [video, active, source]);
  const playingLabel = state.playing ? "Pause video" : "Play video";
  const duration = Number.isFinite(state.duration) ? state.duration : 0;
  return (
    <div
      role="group"
      aria-label="Video playback"
      className="border-border2 bg-bg2 text-fg2 flex min-w-0 flex-1 basis-48 items-center gap-2 rounded-lg border p-1"
    >
      <Tooltip label={playingLabel}>
        <IconButton
          label={playingLabel}
          size="compact"
          className="shrink-0"
          disabled={!ready || !active}
          onClick={() => {
            if (!video.paused) video.pause();
            else {
              const started = generation.current;
              void video.play().catch(() => {
                if (active && generation.current === started)
                  toast.error("This video couldn't be played.");
              });
            }
          }}
        >
          {state.playing ? (
            <Pause className="size-3.5" />
          ) : (
            <Play className="size-3.5" />
          )}
        </IconButton>
      </Tooltip>
      <Input
        type="range"
        min={0}
        max={duration || 1}
        step={0.1}
        value={Math.min(state.time, duration)}
        disabled={!active || !ready || !duration}
        aria-label="Seek video"
        aria-valuetext={`${videoTime(state.time)} of ${videoTime(duration)}`}
        className="accent-fg1 focus-visible:outline-highlighted-bright h-6 min-w-12 flex-1 cursor-pointer border-0 px-0 py-0 shadow-none focus-visible:outline-2"
        onChange={(event) => {
          const time = Number(event.currentTarget.value);
          video.currentTime = time;
          // A controlled range must publish its input synchronously. Waiting
          // for timeupdate lets React restore the old value between input/change.
          setState((current) => ({ ...current, time }));
        }}
      />
      <span className="text-xxs shrink-0 tabular-nums">
        {videoTime(state.time)} / {videoTime(duration)}
      </span>
      <Tooltip label={state.muted ? "Unmute video" : "Mute video"}>
        <IconButton
          label={state.muted ? "Unmute video" : "Mute video"}
          size="compact"
          className="shrink-0"
          disabled={!ready || !active}
          onClick={() => {
            video.muted = !video.muted;
          }}
        >
          {state.muted ? (
            <VolumeX className="size-3.5" />
          ) : (
            <Volume2 className="size-3.5" />
          )}
        </IconButton>
      </Tooltip>
    </div>
  );
}
