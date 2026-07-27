// ──────────────────────────────────────────────────────────
// Open GitHub project dialog — Phase 1A modal (Roadmap 03a)
// ──────────────────────────────────────────────────────────
//
// Triggered from Column 1's "Add repository" dropdown → Open GitHub
// project. Clones a remote URL into <parent-folder>/<derived-name>
// and registers it as a project.

import React, { useEffect, useMemo, useState } from "react";


import { Button, GithubIcon, Input } from "../../zeros/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../../zeros/ui/primitives/dialog";
import { toast } from "../../zeros/ui/primitives/elements";

import {
  dialogPickFolder,
  isGitErrorShape,
  workspaceClone,
} from "../../native/git";
import {
  notifyProjectsChanged,
  notifyWorkspacesChanged,
} from "../../zeros/store/use-projects";
import { upsertProject } from "../../zeros/store/projects-store";
import { ZerosSpinner } from "@/loaders";

interface OpenGithubProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloned?: (args: { repoRoot: string }) => void;
}

// Same renderer-side constraint as quick-start.tsx — node:os isn't
// available, so default to empty + Browse.
function defaultParentFolder(): string {
  return "";
}

const URL_HINT_RE = /^(?:[A-Za-z0-9_-]+@|https?:\/\/)\S+/;

/** Best-effort: derive the directory name the clone will produce so the
 *  user sees a preview of the final path. Matches the engine's
 *  deriveCloneDirName logic. */
function previewDirName(url: string): string {
  const sshMatch = url.match(/^[^@]+@[^:]+:(.+?)(?:\.git)?$/);
  if (sshMatch) {
    const last = sshMatch[1].split("/").filter(Boolean).pop();
    if (last) return last;
  }
  const httpMatch = url.match(/^https?:\/\/[^/]+\/(.+?)(?:\.git)?$/);
  if (httpMatch) {
    const last = httpMatch[1].split("/").filter(Boolean).pop();
    if (last) return last;
  }
  return "";
}

export function OpenGithubProjectDialog({
  open,
  onOpenChange,
  onCloned,
}: OpenGithubProjectDialogProps) {
  const [url, setUrl] = useState("");
  const [parentFolder, setParentFolder] = useState(defaultParentFolder());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setUrl("");
    setParentFolder(defaultParentFolder());
    setBusy(false);
  }, [open]);

  const urlIsValid = URL_HINT_RE.test(url.trim());
  const dirName = useMemo(() => previewDirName(url.trim()), [url]);
  const fullPath =
    parentFolder.trim() && dirName ? `${parentFolder.trim()}/${dirName}` : "";

  const handleBrowse = async () => {
    const picked = await dialogPickFolder({
      title: "Pick a parent folder",
      defaultPath: parentFolder,
    });
    if (picked) setParentFolder(picked);
  };

  const handleClone = async () => {
    if (busy || !urlIsValid || !parentFolder.trim()) return;
    setBusy(true);
    try {
      const result = await workspaceClone({
        url: url.trim(),
        parentFolder: parentFolder.trim(),
      });
      upsertProject({
        repoRoot: result.repoRoot,
        originUrl: url.trim(),
      });
      notifyProjectsChanged();
      notifyWorkspacesChanged();
      onCloned?.({ repoRoot: result.repoRoot });
      onOpenChange(false);
    } catch (err: unknown) {
      if (isGitErrorShape(err)) {
        toast.error(`Couldn't clone repository: ${err.message}`, {
          description: err.remediation ?? undefined,
        });
      } else {
        toast.error(
          `Couldn't clone repository: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = urlIsValid && parentFolder.trim().length > 0 && !busy;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-[520px] gap-5"
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canSubmit) {
            e.preventDefault();
            void handleClone();
          }
        }}
      >
        <div className="flex flex-col gap-1.5">
          <DialogTitle className="inline-flex items-center gap-2 text-sm font-medium">
            <GithubIcon className="text-fg2 size-4" />
            Open GitHub project
          </DialogTitle>
          <DialogDescription className="text-fg2 text-sm">
            Clone a remote repository — `git clone` runs locally, the engine
            never proxies your credentials.
          </DialogDescription>
        </div>

        {/* URL */}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="og-url" className="text-fg1 text-sm font-medium">
            Repository URL
          </label>
          <Input
            id="og-url"
            autoFocus
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://github.com/owner/repo  or  git@github.com:owner/repo.git"
            spellCheck={false}
            className="text-xs"
          />
          {url.trim() && !urlIsValid && (
            <p className="text-red-primary text-xs">
              That doesn't look like a git URL — use https://… or
              git@host:owner/repo.git
            </p>
          )}
        </div>

        {/* Parent folder */}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="og-parent" className="text-fg1 text-sm font-medium">
            Parent folder
          </label>
          <div className="flex items-center gap-2">
            <Input
              id="og-parent"
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
          {fullPath && (
            <p className="text-fg2 text-xs">
              Will create{" "}
              <span className="bg-bg2-hover text-fg1 rounded-sm px-1 text-xs">
                {fullPath}
              </span>
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 pt-1">
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
            onClick={handleClone}
            disabled={!canSubmit}
          >
            {busy && <ZerosSpinner size={16} tone="inverted" />}
            <span>Clone</span>
            <kbd className="bg-primary-button-fg/15 text-primary-button-fg ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded-sm px-1 text-xs">
              ⌘↩
            </kbd>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
