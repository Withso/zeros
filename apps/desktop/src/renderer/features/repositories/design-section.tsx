// ──────────────────────────────────────────────────────────
// Design section — which folder is this repo's design directory
// ──────────────────────────────────────────────────────────
//
// The design folder is COMMITTED repo content (recognizable by its committed
// `.zeros-canvas.json` marker); the `[design] directory` key only points at
// which one is active. This section shows every recognized folder in the main
// checkout — a repo can legitimately hold several after a copy-paste from
// another repo or a monorepo migration — lets the user pick the active one
// (written to the committed `.zeros/settings.toml`, the team default), and
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

interface DirectoryListing {
  directories: string[];
  pointer: string;
  active: string;
}

/** Read `design.directory` out of the resolved tree with its provenance. */
function pickPointer(resolved: {
  effective?: unknown;
  sources?: Record<string, unknown>;
}): { value: string | null; source: SettingsSource | undefined } {
  const effective = resolved.effective as
    | { design?: { directory?: unknown } }
    | undefined;
  const raw = effective?.design?.directory;
  return {
    value: typeof raw === "string" && raw.trim() ? raw.trim() : null,
    source: resolved.sources?.["design.directory"] as
      | SettingsSource
      | undefined,
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
  // The pointer is the TEAM default, so it edits the COMMITTED repo layer —
  // unlike Paths' workspaces.path, which is deliberately per-machine.
  const repoLayer = useSettingsLayer("repo", project.repoRoot);
  const pointer = pickPointer({
    effective: resolved.resolved?.effective,
    sources: resolved.resolved?.sources,
  });

  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [listingError, setListingError] = useState<string | null>(null);
  const refreshListing = useCallback(() => {
    if (!bridge || bridgeStatus !== "connected") return;
    bridgeDesignListDirectories(bridge, project.repoRoot)
      .then((result) => {
        setListing(result);
        setListingError(null);
      })
      .catch((err: unknown) => {
        setListingError(
          err instanceof Error
            ? err.message
            : "Couldn't scan for design folders",
        );
      });
  }, [bridge, bridgeStatus, project.repoRoot]);
  useEffect(() => {
    if (!surfaceActive) return;
    refreshListing();
  }, [surfaceActive, refreshListing]);

  const activeName = pointer.value ?? listing?.pointer ?? "Zeros Design";

  const [saving, setSaving] = useState(false);
  const choose = async (name: string) => {
    if (saving || name === activeName) return;
    setSaving(true);
    try {
      // Clicking an already-discovered row is the human confirmation the
      // engine requires before moving the privileged Design territory.
      await repoLayer.write(
        { design: { directory: name } },
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
    if (!to || renaming || !bridge) return;
    setRenaming(true);
    try {
      const result = await bridgeDesignRenameDirectory(bridge, {
        repoRoot: project.repoRoot,
        from: activeName,
        to,
      });
      toast.success(
        result.committedPointer
          ? `Renamed to “${to}” — folder and settings committed together`
          : `Renamed to “${to}” — folder committed; .zeros/ is gitignored here, so the settings pointer stayed local`,
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
  const options = listing
    ? [...new Set([activeName, ...listing.directories])].sort((a, b) =>
        a.localeCompare(b),
      )
    : [activeName];
  const inherited = isInheritedSource(pointer.source);

  return (
    <div className="flex flex-col gap-8">
      <SettingsSection
        title="Design folder"
        description="Where this repo's designs live. The folder is committed content — this choice is the team default (.zeros/settings.toml, committed). A workspace can pin a different folder in its own local settings."
      >
        <SettingsList>
          {options.map((name) => {
            const isActive = name === activeName;
            const discovered = listing?.directories.includes(name) ?? false;
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
                    {!discovered && (
                      <span className="text-muted-fg text-xs italic">
                        created on first design use
                      </span>
                    )}
                  </span>
                }
              >
                {!isActive && (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={saving}
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
        description="Renames the active folder with git mv and updates the committed pointer in the same commit, in the repository's main checkout. Refused while design-mode workspaces are open on this repo."
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
              disabled={renaming || !renameDraft.trim()}
            >
              {renaming ? "Renaming…" : "Rename"}
            </Button>
          </div>
        </SettingsField>
      </SettingsSection>
    </div>
  );
}
