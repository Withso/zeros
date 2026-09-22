// Start from scratch creates an empty local Git repository and its first workspace.
import React, { useEffect, useState } from "react";

import { Button, Input } from "../../shared/ui";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../../shared/ui/primitives/dialog";
import { Switch } from "../../shared/ui/primitives/switch";
import { toast } from "../../shared/ui/primitives/elements";

import {
  dialogPickFolder,
  isGitErrorShape,
  workspaceInitRepo,
} from "../../platform/git";
import {
  notifyProjectsChanged,
  notifyWorkspacesChanged,
} from "../../state/use-projects";
import { upsertProject } from "../../state/projects-store";
import { ZerosSpinner } from "@/renderer/shared/ui/loading";

interface QuickStartDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a project is created so the parent can refresh
   *  Repository panel + activate the new project. */
  onCreated?: (args: { repoRoot: string; name: string }) => void;
  /** Open the "Publish to GitHub" dialog for the freshly-created repo. Called
   *  when the "Create private GitHub repo" toggle is on (passed by the provider
   *  to avoid a circular import). */
  onRequestPublish?: (repoRoot: string, name: string) => void;
}

// We can't read the OS home dir from the renderer (node:os isn't
// available — Vite externalizes it). Default to an empty string and
// surface a tilde-shaped placeholder; the Browse button uses the
// native folder picker which already opens at the user's home.
function defaultParentFolder(): string {
  return "";
}

export function QuickStartDialog({
  open,
  onOpenChange,
  onCreated,
  onRequestPublish,
}: QuickStartDialogProps) {
  const [name, setName] = useState("");
  const [parentFolder, setParentFolder] = useState(defaultParentFolder());
  // Publish the new repo to a private GitHub repo. ON by default — a brand-new
  // project usually wants a remote; uncheck to keep it local-only.
  const [createRepo, setCreateRepo] = useState(true);
  const [busy, setBusy] = useState(false);

  // Reset on open.
  useEffect(() => {
    if (!open) return;
    setName("");
    setParentFolder(defaultParentFolder());
    setCreateRepo(true);
    setBusy(false);
  }, [open]);

  const handleBrowse = async () => {
    const picked = await dialogPickFolder({
      title: "Pick a parent folder",
      defaultPath: parentFolder,
    });
    if (picked) setParentFolder(picked);
  };

  const handleCreate = async () => {
    if (busy) return;
    if (!name.trim() || !parentFolder.trim()) return;
    setBusy(true);
    try {
      const result = await workspaceInitRepo({
        name: name.trim(),
        parentFolder: parentFolder.trim(),
        template: "empty",
      });
      // Register as a project so Repository panel picks it up.
      upsertProject({ repoRoot: result.repoRoot, name: name.trim() });
      notifyProjectsChanged();
      notifyWorkspacesChanged(); // sweep refresh
      onCreated?.({ repoRoot: result.repoRoot, name: name.trim() });
      onOpenChange(false);
      // Chain into the Publish dialog when requested (off the freshly created
      // local repo). The provider mounts that dialog; it opens as we close.
      if (createRepo) {
        onRequestPublish?.(result.repoRoot, name.trim());
      }
    } catch (err: unknown) {
      if (isGitErrorShape(err)) {
        toast.error(`Couldn't create project: ${err.message}`, {
          description: err.remediation ?? undefined,
        });
      } else {
        toast.error(
          `Couldn't create project: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const canSubmit =
    name.trim().length > 0 && parentFolder.trim().length > 0 && !busy;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-[520px]"
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canSubmit) {
            e.preventDefault();
            void handleCreate();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle className="font-medium">
            Create project
          </DialogTitle>
          <DialogDescription className="text-fg2 text-xs">
            Create a project and your first workspace.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="gap-5">
          {/* Project name */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="qs-name" className="text-fg1 text-sm font-medium">
              Project name
            </label>
            <Input
              id="qs-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-new-project"
              spellCheck={false}
            />
            {name.trim() && (
              <p className="text-fg2 text-xs">
                Creates folder and repo{" "}
                <span className="bg-bg2-hover text-fg1 rounded-sm px-1 text-xs">
                  {name.trim()}
                </span>
              </p>
            )}
          </div>

          {/* Parent folder */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="qs-parent" className="text-fg1 text-sm font-medium">
              Parent folder
            </label>
            <div className="flex items-center gap-2">
              <Input
                id="qs-parent"
                value={parentFolder}
                onChange={(e) => setParentFolder(e.target.value)}
                className="flex-1 text-xs"
                spellCheck={false}
                placeholder="Click Browse to pick a folder…"
              />
              <Button
                variant="secondary"
                size="lg"
                onClick={handleBrowse}
                className="shrink-0"
              >
                Browse
              </Button>
            </div>
          </div>

          <label className="flex items-center justify-between gap-2">
            <span className="flex flex-col gap-0.5">
              <span className="text-fg1 text-sm font-medium">
                Create a private GitHub repo
              </span>
              <span className="text-fg2 text-xs">
                Publish to GitHub. Turn off to keep it local.
              </span>
            </span>
            <Switch checked={createRepo} onCheckedChange={setCreateRepo} />
          </label>

          {/* Footer */}
        </DialogBody>
        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            variant="default"
            size="sm"
            onClick={handleCreate}
            disabled={!canSubmit}
          >
            {busy && <ZerosSpinner size={16} tone="inverted" />}
            <span>Create</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
