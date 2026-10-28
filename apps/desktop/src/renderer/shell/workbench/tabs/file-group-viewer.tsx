import { useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, PanelLeft } from "lucide-react";
import { Button, IconButton } from "@/renderer/shared/ui/primitives";
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
  return (
    <div
      ref={host}
      data-file-group-viewer=""
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col"
    >
      <div className="border-border1 flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <IconButton
          label="Toggle attached files"
          aria-pressed={showSidebar}
          size="compact"
          disabled={!active}
          onClick={() => setSidebar(!showSidebar)}
        >
          <PanelLeft className="size-3.5" />
        </IconButton>
        <span className="text-fg1 min-w-0 truncate text-xs">{group.name}</span>
        <span className="text-fg3 text-xxs shrink-0">
          {group.files.length} files
        </span>
        <div className="flex-1" />
        <IconButton
          label="Previous file"
          size="compact"
          disabled={!active || index === 0}
          onClick={() => onSelect(group.files[index - 1].path)}
        >
          <ChevronLeft className="size-3.5" />
        </IconButton>
        <span className="text-fg3 text-xxs shrink-0 tabular-nums">
          {index + 1} / {group.files.length}
        </span>
        <IconButton
          label="Next file"
          size="compact"
          disabled={!active || index === group.files.length - 1}
          onClick={() => onSelect(group.files[index + 1].path)}
        >
          <ChevronRight className="size-3.5" />
        </IconButton>
      </div>
      <div className="flex min-h-0 flex-1">
        {showSidebar && (
          <nav
            aria-label="Attached files"
            className="border-border1 w-48 shrink-0 overflow-y-auto border-r p-2"
          >
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
                className={`mb-1 flex w-full justify-start gap-2 px-2 ${position === index ? "bg-bg1-hover text-fg1" : "text-fg2"}`}
              >
                <FileTypeIcon name={file.name} kind="file" size={13} />
                <span className="min-w-0 truncate text-xs">{file.name}</span>
              </Button>
            ))}
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
          />
        </div>
      </div>
    </div>
  );
}
