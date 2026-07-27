// ──────────────────────────────────────────────────────────
// Publish to GitHub dialog
// ──────────────────────────────────────────────────────────
//
// The "Publish to GitHub" offer for a LOCAL project: create a private GitHub
// repo, add it as `origin`, and push. Handles both states the engine supports —
// a non-git folder (git-init first) and a git-but-remoteless folder. Driven by
// AddProjectProvider's `publishToGithub(repoRoot, name)` action; surfaced from
// the per-project "Publish" affordance and (optionally) Quick Start.
//
// Owner dropdown = the authed user + their orgs; the repo-name field live-checks
// availability. Private is on by default. Desktop-only (the engine refuses these
// ops for a relay client).

import { useEffect, useRef, useState } from "react";

import { Button, GithubIcon, Input } from "../../zeros/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../../zeros/ui/primitives/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../zeros/ui/primitives/select";
import { Switch } from "../../zeros/ui/primitives/switch";
import { toast } from "../../zeros/ui/primitives/elements";

import {
  ghCheckRepoName,
  ghListOwners,
  ghPublishRepo,
  isGitErrorShape,
  type GithubOwner,
} from "../../native/git";
import { notifyProjectsChanged } from "../../zeros/store/use-projects";
import { upsertProject } from "../../zeros/store/projects-store";
import {
  ghOwnersCache,
  GITHUB_READ_MAX_AGE_MS,
} from "../../zeros/store/read-caches";
import { useCachedRead } from "../../zeros/store/use-cached-read";
import { ZerosSpinner } from "@/loaders";

const NO_OWNERS: GithubOwner[] = [];

interface PublishToGithubDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The local project root to publish. */
  repoRoot: string | null;
  /** Prefill for the repo name (the project's leaf name). */
  defaultName?: string;
  onPublished?: (args: { repoRoot: string; originUrl: string }) => void;
}

type NameState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available" }
  | { kind: "taken" }
  | { kind: "error"; message: string };

/** Sanitize a folder leaf into a plausible repo name (GitHub allows alnum, `-`,
 *  `_`, `.`). Spaces → hyphens; strip the rest. */
function toRepoName(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "")
    .replace(/^[-.]+/, "");
}

export function PublishToGithubDialog({
  open,
  onOpenChange,
  repoRoot,
  defaultName,
  onPublished,
}: PublishToGithubDialogProps) {
  const [owner, setOwner] = useState<string>("");
  const [name, setName] = useState("");
  const [isPrivate, setIsPrivate] = useState(true);
  const [nameState, setNameState] = useState<NameState>({ kind: "idle" });
  const [busy, setBusy] = useState(false);

  // Owners (authed user + orgs) change rarely: cached, so reopening the
  // dialog shows the account list instantly and refetches only when stale.
  const ownersRead = useCachedRead(
    ghOwnersCache,
    open ? "owners" : null,
    () => ghListOwners(),
    { maxAgeMs: GITHUB_READ_MAX_AGE_MS },
  );
  const owners = ownersRead.data ?? NO_OWNERS;
  const ownersError =
    ownersRead.data === undefined && ownersRead.error
      ? ownersRead.error.message
      : null;

  // Reset the form on open.
  useEffect(() => {
    if (!open) return;
    setName(toRepoName(defaultName ?? ""));
    setIsPrivate(true);
    setNameState({ kind: "idle" });
    setBusy(false);
  }, [open, defaultName]);

  // Default the owner to the first account once the list is available.
  useEffect(() => {
    if (!open || owner) return;
    if (owners.length > 0) setOwner(owners[0].login);
  }, [open, owner, owners]);

  // Debounced repo-name availability check.
  const checkSeq = useRef(0);
  useEffect(() => {
    if (!open) return;
    const trimmed = name.trim();
    if (!trimmed || !owner) {
      setNameState({ kind: "idle" });
      return;
    }
    setNameState({ kind: "checking" });
    const seq = ++checkSeq.current;
    const id = window.setTimeout(() => {
      void ghCheckRepoName({ owner, name: trimmed })
        .then((r) => {
          if (seq !== checkSeq.current) return;
          setNameState({ kind: r.available ? "available" : "taken" });
        })
        .catch((err: unknown) => {
          if (seq !== checkSeq.current) return;
          setNameState({
            kind: "error",
            message: err instanceof Error ? err.message : "Check failed",
          });
        });
    }, 400);
    return () => window.clearTimeout(id);
  }, [name, owner, open]);

  const canSubmit =
    !!repoRoot &&
    !!owner &&
    name.trim().length > 0 &&
    nameState.kind !== "taken" &&
    nameState.kind !== "checking" &&
    !busy;

  const handlePublish = async () => {
    if (!canSubmit || !repoRoot) return;
    setBusy(true);
    try {
      const res = await ghPublishRepo({
        repoRoot,
        name: name.trim(),
        owner,
        private: isPrivate,
      });
      // Stamp the new remote onto the project so git surfaces light up.
      upsertProject({ repoRoot, originUrl: res.originUrl });
      notifyProjectsChanged();
      toast.success(`Published to ${res.owner}/${res.repo}`);
      onPublished?.({ repoRoot, originUrl: res.originUrl });
      onOpenChange(false);
    } catch (err: unknown) {
      if (isGitErrorShape(err)) {
        toast.error(`Couldn't publish: ${err.message}`, {
          description: err.remediation ?? undefined,
        });
      } else {
        toast.error(
          `Couldn't publish: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-[520px] gap-5"
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canSubmit) {
            e.preventDefault();
            void handlePublish();
          }
        }}
      >
        <div className="flex flex-col gap-1.5">
          <DialogTitle className="text-sm font-medium">
            Create a private GitHub repo?
          </DialogTitle>
          <DialogDescription className="text-fg2 text-sm">
            Zeros will create a private GitHub repo, add it as{" "}
            <code className="bg-bg2-hover text-fg1 rounded-sm px-1 text-xs">
              origin
            </code>
            , and push the current branch. Git is initialized first if needed.
          </DialogDescription>
        </div>

        {ownersError ? (
          <p className="text-red-primary text-sm">
            {ownersError}. Sign in to GitHub in Settings first.
          </p>
        ) : (
          <>
            {/* Owner */}
            <div className="flex flex-col gap-1.5">
              <label className="text-fg1 text-sm font-medium">Owner</label>
              <Select value={owner} onValueChange={setOwner}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select an owner" />
                </SelectTrigger>
                <SelectContent>
                  {owners.map((o) => (
                    <SelectItem key={o.login} value={o.login}>
                      {o.login}
                      {o.type === "org" ? " (org)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Repository name */}
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="pub-name"
                className="text-fg1 text-sm font-medium"
              >
                Repository name
              </label>
              <Input
                id="pub-name"
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-project"
                spellCheck={false}
              />
              {owner && name.trim() && (
                <p className="text-fg2 text-xs">
                  Will create{" "}
                  <span className="bg-bg2-hover text-fg1 rounded-sm px-1 text-xs">
                    {owner}/{name.trim()}
                  </span>
                </p>
              )}
              {nameState.kind === "available" && (
                <p className="text-fg2 text-xs">
                  Repository name is available.
                </p>
              )}
              {nameState.kind === "taken" && (
                <p className="text-red-primary text-xs">
                  That repository already exists.
                </p>
              )}
              {nameState.kind === "error" && (
                <p className="text-red-primary text-xs">{nameState.message}</p>
              )}
            </div>

            {/* Private toggle */}
            <label className="flex items-center justify-between gap-2">
              <span className="flex flex-col gap-0.5">
                <span className="text-fg1 text-sm font-medium">
                  Private repository
                </span>
                <span className="text-fg2 text-xs">
                  Only you (and collaborators you add) can see it.
                </span>
              </span>
              <Switch checked={isPrivate} onCheckedChange={setIsPrivate} />
            </label>
          </>
        )}

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
            onClick={handlePublish}
            disabled={!canSubmit}
          >
            {busy ? (
              <ZerosSpinner size={16} tone="inverted" />
            ) : (
              <GithubIcon className="size-3.5" />
            )}
            <span>Create repo and publish</span>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
