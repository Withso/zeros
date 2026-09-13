// ──────────────────────────────────────────────────────────
// Design section — which folder is this repo's design directory
// ──────────────────────────────────────────────────────────
//
// The design folder is COMMITTED repo content (recognizable by its committed
// `design.toml` manifest; legacy canvas markers remain readable); the `[design] directory` key only points at
// which one is active. This section shows every recognized folder in the main
// checkout — a repo can legitimately hold several after a copy-paste from
// another repo or a monorepo migration — lets the user pick the active one
// (written to the personal `.zeros/settings.local.toml`), and
// renames folders inline (git mv + pointer, one commit, engine-refused
// while live design-mode workspaces exist).
//
// Shown under the repository's Design mode → Directory tab.
// ──────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Folder, Pencil, Trash2 } from "lucide-react";

import type { Project } from "../../state/projects-store";
import { useBridge, useBridgeStatus } from "../../platform/bridge/use-bridge";
import {
  bridgeDesignListDirectories,
  bridgeDesignRenameDirectory,
  bridgeDesignRemoveDirectory,
  bridgePreviewExistingDesignDirectory,
  bridgeAdoptDesignDirectory,
  type DesignFolderPreviewWire,
} from "../../platform/bridge/design-bridge";
import {
  useResolvedSettings,
  useSettingsLayer,
} from "../settings/use-settings";
import { type SettingsSource } from "../settings/settings-ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../../shared/ui/primitives/dialog";
import { Button, Input } from "../../shared/ui";
import { toast } from "../../shared/ui/primitives/elements";
import { useCachedRead } from "../../state/use-cached-read";
import {
  designDirectoryListingCache,
  DESIGN_DIRECTORY_TARGET_MAX_AGE_MS,
} from "../../state/read-caches";
import { dialogPickFolder } from "../../platform/git";
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

  const [removeName, setRemoveName] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const remove = async () => {
    if (!bridge || !removeName || removing || !surfaceActive) return;
    setRemoving(true);
    try {
      await bridgeDesignRemoveDirectory(bridge, {
        repoRoot: project.repoRoot,
        directory: removeName,
      });
      toast.success(
        `Removed Design registration for “${removeName}”. Your source files are preserved.`,
      );
      setRemoveName(null);
      refreshListing();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Couldn't remove Design registration",
      );
    } finally {
      setRemoving(false);
    }
  };
  const folders = directoryPresentation.options.filter(
    (option) => option.exists,
  );
  const disabled =
    saving || removing || !listing || !!listingError || !surfaceActive;

  return (
    <div className="flex flex-col gap-3">
      <h3
        className="text-fg2 truncate font-mono text-xs"
        title={project.repoRoot}
      >
        {project.repoRoot}
      </h3>
      <div
        className="bg-bg2 divide-border1 divide-y overflow-hidden rounded-lg"
        aria-label="Design directories"
      >
        {folders.map(({ name, selectable }) => (
          <div
            key={name}
            className="flex min-w-0 items-center gap-3 px-4 py-3"
            data-design-directory={name}
          >
            <Folder
              className="text-fg3 size-4 shrink-0"
              strokeWidth={1.5}
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1">
              <DesignFolderName
                name={name}
                repoRoot={project.repoRoot}
                disabled={disabled}
                surfaceActive={surfaceActive}
                onRenamed={refreshListing}
              />
              <div className="text-fg3 mt-1 flex items-center gap-2 text-xs">
                {name === activeName ? (
                  <>
                    <Check className="size-3" aria-hidden="true" />
                    Active Design directory
                  </>
                ) : (
                  "Design directory"
                )}
              </div>
            </div>
            {selectable && name !== activeName && (
              <Button
                variant="ghost"
                size="sm"
                disabled={disabled}
                onClick={() => void choose(name)}
              >
                Use folder
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="text-fg3 hover:text-red-fg size-7 shrink-0"
              disabled={disabled}
              aria-label={`Remove Design registration for ${name}`}
              onClick={() => setRemoveName(name)}
            >
              <Trash2 className="size-3.5" aria-hidden="true" />
            </Button>
          </div>
        ))}
        {!folders.length && (
          <p className="text-fg3 px-4 py-4 text-sm">
            {listing
              ? "No Design directories found. Choose an existing folder or create one in Design mode."
              : "Finding Design directories…"}
          </p>
        )}
      </div>
      <AdoptDesignFolder
        key={project.repoRoot}
        repoRoot={project.repoRoot}
        surfaceActive={surfaceActive}
      />
      {listingError && (
        <p className="text-red-fg text-xs" role="alert">
          {listingError}
        </p>
      )}
      <Dialog
        open={!!removeName && surfaceActive}
        onOpenChange={(open) => {
          if (!open && !removing) setRemoveName(null);
        }}
      >
        <DialogContent className="max-w-[480px] gap-4">
          <DialogTitle>Remove Design registration?</DialogTitle>
          <DialogDescription className="flex flex-col gap-3">
            <span>
              “{removeName}” will become a regular folder. Zeros will remove its
              design.toml, saved Design metadata, registration, and unmodified
              generated rules.md.
            </span>
            <span>
              The folder and all HTML, CSS, images, and other source files will
              stay exactly as they are. Custom rules.md content is preserved.
            </span>
            <span>
              Tracked metadata removal is committed in the main checkout. You
              can choose the folder again later; canvas positions and other
              metadata-only settings will need to be rebuilt.
            </span>
          </DialogDescription>
          <DialogFooter>
            <Button
              variant="secondary"
              size="sm"
              disabled={removing}
              onClick={() => setRemoveName(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={removing}
              onClick={() => void remove()}
            >
              {removing ? "Removing…" : "Remove registration"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DesignFolderName({
  name,
  repoRoot,
  disabled,
  surfaceActive,
  onRenamed,
}: {
  name: string;
  repoRoot: string;
  disabled: boolean;
  surfaceActive: boolean;
  onRenamed: () => void;
}) {
  const bridge = useBridge();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const active = useRef(surfaceActive);
  active.current = surfaceActive;
  const submit = async () => {
    if (submitting.current || !active.current || disabled || !bridge) return;
    const to = draft.trim();
    if (!to || to === name) {
      setEditing(false);
      setDraft(name);
      return;
    }
    submitting.current = true;
    setBusy(true);
    try {
      await bridgeDesignRenameDirectory(bridge, { repoRoot, from: name, to });
      setEditing(false);
      onRenamed();
      toast.success(`Renamed Design folder to “${to}”`);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Couldn't rename the Design folder",
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  const edit = () => {
    setDraft(name);
    setEditing(true);
  };
  return editing ? (
    <Input
      autoFocus
      value={draft}
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setDraft(event.target.value)}
      disabled={busy || disabled}
      onBlur={() => {
        if (!submitting.current) void submit();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          void submit();
        }
        if (event.key === "Escape") {
          event.preventDefault();
          // Prevent the unmount blur from committing a cancelled edit.
          submitting.current = true;
          setDraft(name);
          setEditing(false);
          queueMicrotask(() => {
            submitting.current = false;
          });
        }
      }}
      spellCheck={false}
      autoComplete="off"
      aria-label="New design folder name"
      className="h-7 font-mono text-[13px]"
    />
  ) : (
    <div className="group flex min-w-0 items-center gap-1">
      <button
        type="button"
        className="text-fg1 focus-visible:ring-border1 min-w-0 truncate rounded font-mono text-[13px] focus-visible:ring-1 focus-visible:outline-none"
        disabled={disabled}
        onDoubleClick={edit}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === "F2") {
            event.preventDefault();
            edit();
          }
        }}
        aria-label={`Design folder ${name}`}
        title="Double-click to rename"
      >
        {name}
      </button>
      <Button
        variant="ghost"
        size="icon"
        className="text-fg3 size-6 shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        disabled={disabled}
        aria-label={`Rename ${name}`}
        onClick={edit}
      >
        <Pencil className="size-3" aria-hidden="true" />
      </Button>
    </div>
  );
}

function AdoptDesignFolder({
  repoRoot,
  surfaceActive,
}: {
  repoRoot: string;
  surfaceActive: boolean;
}) {
  const bridge = useBridge();
  const [preview, setPreview] = useState<DesignFolderPreviewWire | null>(null);
  const [busyTicket, setBusyTicket] = useState<number | null>(null);
  const request = useRef(0);
  const active = useRef(surfaceActive);
  if (active.current && !surfaceActive) request.current += 1;
  active.current = surfaceActive;
  const busy = busyTicket !== null && busyTicket === request.current;
  useEffect(
    () => () => {
      request.current += 1;
    },
    [],
  );
  const pick = async () => {
    if (!bridge || busy || !active.current) return;
    const ticket = ++request.current;
    setBusyTicket(ticket);
    try {
      const folder = await dialogPickFolder({
        title: "Choose an existing Design folder",
        defaultPath: repoRoot,
      });
      if (!folder || ticket !== request.current || !active.current) return;
      const result = await bridgePreviewExistingDesignDirectory(
        bridge,
        repoRoot,
        folder,
      );
      if (ticket === request.current && active.current) setPreview(result);
    } catch (error) {
      if (ticket === request.current && active.current)
        toast.error(
          error instanceof Error
            ? error.message
            : "Couldn't inspect this folder",
        );
    } finally {
      if (ticket === request.current) setBusyTicket(null);
    }
  };
  const adopt = async () => {
    if (!bridge || !preview || busy || !active.current) return;
    const ticket = ++request.current;
    setBusyTicket(ticket);
    try {
      const result = await bridgeAdoptDesignDirectory(
        bridge,
        repoRoot,
        preview,
      );
      designDirectoryListingCache.invalidate(repoRoot);
      if (ticket === request.current && active.current) {
        setPreview(null);
        toast.success(
          result.selected
            ? `Design folder set to “${preview.directory}”`
            : `Added “${preview.directory}”. Commit it and update your workspaces before selecting it. Their current Design folders stay active.`,
        );
      }
    } catch (error) {
      if (ticket === request.current && active.current)
        toast.error(
          error instanceof Error ? error.message : "Couldn't use this folder",
        );
    } finally {
      if (ticket === request.current) setBusyTicket(null);
    }
  };
  return (
    <div className="mt-3 flex flex-col items-start gap-2">
      <Button
        variant="secondary"
        size="sm"
        disabled={busy || !bridge || !surfaceActive}
        onClick={() => void pick()}
      >
        {busy ? "Preparing folder…" : "Use existing folder…"}
      </Button>
      {preview && (
        <div className="flex flex-col items-start gap-2">
          <p className="text-fg2 text-xs">
            Use “{preview.directory}” as a Design folder ({preview.frameCount}{" "}
            frames).
          </p>
          <p className="text-muted-fg text-xs">
            {preview.metadataSource === "rebuild"
              ? "No saved metadata was found. Zeros will create design.toml from the existing files; previous canvas positions and metadata-only settings cannot be recovered."
              : preview.metadataSource === "git"
                ? "Zeros will restore the saved metadata from Git and keep its Design identity."
                : "Zeros will keep this folder’s existing Design identity and metadata."}
          </p>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={busy || !surfaceActive}
              onClick={() => void adopt()}
            >
              Use folder
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy || !surfaceActive}
              onClick={() => setPreview(null)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
