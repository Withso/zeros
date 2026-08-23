// ──────────────────────────────────────────────────────────
// WorkingDirectoriesPanel — choose which folders exist in this workspace
// ──────────────────────────────────────────────────────────
//
// A searchable checklist of the repo's top-level TRACKED directories. Folders
// left unchecked are removed from the worktree via git sparse-checkout, so the
// agent, the terminal, the Files tab and the user's editor all stop seeing
// them at once. Nothing is destroyed — rechecking restores the folder from the
// object store.
//
// Why folders only, and why only tracked ones: cone-mode sparse-checkout can
// exclude directories but never top-level files (those are always present),
// and its patterns are matched against the index, so an untracked-only folder
// has nothing to exclude. Both constraints come from git, not from us — see
// `apps/desktop/src/engine/git/sparse-checkout.ts`.
//
// The selection is a DRAFT until Save. Applying rewrites the working tree, so
// it must be one deliberate action rather than a write per checkbox.
// ──────────────────────────────────────────────────────────

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check } from "lucide-react";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/renderer/shared/ui/primitives/command";
import { Button } from "@/renderer/shared/ui/primitives/button";
import { toast } from "@/renderer/shared/ui/primitives/elements";
import {
  isWorkspaceOpStillRunning,
  setWorkingDirectories,
  WORKING_DIRECTORIES_UNSUPPORTED_COPY,
} from "@/renderer/platform/git";
import { isNativeRuntime } from "@/renderer/platform/runtime";
import { useCachedRead } from "@/renderer/state/use-cached-read";
import { triggerGitRefresh } from "../../use-git-refresh-key";
import {
  fetchWorkingDirectoriesSnapshot,
  publishWorkingDirectoriesSnapshot,
  WORKING_DIRECTORIES_MAX_AGE_MS,
  workingDirectoriesCache,
  workingDirectoriesCacheKey,
} from "./working-directories-cache";

export interface WorkingDirectoriesPanelProps {
  /** Worktree path — the engine resolves it to the workspace. Null/undefined
   *  while a blank File tab has no workspace yet; the control hides. */
  cwd: string | null | undefined;
  /** The same git target the host surface subscribes its refresh key with.
   *  Needed because the engine's own DB_CHANGED for this op is SCOPED to the
   *  workspace id — a cwd-only subscriber never hears it, which is exactly the
   *  signal a save whose reply was lost has to wait for. */
  workspaceId?: string | null;
  /** Whether this retained Files surface is currently visible. Hidden tabs
   *  may read an already-confirmed snapshot, but must not subscribe or fetch. */
  active?: boolean;
}

/** Whether this surface can show the picker at all.
 *
 *  Both engine ops are local-only (off the remote allowlist), so on an optional
 *  relay client every click would dead-end in an empty list. Exported
 *  because the Files header must omit a sidebar action that cannot work. */
export function canPickWorkingDirectories(
  cwd: string | null | undefined,
): boolean {
  return !!cwd && isNativeRuntime();
}

/** Same set, ignoring order. */
function sameSelection(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const seen = new Set(a);
  return b.every((d) => seen.has(d));
}

export function WorkingDirectoriesPanel({
  cwd,
  workspaceId,
  active = true,
}: WorkingDirectoriesPanelProps): React.ReactElement | null {
  const available = canPickWorkingDirectories(cwd);
  const cacheKey =
    available && cwd ? workingDirectoriesCacheKey(cwd, workspaceId) : null;
  const { data: state } = useCachedRead(
    workingDirectoriesCache,
    cacheKey,
    fetchWorkingDirectoriesSnapshot,
    { enabled: active, maxAgeMs: WORKING_DIRECTORIES_MAX_AGE_MS },
  );
  // A warm key seeds the draft in the first render, so reopening never paints
  // cached rows unchecked and repairs them in a later passive effect.
  const [draft, setDraft] = useState<string[]>(() => state?.included ?? []);
  const [saving, setSaving] = useState(false);

  // Drafts are ephemeral, but their confirmed source is exact-key server
  // state. If React reuses this fiber for another worktree, reset before commit
  // from that owner's synchronous cache snapshot—never show A's draft in B.
  const loadedFor = useRef<string | null>(cacheKey);
  // The selection the draft was last synced FROM. `null` means "no draft yet",
  // so the next read adopts wholesale; otherwise a draft that has diverged from
  // it is an unsaved user edit and must survive a background re-read.
  const draftBaseline = useRef<readonly string[] | null>(
    state?.included ?? null,
  );
  const draftRef = useRef<readonly string[]>(draft);
  draftRef.current = draft;
  if (loadedFor.current !== cacheKey) {
    loadedFor.current = cacheKey;
    draftBaseline.current = state?.included ?? null;
    const nextDraft = state?.included ?? [];
    if (!sameSelection(draftRef.current, nextDraft)) {
      draftRef.current = nextDraft;
      setDraft(nextDraft);
    }
  }

  // A cold result or exact-key background refresh adopts before paint unless
  // the user has already diverged from its previous confirmed baseline.
  useLayoutEffect(() => {
    if (!active || !state) return;
    const editing =
      draftBaseline.current !== null &&
      !sameSelection(draftRef.current, draftBaseline.current);
    if (editing) return;
    draftBaseline.current = state.included;
    if (!sameSelection(draftRef.current, state.included)) {
      draftRef.current = state.included;
      setDraft(state.included);
    }
  }, [active, state]);

  // Frozen while a save is in flight. The request carries the draft captured
  // when Save was clicked, and the response overwrites `draft` with what the
  // engine actually applied — so a toggle made mid-flight would be silently
  // discarded and then confirmed with a success toast.
  // Design territory can never be hidden: excluding it takes the canvas off
  // disk, so Design mode would open onto nothing. The engine force-includes
  // these regardless of what we send, so refusing the toggle here only keeps
  // the UI honest about an outcome that is already fixed.
  const locked = useMemo(() => new Set(state?.locked ?? []), [state]);

  const toggle = useCallback(
    (dir: string) => {
      if (saving || locked.has(dir)) return;
      setDraft((prev) =>
        prev.includes(dir) ? prev.filter((d) => d !== dir) : [...prev, dir],
      );
    },
    [saving, locked],
  );

  const dirty = useMemo(
    () => (state ? !sameSelection(draft, state.included) : false),
    [draft, state],
  );

  const save = useCallback(async () => {
    if (!cwd || !cacheKey || !state || saving) return;
    setSaving(true);
    try {
      const result = await setWorkingDirectories(cwd, draft, workspaceId);
      const hidden = result.all.length - result.included.length;
      // Surface refusals rather than letting the folder look excluded while
      // its files are still on disk — git leaves anything with local edits.
      if (result.leftBehind && result.leftBehind.length > 0) {
        toast.warning(
          `${result.leftBehind.length} file(s) kept — uncommitted changes in ${result.leftBehind
            .slice(0, 2)
            .join(", ")}`,
        );
      } else {
        toast.success(
          hidden === 0
            ? "All folders visible"
            : `${hidden} folder${hidden === 1 ? "" : "s"} hidden`,
        );
      }
      // Coarse refresh (no cwd argument) on purpose. A cwd-scoped bump only
      // wakes subscribers keyed on that exact path, but a chat rooted in a
      // worktree SUBDIRECTORY has a different cwd from `workspace.path` — so
      // the Changes badge, line counts and Review tab would keep serving
      // pre-rewrite numbers. A whole-worktree rewrite warrants invalidating
      // everything.
      triggerGitRefresh();
      // The mutation reply is authoritative. Publish it after the coarse Git
      // invalidation so every mounted/reopened panel sees the result instantly
      // and no redundant read is launched merely because this panel saved it.
      const confirmed = publishWorkingDirectoriesSnapshot(cacheKey, result);
      draftBaseline.current = confirmed.included;
      draftRef.current = confirmed.included;
      setDraft(confirmed.included);
    } catch (err) {
      // "Request timeout: WORKSPACE_REQUEST" / "…: engine disconnected" mean
      // only the REPLY was lost — the engine is still applying the cone (or
      // already has). Reporting that as a failure is what made a working save
      // look broken. Say what's true, keep the panel open, and let the
      // exact DB_CHANGED invalidation refresh the cache from the real state.
      if (isWorkspaceOpStillRunning(err)) {
        toast.warning("Still applying the folder change…");
      } else {
        toast.error(
          err instanceof Error
            ? err.message
            : "Couldn't update working folders",
        );
      }
    } finally {
      setSaving(false);
    }
  }, [cacheKey, cwd, draft, saving, state, workspaceId]);

  if (!available) return null;

  const dirs = state?.all ?? [];
  // Only advertise the control once we know it can work here. An unsupported
  // checkout (no commits yet) would otherwise offer an empty, unsaveable list.
  const unsupported = state !== undefined && !state.supported;

  return (
    <div
      data-testid="working-directories-panel"
      className="bg-bg1 flex h-full min-h-0 flex-col overflow-hidden"
    >
      <Command
        className="bg-bg1 min-h-0 rounded-none"
        aria-busy={state === undefined || saving || undefined}
      >
        <CommandInput
          autoFocus
          placeholder="Search folders to include or exclude…"
        />
        {!unsupported && dirs.length > 0 && (
          <div
            data-testid="working-directories-actions"
            className="border-border2 flex shrink-0 items-center gap-3 border-b px-3 py-2"
          >
            {/* Frozen while a save is in flight, for the same reason `toggle`
                is: the response overwrites `draft`, so a click here would be
                silently discarded and then confirmed with a success toast. */}
            <button
              type="button"
              className="text-fg2 hover:text-fg1 text-xs disabled:opacity-40"
              disabled={saving || draft.length === dirs.length}
              onClick={() => setDraft(dirs)}
            >
              Select all
            </button>
            <button
              type="button"
              className="text-fg2 hover:text-fg1 text-xs disabled:opacity-40"
              disabled={saving || draft.every((dir) => locked.has(dir))}
              onClick={() => setDraft(dirs.filter((dir) => locked.has(dir)))}
            >
              Deselect all
            </button>
            <div className="flex-1" />
            <Button
              size="sm"
              disabled={!dirty || saving}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        )}
        <CommandList className="max-h-none min-h-0 flex-1">
          {state === undefined ? null : unsupported ? (
            <CommandEmpty>
              {
                WORKING_DIRECTORIES_UNSUPPORTED_COPY[
                  state.unsupportedReason ?? "no-commits"
                ]
              }
            </CommandEmpty>
          ) : (
            <>
              <CommandEmpty>No folders found.</CommandEmpty>
              <CommandGroup>
                {dirs.map((dir) => {
                  const isLocked = locked.has(dir);
                  const on = isLocked || draft.includes(dir);
                  return (
                    <CommandItem
                      key={dir}
                      value={dir}
                      disabled={isLocked}
                      onSelect={() => toggle(dir)}
                    >
                      {on ? (
                        <Check className="text-fg1 size-3.5 shrink-0" />
                      ) : (
                        <span className="size-3.5 shrink-0" />
                      )}
                      <span className="truncate">{dir}</span>
                      {isLocked && (
                        <span className="text-fg3 ml-auto shrink-0 pl-2 text-xs">
                          Design
                        </span>
                      )}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </>
          )}
        </CommandList>
      </Command>
    </div>
  );
}
