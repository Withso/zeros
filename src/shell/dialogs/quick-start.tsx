// ──────────────────────────────────────────────────────────
// Quick Start dialog — Phase 1A modal (Roadmap 03a)
// ──────────────────────────────────────────────────────────
//
// Triggered from Column 1's "Add repository" dropdown → Quick start.
// Creates a fresh local repo (git init) and registers it as a project.
//
// Layout per screenshots:
//
//   ┌──────────────────────────────────────────────────────┐
//   │ Create project                                       │
//   │ Create a local folder, private GitHub repo, and …    │
//   │                                                      │
//   │ Project name                                         │
//   │ [example                         ]                   │
//   │ Creates folder and repo `example`                    │
//   │                                                      │
//   │ Parent folder                                        │
//   │ [/Users/dev/Projects            ] [Browse]           │
//   │                                                      │
//   │ Template                                             │
//   │ [Empty]    [Next.js]    [gstack NEW]                 │
//   │                                                      │
//   │                                          [Create ⌘↩] │
//   └──────────────────────────────────────────────────────┘
//
// v1 ships only "Empty" — Next.js / gstack are placeholders that
// fall back to Empty for now (TODO when we drop in skeleton tarballs).

import React, { useEffect, useState } from "react";
import { FolderOpen, Sparkles } from "lucide-react";

import { Button, Input } from "../../zeros/ui";
import { cn } from "../../zeros/ui/cn";
import { Tooltip } from "@/zeros/ui/primitives";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../../zeros/ui/primitives/dialog";
import { Switch } from "../../zeros/ui/primitives/switch";
import { toast } from "../../zeros/ui/primitives/elements";

import {
  dialogPickFolder,
  isGitErrorShape,
  workspaceInitRepo,
} from "../../native/git";
import {
  notifyProjectsChanged,
  notifyWorkspacesChanged,
} from "../../zeros/store/use-projects";
import { upsertProject } from "../../zeros/store/projects-store";
import { ZerosSpinner } from "@/loaders";

type Template = "empty" | "nextjs" | "gstack";

interface QuickStartDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a project is created so the parent can refresh
   *  Column 1 + activate the new project. */
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
  const [template, setTemplate] = useState<Template>("empty");
  // Publish the new repo to a private GitHub repo. ON by default — a brand-new
  // project usually wants a remote; uncheck to keep it local-only.
  const [createRepo, setCreateRepo] = useState(true);
  const [busy, setBusy] = useState(false);

  // Reset on open.
  useEffect(() => {
    if (!open) return;
    setName("");
    setParentFolder(defaultParentFolder());
    setTemplate("empty");
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
      // v1: Next.js + gstack fall through to "empty" template. When the
      // skeleton tarballs ship we'll branch here.
      const result = await workspaceInitRepo({
        name: name.trim(),
        parentFolder: parentFolder.trim(),
        template: "empty",
      });
      // Register as a project so Column 1 picks it up.
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
        className="max-w-[520px] gap-5"
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canSubmit) {
            e.preventDefault();
            void handleCreate();
          }
        }}
      >
        <div className="flex flex-col gap-1.5">
          <DialogTitle className="text-sm font-medium">
            Create project
          </DialogTitle>
          <DialogDescription className="text-fg2 text-sm">
            Create a local folder and your first workspace — and, optionally,
            publish it to a private GitHub repo.
          </DialogDescription>
        </div>

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

        {/* Template grid */}
        <div className="flex flex-col gap-1.5">
          <label className="text-fg1 text-sm font-medium">Template</label>
          <div className="grid grid-cols-3 gap-2">
            <TemplateCard
              value="empty"
              label="Empty"
              caption="Blank Git repo"
              icon={<EmptyIcon />}
              selected={template === "empty"}
              onSelect={setTemplate}
            />
            <TemplateCard
              value="nextjs"
              label="Next.js"
              caption="TypeScript, Tailwind, App Router"
              icon={<NextIcon />}
              selected={template === "nextjs"}
              onSelect={setTemplate}
              comingSoon
            />
            <TemplateCard
              value="gstack"
              label="gstack"
              caption="Agent workflow template"
              icon={<GstackIcon />}
              selected={template === "gstack"}
              onSelect={setTemplate}
              comingSoon
              badge="NEW"
            />
          </div>
        </div>

        <label className="flex items-center justify-between gap-2">
          <span className="flex flex-col gap-0.5">
            <span className="text-fg1 text-sm font-medium">
              Create a private GitHub repo
            </span>
            <span className="text-fg2 text-xs">
              Publish to GitHub and push — you can pick the owner next. Uncheck
              to keep it local-only.
            </span>
          </span>
          <Switch checked={createRepo} onCheckedChange={setCreateRepo} />
        </label>

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
            onClick={handleCreate}
            disabled={!canSubmit}
          >
            {busy && <ZerosSpinner size={16} tone="inverted" />}
            <span>Create</span>
            <kbd className="bg-primary-button-fg/15 text-primary-button-fg ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded-sm px-1 text-xs">
              ⌘↩
            </kbd>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Template card ────────────────────────────────────────

function TemplateCard({
  value,
  label,
  caption,
  icon,
  selected,
  onSelect,
  comingSoon,
  badge,
}: {
  value: Template;
  label: string;
  caption: string;
  icon: React.ReactNode;
  selected: boolean;
  onSelect: (t: Template) => void;
  comingSoon?: boolean;
  badge?: string;
}) {
  return (
    <Tooltip
      label={comingSoon ? "Coming soon" : undefined}
    >
      <button
        type="button"
        onClick={() => {
          if (!comingSoon) onSelect(value);
        }}
        // aria-disabled (not native `disabled`) so the "Coming soon" Tooltip
        // is still reachable on hover — a natively-disabled button fires no
        // pointer events. The onClick guard above blocks selection.
        aria-disabled={comingSoon}
        className={cn(
          "bg-bg1 relative flex flex-col items-start gap-2 rounded-md border p-3 text-left transition-[background-color,border-color] duration-120 ease-out",
          selected
            ? "border-highlighted-bright bg-bg2-hover"
            : "border-border1 hover:bg-bg2-hover hover:border-border1",
          comingSoon && "hover:bg-bg1 cursor-not-allowed opacity-50",
        )}
      >
        {badge && (
          <span className="text-fg2 bg-bg2-hover absolute top-1.5 right-1.5 rounded-sm px-1 py-0.5 text-xs leading-none font-medium">
            {badge}
          </span>
        )}
        <span className="bg-bg2-hover text-fg2 inline-flex size-7 items-center justify-center rounded-sm">
          {icon}
        </span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-fg1 truncate text-sm font-medium">{label}</span>
          <span className="text-fg2 line-clamp-2 text-xs">{caption}</span>
        </div>
      </button>
    </Tooltip>
  );
}

// Inline icons — keep them minimal + Zeros Foundation-compliant (size-4 stroke 1.5).
function EmptyIcon() {
  return <Sparkles className="size-3.5" />;
}
function NextIcon() {
  return <span className="text-xs font-medium">N</span>;
}
function GstackIcon() {
  return <FolderOpen className="size-3.5" />;
}
