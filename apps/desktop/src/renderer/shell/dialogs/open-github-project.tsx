import { CloudRepositoryPicker, type CloudRepositorySelection } from "../../features/settings/cloud-repository-picker";
// ──────────────────────────────────────────────────────────
// Open GitHub project dialog
// ──────────────────────────────────────────────────────────
//
// Triggered from Repository panel's "Add repository" dropdown → Open GitHub
// project. Clones a remote URL into <parent-folder>/<derived-name>
// and registers it as a project.

import React, { useEffect, useMemo, useRef, useState } from "react";


import { Button, GithubIcon, Input } from "../../shared/ui";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../../shared/ui/primitives/dialog";
import { toast } from "../../shared/ui/primitives/elements";

import {
  dialogPickFolder,
  isGitErrorShape,
  workspaceClone,
} from "../../platform/git";
import {
  notifyProjectsChanged,
  notifyWorkspacesChanged,
} from "../../state/use-projects";
import { upsertProject } from "../../state/projects-store";
import { ZerosSpinner } from "@/renderer/shared/ui/loading";
import { getActiveOrganizationSnapshot, getOrganizationStoreGeneration, useActiveOrganization, useTeams } from "../../features/team/team-store";
import { parseRemote } from "../pr/github-url";
import { createCloudWorkspaceDocument } from "../../platform/cloud-workspaces";
import { useCloudCreateAvailability } from "../dispatcher/cloud-create";
import { CloudComputerV2CreateNotice, useCloudComputerV2CreateGate } from "../../features/settings/cloud-computer-v2-create-gate";
import { acceptCloudWorkspaceDocument, cloudProjectForFolder } from "../../state/cloud-workspace-catalog";
import { cloudWorkspaceKey } from "../../platform/bridge/cloud-workspace-key";
import { useWorkspaceDispatch } from "../../state/store";
import { spawnPreparedDefaultChat } from "../../state/spawn-default-chat";
import { useOrganizationCloudPaused } from "../../features/team/cloud-workspace-pause";

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

export function OpenGithubProjectDialog(props: OpenGithubProjectDialogProps) {
  const organization = useActiveOrganization();
  const { me } = useTeams();
  const paused = useOrganizationCloudPaused();
  if (paused) return null;
  return <ScopedOpenGithubProjectDialog key={JSON.stringify([me?.user.id, organization?.id])} {...props} />;
}

function ScopedOpenGithubProjectDialog({
  open,
  onOpenChange,
  onCloned,
}: OpenGithubProjectDialogProps) {
  const [url, setUrl] = useState("");
  const [repositories, setRepositories] = useState<CloudRepositorySelection[]>([]);
  const { me } = useTeams();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [parentFolder, setParentFolder] = useState(defaultParentFolder());
  const [busy, setBusy] = useState(false);
  const organization = useActiveOrganization();
  const cloud = Boolean(organization && !organization.isPersonal);
  const source = useMemo(() => parseRemote(url.trim()), [url]);
  const availability = useCloudCreateAvailability(open && cloud);
  const computer = useCloudComputerV2CreateGate(open && cloud);
  // v2 forks the organization's live Cloud Computer, so only a repository it
  // has installed can become a cloud workspace.
  const installed = source?.host === "github.com"
    ? computer.repositories?.find(row => row.id === `${source.owner}/${source.repo}`.toLowerCase()) ?? null
    : null;
  const cloudReason = cloud
    ? availability.reason ?? computer.reason ??
      (source?.host === "github.com" && computer.repositories && !installed ? "Add this repository to your Cloud Computer first." : null)
    : null;
  const dispatch = useWorkspaceDispatch();
  const cloudIntent = useRef<{ fingerprint: string; key: string; repository: { owner: string; name: string } } | null>(null);

  useEffect(() => {
    if (!open) return;
    setUrl("");
    setRepositories([]);
    setParentFolder(defaultParentFolder());
    setBusy(false);
  }, [open]);

  const urlIsValid = cloud ? parseRemote(url.trim())?.host === "github.com" : URL_HINT_RE.test(url.trim());
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
    if (!open || busy || !urlIsValid || cloudReason || (!cloud && !parentFolder.trim())) return;
    const owner = getActiveOrganizationSnapshot();
    if (owner?.id !== organization?.id) return;
    setBusy(true);
    try {
      if (owner && !owner.isPersonal) {
        const epoch = getOrganizationStoreGeneration();
        if (source?.host !== "github.com") throw new Error("Choose a GitHub repository.");
        const fingerprint = JSON.stringify([epoch, owner.id, source.owner.toLowerCase(), source.repo.toLowerCase()]);
        if (cloudIntent.current?.fingerprint !== fingerprint) {
          if (!installed) throw new Error("Add this repository to your Cloud Computer first.");
          // No base branch: the server starts from the branch its Computer installed.
          cloudIntent.current = { fingerprint, key: crypto.randomUUID(), repository: { owner: installed.owner, name: installed.name } };
        }
        const intent = cloudIntent.current;
        const workspace = await createCloudWorkspaceDocument({ organizationId: owner.id,
          repository: intent.repository, idempotencyKey: intent.key });
        if (epoch !== getOrganizationStoreGeneration()) return;
        acceptCloudWorkspaceDocument(workspace);
        cloudIntent.current = null;
        const folder = cloudWorkspaceKey({ organizationId: workspace.organizationId, workspaceId: workspace.id });
        const project = cloudProjectForFolder(folder);
        if (getActiveOrganizationSnapshot()?.id === owner.id && project) {
          spawnPreparedDefaultChat({ folder, repoRoot: project.repoRoot, dispatch });
        } else {
          toast.success(`Cloud workspace created in ${owner.name}`);
        }
        notifyProjectsChanged();
        notifyWorkspacesChanged();
        if (mounted.current) onOpenChange(false);
        return;
      }
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
      if (!mounted.current) return;
      if (isGitErrorShape(err)) {
        toast.error(`Couldn't clone repository: ${err.message}`, {
          description: err.remediation ?? undefined,
        });
      } else {
        toast.error(
          `Couldn't open repository: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const canSubmit = open && urlIsValid && !cloudReason && (cloud || parentFolder.trim().length > 0) && !busy;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-[520px]"
        onPointerEnter={() => { computer.warm(); availability.warm(); }}
        onFocus={() => { computer.warm(); availability.warm(); }}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canSubmit) {
            e.preventDefault();
            void handleClone();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle className="inline-flex items-center gap-2">
            <GithubIcon className="text-fg2 size-4" />
            Open GitHub project
          </DialogTitle>
          <DialogDescription className="text-fg2 text-xs">
            {cloud ? `Create a cloud workspace in ${organization?.name} from this GitHub repository.` : "Clone a remote repository onto this Mac."}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="gap-5">
          {cloudReason && (computer.required
            ? <CloudComputerV2CreateNotice required canManage={computer.canManage} warm={computer.warm} onOpenSettings={() => onOpenChange(false)} />
            : <p className="text-fg2 text-xs" role="status">{cloudReason}</p>)}
          {cloud && me && organization && <CloudRepositoryPicker userId={me.user.id} organizationId={organization.id}
            active={open} disabled={busy} value={repositories} onManageConnections={() => onOpenChange(false)} onChange={selected => {
              setRepositories(selected);
              if (selected[0]) setUrl(`https://github.com/${selected[0].owner}/${selected[0].name}`);
            }} />}
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
          {!cloud && <div className="flex flex-col gap-1.5">
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
          </div>}

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
            onClick={handleClone}
            disabled={!canSubmit}
          >
            {busy && <ZerosSpinner size={16} tone="inverted" />}
            <span>{cloud ? "Create workspace" : "Clone"}</span>
            <kbd className="bg-primary-button-fg/15 text-primary-button-fg ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded-sm px-1 text-xs">
              ⌘↩
            </kbd>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
