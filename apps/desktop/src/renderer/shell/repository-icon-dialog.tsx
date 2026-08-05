import { useEffect, useMemo, useRef, useState } from "react";
import { ImageUp, RotateCw, Search } from "lucide-react";

import type { Project } from "../state/projects-store";
import {
  setRepositoryIconChoice,
  useAutomaticRepositoryIcon,
  useRepositoryIconChoice,
  type RepositoryIconChoice,
} from "../features/repositories/repository-icons";
import { cn } from "../shared/ui/cn";
import { ZerosSpinner } from "@/renderer/shared/ui/loading";
import {
  automaticRepositoryIconLabel,
  RepositoryIconGraphic,
  REPOSITORY_EMOJIS,
  REPOSITORY_ICONS,
} from "../features/repositories/repository-icon";
import { Button } from "../shared/ui/primitives/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../shared/ui/primitives/dialog";
import { Input } from "../shared/ui/primitives/input";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../shared/ui/primitives/tabs";
import { toast } from "../shared/ui/primitives/elements";
import { Tooltip } from "../shared/ui/primitives/tooltip";

const MAX_UPLOAD_BYTES = 5_000_000;
const MAX_STORED_EDGE = 256;
const ACCEPTED_UPLOAD_TYPES = new Set(["image/png", "image/jpeg"]);

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () =>
      reject(new Error("The selected image could not be read."));
    image.src = url;
  });
}

/** Validate and downsample uploads before localStorage persistence. This keeps a
 *  multi-repository icon collection well below browser storage quotas while
 *  preserving transparency for PNG logos. */
export async function normalizeRepositoryIconUpload(
  file: File,
): Promise<string> {
  if (!ACCEPTED_UPLOAD_TYPES.has(file.type)) {
    throw new Error("Choose a PNG or JPEG image.");
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error("Choose an image smaller than 5 MB.");
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await loadImage(objectUrl);
    if (!image.naturalWidth || !image.naturalHeight) {
      throw new Error("The selected image has invalid dimensions.");
    }
    const scale = Math.min(
      1,
      MAX_STORED_EDGE / Math.max(image.naturalWidth, image.naturalHeight),
    );
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image processing is unavailable.");
    context.drawImage(image, 0, 0, width, height);
    const dataUrl = canvas.toDataURL(
      file.type,
      file.type === "image/jpeg" ? 0.9 : undefined,
    );
    if (!/^data:image\/(?:png|jpeg);base64,/i.test(dataUrl)) {
      throw new Error("The selected image could not be processed.");
    }
    return dataUrl;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

interface RepositoryIconDialogProps {
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function RepositoryIconDialog({
  project,
  open,
  onOpenChange,
}: RepositoryIconDialogProps) {
  const [tab, setTab] = useState("icons");
  const [query, setQuery] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const iconListRef = useRef<HTMLDivElement | null>(null);
  const choice = useRepositoryIconChoice(project.repoRoot);
  const automatic = useAutomaticRepositoryIcon(
    project.repoRoot,
    project.originUrl,
    open,
  );

  useEffect(() => {
    if (!open) {
      setTab("icons");
      setQuery("");
      setUploading(false);
    }
  }, [open]);

  // On open (Icons tab), bring the current selection into view — it can sit far
  // down the scroll list. Scroll only, so the autofocused search keeps focus;
  // not keyed on `query`, so searching doesn't yank the list. Matches the
  // "open on the selected item" behaviour of the app's menus/dropdowns.
  useEffect(() => {
    if (!open || tab !== "icons") return;
    const raf = requestAnimationFrame(() => {
      iconListRef.current
        ?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')
        ?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(raf);
  }, [open, tab]);

  const filteredIcons = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return REPOSITORY_ICONS;
    return REPOSITORY_ICONS.filter(
      (icon) =>
        icon.label.toLowerCase().includes(normalized) ||
        icon.name.includes(normalized) ||
        icon.keywords.some((keyword) => keyword.includes(normalized)),
    );
  }, [query]);

  const filteredEmojis = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return REPOSITORY_EMOJIS;
    return REPOSITORY_EMOJIS.filter(
      (emoji) =>
        emoji.label.toLowerCase().includes(normalized) ||
        emoji.keywords.some((keyword) => keyword.includes(normalized)),
    );
  }, [query]);

  const choose = (next: RepositoryIconChoice) => {
    setRepositoryIconChoice(project.repoRoot, next);
    onOpenChange(false);
  };

  const handleUpload = async (file: File | undefined) => {
    if (!file || uploading) return;
    setUploading(true);
    try {
      const dataUrl = await normalizeRepositoryIconUpload(file);
      choose({ kind: "upload", dataUrl });
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Couldn't use that image.",
      );
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(620px,calc(100vh-48px))] max-w-xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="px-5 pt-5">
          <DialogTitle className="text-base">
            Change icon for {project.name}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Choose an icon or emoji, use an icon discovered in the repository,
            or upload a PNG or JPEG.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={setTab} className="min-h-0">
          <TabsList className="border-border1 mt-3 h-auto w-full justify-start rounded-none border-b bg-transparent px-4 py-0">
            <TabsTrigger
              value="icons"
              className="data-[state=active]:border-fg1 rounded-none border-b-2 border-transparent bg-transparent px-3 py-2 text-xs shadow-none data-[state=active]:bg-transparent data-[state=active]:shadow-none"
            >
              Icons
            </TabsTrigger>
            <TabsTrigger
              value="upload"
              className="data-[state=active]:border-fg1 rounded-none border-b-2 border-transparent bg-transparent px-3 py-2 text-xs shadow-none data-[state=active]:bg-transparent data-[state=active]:shadow-none"
            >
              Upload
            </TabsTrigger>
          </TabsList>

          <TabsContent value="icons" className="mt-0 min-h-0 outline-none">
            <div className="border-border1 border-b p-3">
              <div className="relative">
                <Search className="text-fg2 pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
                <Input
                  autoFocus
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search icons and emojis"
                  aria-label="Search icons and emojis"
                  className="h-7 pl-8 text-xs"
                />
              </div>
            </div>
            <div
              ref={iconListRef}
              className="max-h-[390px] overflow-y-auto p-3"
            >
              <div
                role="listbox"
                aria-label="Repository icons and emojis"
                className="grid grid-cols-9 gap-1"
              >
                {filteredIcons.map((icon) => {
                  const selected =
                    choice?.kind === "lucide" && choice.value === icon.name;
                  return (
                    <Tooltip key={icon.name} label={icon.label}>
                      <button
                        type="button"
                        role="option"
                        aria-label={icon.label}
                        aria-selected={selected}
                        onClick={() =>
                          choose({ kind: "lucide", value: icon.name })
                        }
                        className={cn(
                          "text-fg2 hover:bg-bg1-hover hover:text-fg1 focus-visible:ring-highlighted-bright inline-flex size-9 items-center justify-center rounded-sm transition-colors focus-visible:ring-1 focus-visible:outline-none",
                          selected && "bg-bg1-hover text-fg1",
                        )}
                      >
                        <icon.Icon className="size-4" strokeWidth={1.5} />
                      </button>
                    </Tooltip>
                  );
                })}
                {filteredEmojis.map((emoji) => {
                  const selected =
                    choice?.kind === "emoji" && choice.value === emoji.value;
                  return (
                    <Tooltip key={emoji.value} label={emoji.label}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={selected}
                        onClick={() =>
                          choose({ kind: "emoji", value: emoji.value })
                        }
                        className={cn(
                          "hover:bg-bg1-hover focus-visible:ring-highlighted-bright inline-flex size-9 items-center justify-center rounded-sm text-lg transition-colors focus-visible:ring-1 focus-visible:outline-none",
                          selected && "bg-bg1-hover",
                        )}
                      >
                        <span aria-hidden="true">{emoji.value}</span>
                        <span className="sr-only">{emoji.label}</span>
                      </button>
                    </Tooltip>
                  );
                })}
              </div>
              {filteredIcons.length === 0 && filteredEmojis.length === 0 && (
                <p className="text-fg3 py-8 text-center text-xs">
                  No icons or emojis match.
                </p>
              )}
            </div>
          </TabsContent>

          <TabsContent value="upload" className="mt-0 outline-none">
            <div className="flex flex-col items-center px-6 py-7 text-center">
              <RepositoryIconGraphic
                choice={null}
                automatic={automatic}
                name={project.name}
                className="bg-bg2-hover text-fg1 size-14 rounded-lg text-lg font-medium"
              />
              <span className="bg-bg2 text-fg1 mt-3 rounded-md px-3 py-1.5 text-xs">
                {automatic.loading || automatic.refreshing
                  ? "Finding repository icon…"
                  : automaticRepositoryIconLabel(automatic.source)}
              </span>
              {automatic.source?.kind === "repository-file" && (
                <code className="text-fg3 text-2xxs mt-2 max-w-full truncate">
                  {automatic.source.path}
                </code>
              )}
              <p className="text-fg2 mt-3 max-w-md text-xs leading-5">
                By default, Zeros uses the first common favicon, logo, or app
                icon found in the repository. If none exists, it uses the GitHub
                repository owner&apos;s avatar, then the repository initial.
              </p>
              <div className="mt-3 flex items-center gap-2">
                {choice && (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setRepositoryIconChoice(project.repoRoot, null);
                      onOpenChange(false);
                    }}
                  >
                    Use automatic
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Refresh automatic repository icon"
                  disabled={automatic.loading || automatic.refreshing}
                  onClick={automatic.refresh}
                >
                  {automatic.loading || automatic.refreshing ? (
                    <ZerosSpinner size={16} />
                  ) : (
                    <RotateCw className="size-3.5" />
                  )}
                </Button>
              </div>
            </div>

            <div className="border-border1 border-t px-6 py-5">
              <div className="flex items-start justify-between gap-5">
                <div>
                  <p className="text-fg1 text-sm font-medium">
                    Upload your own icon
                  </p>
                  <p className="text-fg2 mt-1 text-xs leading-5">
                    PNG or JPEG, up to 5 MB. Large images are resized locally
                    before they are saved.
                  </p>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  size="default"
                  disabled={uploading}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <ImageUp className="size-3.5" />
                  {uploading ? "Uploading…" : "Upload"}
                </Button>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,.png,.jpg,.jpeg"
                className="hidden"
                onChange={(event) => void handleUpload(event.target.files?.[0])}
              />
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
