import { useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, PanelLeft } from "lucide-react";
import { Button, IconButton } from "@/renderer/shared/ui/primitives";
import { cn } from "@/renderer/shared/ui/cn";
import { FileTypeIcon } from "@/renderer/features/agent/composer-editor/file-type-icon";
import { useAttachmentPillFile } from "@/renderer/features/agent/attachment-pill-file";
import { FileViewer } from "./file-viewer";
import { warmFilePill } from "../file-pill-navigation";
import type { FileGroup } from "../file-group";

export function FileGroupViewer({
  group,
  path,
  cwd,
  active,
  tabId,
  refreshKey,
  onSelect,
}: {
  group: FileGroup;
  path: string;
  cwd?: string;
  active: boolean;
  tabId: string;
  refreshKey: number;
  onSelect(path: string): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);
  const [sidebar, setSidebar] = useState<boolean | null>(null);
  const showSidebar = sidebar ?? wide;
  useLayoutEffect(() => {
    if (!active || !host.current) return;
    const observer = new ResizeObserver(([entry]) =>
      setWide(entry.contentRect.width >= 600),
    );
    observer.observe(host.current);
    return () => observer.disconnect();
  }, [active]);
  const index = Math.max(
    0,
    group.files.findIndex((file) => file.path === path),
  );
  const current = group.files[index];
  const resolved = useAttachmentPillFile({
    cwd,
    diskPath: current.path,
    attachmentId: current.attachmentId,
    enabled: active,
  });
  // One bar: the group's toggle and stepper ride in the file's own header,
  // and the group's name heads its side list, level with that header.
  return (
    <div
      ref={host}
      data-file-group-viewer=""
      className="flex h-full min-h-0 min-w-0 flex-1"
    >
      {showSidebar && (
        <nav
          aria-label="Attached files"
          className="border-border1 flex w-48 shrink-0 flex-col border-r"
        >
          <div className="border-border1 flex h-9 shrink-0 items-center gap-2 border-b px-3">
            <span className="text-fg1 min-w-0 truncate text-xs">
              {group.name}
            </span>
            <span className="text-fg3 text-3xxs shrink-0 leading-4">
              {group.files.length} files
            </span>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-1">
            {group.files.map((file, position) => (
              <Button
                key={`${position}:${file.path}`}
                variant="ghost"
                aria-label={`Open ${file.name}`}
                aria-current={position === index ? "page" : undefined}
                disabled={!active}
                onClick={() => onSelect(file.path)}
                onPointerEnter={() => warmFilePill(cwd, file.path)}
                onFocus={() => warmFilePill(cwd, file.path)}
                className={cn(
                  "w-full shrink-0 justify-start gap-2 px-2 font-normal",
                  position === index ? "bg-bg2-highlight text-fg1" : "text-fg2",
                )}
              >
                <FileTypeIcon name={file.name} kind="file" size={14} />
                <span className="min-w-0 truncate">{file.name}</span>
              </Button>
            ))}
          </div>
        </nav>
      )}
      <div className="min-h-0 min-w-0 flex-1">
        <FileViewer
          tabId={`${tabId}:${current.path}`}
          cwd={cwd}
          path={resolved.path ?? current.path}
          active={active}
          refreshKey={refreshKey}
          headerBorder
          headerLeading={
            <IconButton
              label="Toggle attached files"
              aria-pressed={showSidebar}
              pressedTone="fill"
              size="standard"
              disabled={!active}
              onClick={() => setSidebar(!showSidebar)}
            >
              <PanelLeft />
            </IconButton>
          }
          headerTrailing={
            <>
              <IconButton
                label="Previous file"
                size="standard"
                disabled={!active || index === 0}
                onClick={() => onSelect(group.files[index - 1].path)}
              >
                <ChevronLeft />
              </IconButton>
              <span className="text-fg3 text-3xxs shrink-0 leading-4 tabular-nums">
                {index + 1} / {group.files.length}
              </span>
              <IconButton
                label="Next file"
                size="standard"
                disabled={!active || index === group.files.length - 1}
                onClick={() => onSelect(group.files[index + 1].path)}
              >
                <ChevronRight />
              </IconButton>
            </>
          }
        />
      </div>
    </div>
  );
}
