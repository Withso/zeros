import { ChevronDown, File } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import {
  designPageTitleSchema,
  type DesignPageSummary,
} from "@zeros/protocol/design-pages";
import type { DesignCanvasFrameWire } from "../../platform/git";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  toast,
} from "../../shared/ui/primitives";
import { errorMessage } from "./design-workspace-error";
import {
  createDesignPageCached,
  deleteDesignPageCached,
  renameDesignPageCached,
} from "./state/design-workspace-cache";
import {
  bindDesignWorkspacePages,
  captureDesignPageOwner,
  isCurrentDesignPageOwner,
  useDesignWorkspaceUiStore,
} from "./state/design-workspace-ui";

/** Shared menu/dialog behavior owns focus; page switches publish no bridge read. */
export function DesignPagePicker({
  workspaceId,
  directoryId,
  pages,
  activePageId,
  frames,
  active,
}: {
  workspaceId: string;
  directoryId?: string;
  pages: readonly DesignPageSummary[];
  activePageId?: string;
  frames: readonly DesignCanvasFrameWire[];
  active: boolean;
}) {
  const page = pages.find((page) => page.id === activePageId) ?? pages[0];
  const [open, setOpen] = useState(false);
  const [rename, setRename] = useState<{
    page: DesignPageSummary;
    draft: string;
  } | null>(null);
  const [deletion, setDeletion] = useState<{
    page: DesignPageSummary;
    ids: string[];
  } | null>(null);
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const renameCancelled = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const owner = captureDesignPageOwner(workspaceId);
  const ownerKey = `${workspaceId}\0${directoryId ?? ""}\0${page.id}`;
  useLayoutEffect(() => {
    setOpen(false);
    setRename(null);
    setDeletion(null);
  }, [ownerKey, active]);

  const switchPage = (id: string) => {
    // A focused inspector field commits to its original target before the
    // synchronous projection swap. No persistence work blocks the click.
    const focused = document.activeElement;
    if (
      focused instanceof HTMLElement &&
      focused.closest("[data-design-inspector]")
    )
      focused.blur();
    useDesignWorkspaceUiStore
      .getState()
      .setActivePage(workspaceId, id, directoryId);
  };
  const create = async () => {
    if (submitting.current || !active) return;
    submitting.current = true;
    setPending(true);
    try {
      const result = await createDesignPageCached(workspaceId);
      if (!isCurrentDesignPageOwner(owner)) return;
      bindDesignWorkspacePages(
        workspaceId,
        result.snapshot.directoryId,
        result.snapshot.pages!,
      );
      switchPage(result.page.id);
    } catch (error) {
      toast.error("Couldn't create the Design page", {
        description: errorMessage(error),
      });
    } finally {
      submitting.current = false;
      setPending(false);
    }
  };
  const focusTrigger = () =>
    requestAnimationFrame(() => {
      if (isCurrentDesignPageOwner(owner)) triggerRef.current?.focus();
    });
  const submitRename = async (returnFocus = false) => {
    if (!rename || submitting.current || renameCancelled.current || !active)
      return;
    const parsed = designPageTitleSchema.safeParse(rename.draft);
    if (!parsed.success) {
      toast.error("Couldn't rename the Design page", {
        description: parsed.error.issues[0].message,
      });
      return;
    }
    if (parsed.data === rename.page.title) {
      setRename(null);
      if (returnFocus) focusTrigger();
      return;
    }
    submitting.current = true;
    setPending(true);
    try {
      await renameDesignPageCached(workspaceId, rename.page.id, parsed.data);
      if (isCurrentDesignPageOwner(owner)) {
        setRename(null);
        if (returnFocus) focusTrigger();
      }
    } catch (error) {
      toast.error("Couldn't rename the Design page", {
        description: errorMessage(error),
      });
    } finally {
      submitting.current = false;
      setPending(false);
    }
  };
  const remove = async (confirmed: {
    page: DesignPageSummary;
    ids: string[];
  }) => {
    if (submitting.current || !active) return;
    submitting.current = true;
    setPending(true);
    const index = pages.findIndex((page) => page.id === confirmed.page.id);
    const neighborId = pages[index + 1]?.id ?? pages[index - 1]?.id;
    try {
      await deleteDesignPageCached(
        workspaceId,
        confirmed.page.id,
        confirmed.ids,
        (snapshot) => {
          if (!isCurrentDesignPageOwner(owner)) return;
          if (neighborId) switchPage(neighborId);
          bindDesignWorkspacePages(
            workspaceId,
            snapshot.directoryId,
            snapshot.pages!,
          );
        },
      );
      setDeletion(null);
    } catch (error) {
      toast.error("Couldn't delete the Design page", {
        description: errorMessage(error),
      });
      setDeletion(null);
    } finally {
      submitting.current = false;
      setPending(false);
    }
  };
  const requestDelete = () => {
    const ids =
      page.frameIds ??
      page.frameFiles.map(
        (file) => frames.find((frame) => frame.file === file)?.frameId,
      );
    if (ids.some((id) => !id)) {
      toast.error("Couldn't delete the Design page", {
        description:
          "Frame membership is unavailable. Refresh the Design directory before deleting this page.",
      });
      return;
    }
    const confirmed = { page, ids: ids as string[] };
    if (ids.length) setDeletion(confirmed);
    else void remove(confirmed);
  };
  return (
    <>
      {rename ? (
        <div className="flex h-7 min-w-0 flex-1 items-center gap-2">
          <File className="text-fg2 size-3.5 shrink-0" aria-hidden="true" />
          <Input
            ref={inputRef}
            autoFocus
            aria-label="Page title"
            className="h-7 min-w-0 flex-1 text-xs"
            value={rename.draft}
            disabled={pending}
            maxLength={120}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) =>
              setRename({ ...rename, draft: event.target.value })
            }
            onBlur={() => void submitRename()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void submitRename(true);
              }
              if (event.key === "Escape") {
                event.preventDefault();
                renameCancelled.current = true;
                setRename(null);
                focusTrigger();
              }
            }}
          />
        </div>
      ) : (
        <DropdownMenu open={open && active} onOpenChange={setOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              ref={triggerRef}
              variant="ghost"
              size="sm"
              className="h-7 min-w-0 flex-1 justify-start gap-2 px-0 text-xs"
              aria-label={`Page: ${page.title}`}
              disabled={!active || pending}
            >
              <File className="text-fg2 size-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-left">
                {page.title}
              </span>
              <ChevronDown
                className="text-fg2 size-3.5 shrink-0"
                aria-hidden="true"
              />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="w-64"
            aria-label="Design pages"
            onCloseAutoFocus={(event) => {
              if (rename) {
                event.preventDefault();
                inputRef.current?.focus();
              }
            }}
          >
            {pages.map((candidate) => (
              <DropdownMenuCheckboxItem
                key={candidate.id}
                checked={candidate.id === page.id}
                className="h-7"
                onSelect={() => switchPage(candidate.id)}
              >
                <span className="truncate">{candidate.title}</span>
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="h-7"
              disabled={pending || pages.length >= 64}
              onSelect={() => void create()}
            >
              New page
            </DropdownMenuItem>
            <DropdownMenuItem
              className="h-7"
              disabled={pending}
              onSelect={() => {
                renameCancelled.current = false;
                setRename({ page, draft: page.title });
              }}
            >
              Rename page…
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-red-fg focus:text-red-fg h-7"
              disabled={pending || pages.length === 1}
              onSelect={requestDelete}
            >
              Delete page…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <Dialog
        open={!!deletion && active}
        onOpenChange={(open) => {
          if (!open && !pending) setDeletion(null);
        }}
      >
        <DialogContent
          className="max-w-[440px]"
          onCloseAutoFocus={() => triggerRef.current?.focus()}
        >
          <DialogHeader>
            <DialogTitle>Delete page “{deletion?.page.title}”?</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <DialogDescription>
              This deletes its {deletion?.ids.length}{" "}
              {deletion?.ids.length === 1 ? "frame" : "frames"}. Other files in{" "}
              <code>{deletion?.page.folder}/</code> are kept.
            </DialogDescription>
          </DialogBody>
          <DialogFooter>
            <Button
              variant="secondary"
              size="sm"
              disabled={pending}
              onClick={() => setDeletion(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={pending}
              onClick={() => {
                if (deletion) void remove(deletion);
              }}
            >
              Delete page
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
