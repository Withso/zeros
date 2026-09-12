// ──────────────────────────────────────────────────────────
// Design section — which folder is this repo's design directory
// ──────────────────────────────────────────────────────────
//
// The design folder is COMMITTED repo content (recognizable by its committed
// `.zeros/design-dir.toml` registry; legacy canvas markers remain readable); the `[design] directory` key only points at
// which one is active. This section shows every recognized folder in the main
// checkout — a repo can legitimately hold several after a copy-paste from
// another repo or a monorepo migration — lets the user pick the active one
// (written to the personal `.zeros/settings.local.toml`), and
// renames the active folder (git mv + pointer, one commit, engine-refused
// while live design-mode workspaces exist).
//
// Internal-gated at the tab level (repo-page filters the section id), not
// here — a directly-rendered section still works for staff.
// ──────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import { Check, FolderPen, PenTool } from "lucide-react";

import type { Project } from "../../state/projects-store";
import { useBridge, useBridgeStatus } from "../../platform/bridge/use-bridge";
import {
  bridgeDesignListDirectories,
  bridgeDesignRenameDirectory,
} from "../../platform/bridge/design-bridge";
import {
  useResolvedSettings,
  useSettingsLayer,
} from "../settings/use-settings";
import {
  isInheritedSource,
  SettingsField,
  SettingsList,
  SettingsRow,
  SettingsSection,
  SourceTag,
  type SettingsSource,
} from "../settings/settings-ui";
import { Button, Input } from "../../shared/ui";
import { toast } from "../../shared/ui/primitives/elements";
import { cn } from "../../shared/ui/cn";
import { useCachedRead } from "../../state/use-cached-read";
import {
  designDirectoryListingCache,
  DESIGN_DIRECTORY_TARGET_MAX_AGE_MS,
} from "../../state/read-caches";
import { deriveDesignDirectoryOptions } from "./design-directory-options";

/** Read `design.directory` out of the resolved tree with its provenance. */
function pickPointer(resolved: {
  effective?: unknown;
  sources?: Record<string, unknown>;
}): { value: string | null; source: SettingsSource | undefined } {
  const effective = resolved.effective as
    | { design?: { directory?: unknown; directory_id?: unknown } }
    | undefined;
  const raw = effective?.design?.directory;
  return {
    value: typeof raw === "string" && raw.trim() ? raw.trim() : null,
    source: (resolved.sources?.["design.directory_id"] ??
      resolved.sources?.["design.directory"]) as SettingsSource | undefined,
  };
}

export function DesignSection({
  project,
  surfaceActive = true,
}: {
  project: Project;
  /** False while RepoPage keeps this completed form in its bounded deck —
   *  gates the discovery scan exactly like the Files tab's. */
  surfaceActive?: boolean;
}) {
  const bridge = useBridge();
  const bridgeStatus = useBridgeStatus();
  const resolved = useResolvedSettings(project.repoRoot);
  // Active selection is private; the separate directory registry is tracked.
  const repoLayer = useSettingsLayer("repo-local", project.repoRoot);
  const pointer = pickPointer({
    effective: resolved.resolved?.effective,
    sources: resolved.resolved?.sources,
  });

  const listingRead = useCachedRead(
    designDirectoryListingCache,
    project.repoRoot,
    (root) => bridgeDesignListDirectories(bridge!, root),
    {
      maxAgeMs: DESIGN_DIRECTORY_TARGET_MAX_AGE_MS,
      enabled: surfaceActive && !!bridge && bridgeStatus === "connected",
    },
  );
  const listing = listingRead.data ?? null;
  const listingError = listingRead.error?.message ?? null;
  const refreshListing = useCallback(() => {
    designDirectoryListingCache.invalidate(project.repoRoot);
  }, [project.repoRoot]);
  useEffect(() => {
    if (!surfaceActive || !bridge) return;
    return bridge.on("DB_CHANGED", (message) => {
      if ((message as { kinds?: string[] }).kinds?.includes("settings"))
        refreshListing();
    });
  }, [surfaceActive, bridge, refreshListing]);

  // With no explicit pointer, the engine's entry preview is the honest answer:
  // the single committed folder it would adopt, or the first-use name it
  // would create — not the unconfigured pointer default.
  const directoryPresentation = deriveDesignDirectoryOptions({
    pointer:
      pointer.value ?? (pointer.source ? (listing?.pointer ?? null) : null),
    listing,
  });
  const { activeName } = directoryPresentation;

  const [saving, setSaving] = useState(false);
  const choose = async (name: string) => {
    if (
      saving ||
      !listing ||
      !!listingError ||
      !directoryPresentation.options.some(
        (option) => option.name === name && option.selectable,
      )
    )
      return;
    setSaving(true);
    try {
      // Clicking an already-discovered row is the human confirmation the
      // engine requires before moving the privileged Design territory.
      await repoLayer.write(
        {
          design: listing?.directoryIds?.[name]
            ? { directory_id: listing.directoryIds[name], directory: null }
            : { directory: name, directory_id: null },
        },
        { confirmDesignDirectoryChange: true },
      );
      toast.success(`Design folder set to “${name}”`);
      refreshListing();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Couldn't save the design folder",
      );
    } finally {
      setSaving(false);
    }
  };

  const [renameDraft, setRenameDraft] = useState("");
  const [renaming, setRenaming] = useState(false);
  const handleRename = async () => {
    const to = renameDraft.trim();
    if (!to || renaming || !bridge || !listing || listingError) return;
    setRenaming(true);
    try {
      await bridgeDesignRenameDirectory(bridge, {
        repoRoot: project.repoRoot,
        from: activeName,
        to,
      });
      toast.success(
        `Renamed to “${to}”. The folder was committed and your local settings were updated.`,
      );
      setRenameDraft("");
      refreshListing();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't rename");
    } finally {
      setRenaming(false);
    }
  };

  // Offer every recognized folder, plus the pointer itself when it names a
  // folder that doesn't exist yet (first design use — created on first entry).
  const inherited = isInheritedSource(pointer.source);

  return (
    <div className="flex flex-col gap-8">
      <SettingsSection
        title="Design folder"
        description="Design source and metadata are tracked by Git. Your active folder choice is private in .zeros/settings.local.toml and inherited by local worktrees unless overridden."
      >
        <SettingsList>
          {directoryPresentation.options.map((option) => {
            const { name, active: isActive, exists, selectable } = option;
            return (
              <SettingsRow
                key={name}
                label={
                  <span className="flex min-w-0 items-center gap-2">
                    <PenTool
                      className="text-fg2 size-3.5 shrink-0"
                      strokeWidth={1.25}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 truncate font-mono text-[13px]">
                      {name}
                    </span>
                    {isActive && (
                      <span className="text-fg2 flex items-center gap-1 text-xs">
                        <Check className="size-3.5" aria-hidden="true" />
                        Active
                        {inherited && <SourceTag source={pointer.source} />}
                      </span>
                    )}
                    {!exists && (
                      <span className="text-muted-fg text-xs italic">
                        created on first design use
                      </span>
                    )}
                  </span>
                }
              >
                {selectable && (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={saving || !listing || !!listingError}
                    onClick={() => void choose(name)}
                  >
                    Use this folder
                  </Button>
                )}
              </SettingsRow>
            );
          })}
        </SettingsList>
        {listingError && (
          <p className="text-red-fg mt-2 text-xs">{listingError}</p>
        )}
      </SettingsSection>

      <SettingsSection
        title="Rename"
        description="Renames the active folder and commits its updated registry path in the main checkout. Its stable ID and your private selection stay the same. Close open Design workspaces before renaming."
      >
        <SettingsField
          htmlFor={`design-rename-${project.id}`}
          label={
            <span className="flex items-center gap-2">
              <FolderPen className="size-3.5" aria-hidden="true" />
              Rename “{activeName}”
            </span>
          }
        >
          <div className="flex flex-row gap-2">
            <Input
              id={`design-rename-${project.id}`}
              type="text"
              spellCheck={false}
              autoComplete="off"
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              placeholder="New folder name (e.g. Brand or apps/web/designs)"
              className={cn("flex-1 font-mono text-sm")}
              aria-label="New design folder name"
            />
            <Button
              variant="secondary"
              size="md"
              onClick={() => void handleRename()}
              disabled={
                renaming || !renameDraft.trim() || !listing || !!listingError
              }
            >
              {renaming ? "Renaming…" : "Rename"}
            </Button>
          </div>
        </SettingsField>
      </SettingsSection>
    </div>
  );
}
