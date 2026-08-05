// ──────────────────────────────────────────────────────────
// TargetBranchButton — the target/base branch picker
// ──────────────────────────────────────────────────────────
//
//                            ┌──────────────────┐
//   feature/my-branch   →    │ origin/main   ⇅  │
//                            └──────────────────┘
//   (fg2 branch name) (arrow)  (secondary dropdown)
//
// The workspace's own branch (plain fg2 text) → a 24px secondary dropdown
// (matches the Create PR height) showing the current base — reading as
// "this branch merges into that one". Lives at the LEFT end of the
// Changes tab's PR row (ChangesWorkbenchSurface → PrStatusRow), opposite the Create PR
// split-button — pick the base, then open the PR against it.
//
// Only REMOTE branches (refs/remotes/<git.remote>/*, default origin) are
// offered as targets: a PR merges on the remote (GitHub), so the base must
// exist there. See gitListRemoteBranches / listRemoteBranches (engine).
//
// On open the picker highlights + scrolls the current base into view (cmdk
// `defaultValue`), matching the top-bar repository dropdown.
// ──────────────────────────────────────────────────────────

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ArrowRight, Check, ChevronsUpDown } from "lucide-react";

import { Tooltip } from "@/renderer/shared/ui/primitives";
import { toast } from "../../shared/ui/primitives/elements";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../shared/ui/primitives/popover";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "../../shared/ui/primitives/command";
import { notifyWorkspacesChanged } from "../../state/use-projects";
import { useGitRemote } from "../../features/settings/use-git-remote";
import {
  GIT_READ_MAX_AGE_MS,
  remoteBranchesCache,
} from "../../state/read-caches";
import { useCachedRead } from "../../state/use-cached-read";
import {
  gitChangeTargetBranch,
  gitListRemoteBranches,
  isGitErrorShape,
  type Branch,
  type Workspace,
} from "../../platform/git";

// The dropdown itself: a 24px (`h-6`, same as Create PR) secondary control —
// design-system "secondary" tokens (TRANSPARENT fill so it blends with the PR
// row's surface + border2, hover bg2-hover + border3), 13px text. Raw <button>
// rather than the shared component so the small chevron isn't forced to the
// shared button's 16px `[&_svg]` size. `min-w-0` lets it shrink (only when the
// row runs out of room) so a long base name truncates rather than pushing on
// Create PR.
const TRIGGER_CLS =
  "inline-flex h-6 min-w-0 items-center gap-1.5 rounded-sm border border-border2 bg-transparent pl-2.5 pr-2 text-xs text-fg1 transition-colors duration-120 ease-out hover:border-border3 hover:bg-bg2-hover disabled:opacity-50";

// ── Target branch popover ────────────────────────────────

interface TargetBranchPopoverProps {
  workspace: Workspace;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Tooltip label for the trigger. Empty ⇒ no tooltip. Threaded here so the
   *  Tooltip can wrap the internal PopoverTrigger — wrapping the trigger's
   *  child at the call site would break the popover's asChild ref forwarding. */
  label?: React.ReactNode;
  children: React.ReactNode;
}

function TargetBranchPopover({
  workspace,
  open,
  onOpenChange,
  label,
  children,
}: TargetBranchPopoverProps) {
  const [busy, setBusy] = useState(false);
  const remote = useGitRemote(workspace.repoRoot);
  const contentRef = useRef<HTMLDivElement>(null);

  // Cached remote-branch rows: reopening the picker paints the previous list
  // instantly and refetches only past the freshness window (in the
  // background, without disturbing the rows on screen).
  const branchesRead = useCachedRead(
    remoteBranchesCache,
    open ? workspace.id : null,
    () => gitListRemoteBranches(workspace.id),
    { maxAgeMs: GIT_READ_MAX_AGE_MS },
  );
  const branches: Pick<Branch, "name">[] = useMemo(
    () => branchesRead.data ?? [{ name: workspace.baseBranch }],
    [branchesRead.data, workspace.baseBranch],
  );
  const loading = branchesRead.loading;

  // `defaultValue` on <Command> keeps the current base HIGHLIGHTED once its row
  // registers, but cmdk only auto-scrolls on mount — when this list is still
  // empty (it loads async). So once the branches land, scroll the highlighted
  // row into view ourselves. Mirrors the shared DropdownMenu primitive's
  // open-scroll; rAF lets cmdk paint aria-selected on the fresh rows first.
  useEffect(() => {
    if (!open || loading || branches.length === 0) return;
    const raf = requestAnimationFrame(() => {
      contentRef.current
        ?.querySelector<HTMLElement>(
          '[data-slot="command-item"][aria-selected="true"]',
        )
        ?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(raf);
  }, [open, loading, branches]);

  const pickTarget = useCallback(
    async (branchName: string) => {
      if (busy) return;
      if (branchName === workspace.baseBranch) {
        onOpenChange(false);
        return;
      }
      setBusy(true);
      try {
        await gitChangeTargetBranch({
          workspaceId: workspace.id,
          newTarget: branchName,
          // Picking PR metadata must not rewrite local history. Updating a
          // branch is a separate, explicit workflow the user/agent can run
          // after resolving dirty/conflicted work.
          rebase: false,
        });
        notifyWorkspacesChanged(workspace.repoSlug);
        onOpenChange(false);
      } catch (err: unknown) {
        if (isGitErrorShape(err)) {
          toast.error(`Couldn't change target branch: ${err.message}`, {
            description: err.remediation ?? undefined,
          });
        } else {
          toast.error(
            `Couldn't change target branch: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      } finally {
        setBusy(false);
      }
    },
    [
      busy,
      onOpenChange,
      workspace.baseBranch,
      workspace.id,
      workspace.repoSlug,
    ],
  );

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Tooltip label={label}>
        <PopoverTrigger asChild>{children}</PopoverTrigger>
      </Tooltip>
      <PopoverContent
        ref={contentRef}
        align="start"
        sideOffset={4}
        className="w-[280px] p-0"
      >
        <div className="flex items-center justify-between gap-3 px-3 pt-3 pb-2">
          <span className="text-fg1 text-xs font-medium">Target branch</span>
          <span className="text-fg2 text-xs tabular-nums">
            {remote}/{workspace.baseBranch}
          </span>
        </div>
        <Command
          // Open ON the current base: cmdk highlights the row whose `value`
          // matches this (instead of defaulting to row one) — the "open on the
          // selected item" behaviour of the top-bar repository dropdown. The
          // scroll-into-view is handled by the effect above (cmdk's own
          // auto-scroll misses async-loaded rows). Typing re-highlights the
          // first match, which is what we want.
          defaultValue={workspace.baseBranch}
        >
          <CommandInput placeholder="Select target branch…" />
          <CommandList
            className="max-h-[260px]"
            aria-busy={loading || undefined}
          >
            {!loading && branches.length === 0 && (
              <CommandEmpty>No remote branches found.</CommandEmpty>
            )}
            {branches
              .filter((b) => b.name !== workspace.branch)
              .map((b) => (
                <CommandItem
                  key={b.name}
                  value={b.name}
                  onSelect={() => void pickTarget(b.name)}
                  disabled={busy}
                >
                  {b.name === workspace.baseBranch ? (
                    <Check className="text-fg1 size-3.5 shrink-0" />
                  ) : (
                    <span className="size-3.5 shrink-0" />
                  )}
                  <span className="truncate">{b.name}</span>
                </CommandItem>
              ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// ── Trigger pill ─────────────────────────────────────────

interface TargetBranchButtonProps {
  workspace: Workspace;
  /** Inert while the native bridge isn't ready (the popover needs it to list
   *  remote branches). */
  disabled?: boolean;
}

/** The workspace's branch name (fg2) → the "<remote>/<base> ⇅" dropdown that
 *  opens the picker popover. */
export function TargetBranchButton({
  workspace,
  disabled,
}: TargetBranchButtonProps) {
  const [open, setOpen] = useState(false);
  const remote = useGitRemote(workspace.repoRoot);
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="text-fg2 min-w-0 truncate text-xs tabular-nums">
        {workspace.branch}
      </span>
      <ArrowRight className="text-fg2 size-3.5 shrink-0" />
      <TargetBranchPopover
        workspace={workspace}
        open={open}
        onOpenChange={setOpen}
        label="Change target branch"
      >
        <button
          type="button"
          className={TRIGGER_CLS}
          disabled={disabled}
          aria-label="Change target branch"
        >
          <span className="text-fg1 min-w-0 truncate font-medium tabular-nums">
            {remote}/{workspace.baseBranch}
          </span>
          <ChevronsUpDown className="text-fg2 size-3.5 shrink-0" />
        </button>
      </TargetBranchPopover>
    </div>
  );
}
