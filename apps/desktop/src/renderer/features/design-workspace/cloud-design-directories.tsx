import { useEffect, useRef, useState } from "react";
import { Check, Folder, ArrowUp } from "lucide-react";
import { getActiveBridge } from "../../platform/bridge/active-bridge";
import {
  bridgeCloudDesignBrowseDirectories,
  bridgeCloudDesignCreateDirectory,
  bridgeCloudDesignSelectDirectory,
  bridgeDesignListDirectories,
  type DesignFolderPreviewWire,
} from "../../platform/bridge/design-bridge";
import { workspaceOp } from "../../platform/bridge/workspace-bridge";
import { Button, Input } from "../../shared/ui";
import { useCachedRead } from "../../state/use-cached-read";
import {
  cloudDesignFolderCache as foldersCache,
  designDirectoryListingCache,
  invalidateDesignDirectoryTargetReadCache,
} from "../../state/read-caches";
import { triggerGitRefresh } from "../../shell/use-git-refresh-key";
import {
  invalidateDesignWorkspaceSnapshot,
  waitForPendingDesignEdits,
} from "./state/design-workspace-cache";
import { useCloudDesignManagement } from "./use-cloud-design-management";
import { errorMessage } from "./design-workspace-error";

const folderKey = (workspaceId: string, directory: string) =>
  JSON.stringify([workspaceId, directory]);
const bridge = () => {
  const value = getActiveBridge();
  if (!value)
    throw new Error("Connect to the cloud workspace to manage Design folders.");
  return value;
};
const loadFolders = (key: string) => {
  const [workspaceId, directory] = JSON.parse(key) as [string, string];
  return bridgeCloudDesignBrowseDirectories(bridge(), workspaceId, directory);
};
export function invalidateCloudDesignDirectories(workspaceId: string): void {
  designDirectoryListingCache.invalidate(workspaceId);
  invalidateDesignDirectoryTargetReadCache();
  invalidateDesignWorkspaceSnapshot(workspaceId);
  for (const key of foldersCache.keys())
    if (JSON.parse(key)[0] === workspaceId) foldersCache.invalidate(key);
  triggerGitRefresh(workspaceId);
}

/** Shared by the cloud canvas dialog and repository settings. The picker is
 * bound to the VM checkout; it never invokes the Mac folder dialog. */
export function CloudDesignDirectories({
  workspaceId,
  active,
}: {
  workspaceId: string;
  active: boolean;
}) {
  const canManage = useCloudDesignManagement(workspaceId, active);
  const listing = useCachedRead(
    designDirectoryListingCache,
    workspaceId,
    (id) => bridgeDesignListDirectories(bridge(), id),
    { enabled: active, maxAgeMs: 10_000 },
  );
  const [newName, setNewName] = useState("");
  const [folder, setFolder] = useState<string | null>(null);
  const [preview, setPreview] = useState<DesignFolderPreviewWire | null>(null);
  const [action, setAction] = useState<{
    kind: "rename" | "remove";
    directory: string;
    name: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const running = useRef(false);
  const latest = useRef({ workspaceId, active, canManage });
  latest.current = { workspaceId, active, canManage };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const folders = useCachedRead(
    foldersCache,
    folder === null ? null : folderKey(workspaceId, folder),
    loadFolders,
    { enabled: active && canManage && folder !== null, maxAgeMs: 10_000 },
  );
  const warm = (directory: string) => {
    if (active && canManage)
      void foldersCache
        .load(
          folderKey(workspaceId, directory),
          () => loadFolders(folderKey(workspaceId, directory)),
          { maxAgeMs: 10_000 },
        )
        .catch(() => {});
  };
  const run = async (
    operation: () => Promise<unknown>,
    success?: () => void,
    mutation = true,
  ) => {
    if (!active || !canManage || running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    const current = () =>
      mounted.current &&
      latest.current.workspaceId === workspaceId &&
      latest.current.active &&
      latest.current.canManage;
    try {
      if (mutation) await waitForPendingDesignEdits(workspaceId);
      if (!current()) return;
      await operation();
      if (mutation) invalidateCloudDesignDirectories(workspaceId);
      if (current()) success?.();
    } catch (cause) {
      if (current()) {
        setError(errorMessage(cause));
        listing.refresh();
      }
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const disabled = !active || !canManage || busy;
  const choose = (directory: string) => {
    const id = listing.data?.directoryIds?.[directory];
    if (!id || !listing.data || listing.error) return;
    const expected = listing.data.directoryIds?.[listing.data.active] ?? null;
    void run(() =>
      bridgeCloudDesignSelectDirectory(bridge(), workspaceId, id, expected),
    );
  };
  const previewFolder = () => {
    if (!folder) return;
    let result: DesignFolderPreviewWire;
    void run(
      async () => {
        result = (await workspaceOp(
          bridge(),
          "design.previewExistingDirectory",
          { workspaceId, repoRoot: workspaceId, folder },
        )) as DesignFolderPreviewWire;
      },
      () => setPreview(result),
      false,
    );
  };
  return (
    <div className="flex flex-col gap-3" aria-label="Cloud Design directories">
      <p className="text-fg3 text-sm">
        Design folders belong to this cloud workspace’s checkout.
      </p>
      {!canManage && (
        <p className="text-fg3 text-sm">
          A workspace manager can create, select, rename or unregister Design
          folders.
        </p>
      )}
      {(error || listing.error) && (
        <p role="alert" className="text-red-fg text-sm">
          {error ?? listing.error?.message}
        </p>
      )}
      {listing.error && (
        <Button
          variant="ghost"
          size="sm"
          disabled={!active || busy}
          onClick={listing.refresh}
        >
          Retry directories
        </Button>
      )}
      <div className="bg-bg2 divide-border1 divide-y overflow-hidden rounded-lg">
        {listing.data?.directories.map((directory) => (
          <div
            key={directory}
            className="flex min-w-0 items-center gap-2 px-3 py-2"
          >
            <Folder aria-hidden="true" className="text-fg3 size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate" title={directory}>
              {directory}
            </span>
            {directory === listing.data?.active && (
              <Check aria-label="Active directory" className="size-4" />
            )}
            {canManage && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={
                    disabled ||
                    !!listing.error ||
                    directory === listing.data?.active
                  }
                  onClick={() => choose(directory)}
                >
                  Use folder
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={disabled}
                  onClick={() =>
                    setAction({ kind: "rename", directory, name: directory })
                  }
                >
                  Rename
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={disabled}
                  onClick={() =>
                    setAction({ kind: "remove", directory, name: directory })
                  }
                >
                  Unregister
                </Button>
              </>
            )}
          </div>
        ))}
        {!listing.data?.directories.length && (
          <p className="text-fg3 px-3 py-2 text-sm">
            {listing.loading
              ? "Finding Design folders…"
              : "No registered Design folders."}
          </p>
        )}
      </div>
      {canManage && (
        <>
          <div className="flex items-center gap-2">
            <Input
              aria-label="New Design folder"
              placeholder="Design folder name"
              value={newName}
              disabled={disabled}
              onChange={(event) => setNewName(event.target.value)}
            />
            <Button
              size="sm"
              disabled={disabled || !newName.trim()}
              onClick={() =>
                void run(
                  () =>
                    bridgeCloudDesignCreateDirectory(
                      bridge(),
                      workspaceId,
                      newName.trim(),
                    ),
                  () => setNewName(""),
                )
              }
            >
              Create folder
            </Button>
          </div>
          <Button
            variant="outline"
            disabled={disabled}
            onPointerEnter={() => warm("")}
            onFocus={() => warm("")}
            onClick={() => {
              setFolder("");
              setPreview(null);
            }}
          >
            Browse VM folders…
          </Button>
          {folder !== null && (
            <div
              className="border-border1 flex flex-col gap-2 rounded-lg border p-3"
              role="group"
              aria-label="VM folder picker"
            >
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Parent VM folder"
                  disabled={disabled || !folder}
                  onClick={() => {
                    setFolder(folder.split("/").slice(0, -1).join("/"));
                    setPreview(null);
                  }}
                >
                  <ArrowUp className="size-4" />
                </Button>
                <span className="text-fg2 min-w-0 truncate text-sm">
                  {folder || "Workspace root"}
                </span>
              </div>
              <div className="max-h-64 overflow-y-auto">
                {folders.data?.directories.map((directory) => (
                  <Button
                    key={directory}
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start"
                    disabled={disabled}
                    onPointerEnter={() => warm(directory)}
                    onFocus={() => warm(directory)}
                    onClick={() => {
                      setFolder(directory);
                      setPreview(null);
                    }}
                  >
                    <Folder className="size-4" aria-hidden="true" />
                    {directory.split("/").at(-1)}
                  </Button>
                ))}
                {folders.loading && (
                  <p className="text-fg3 text-sm">Reading VM folders…</p>
                )}
                {folders.data?.directories.length === 0 && (
                  <p className="text-fg3 text-sm">No subfolders.</p>
                )}
              </div>
              {folders.data?.truncated && (
                <p className="text-fg3 text-sm">
                  This folder exceeds the listing limit. Open a subfolder to
                  narrow the list.
                </p>
              )}
              {folders.error && (
                <Button variant="ghost" size="sm" onClick={folders.refresh}>
                  Couldn't load VM folders — Retry
                </Button>
              )}
              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setFolder(null);
                    setPreview(null);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  disabled={
                    disabled || !folder || !folders.data || !!folders.error
                  }
                  onClick={previewFolder}
                >
                  Choose this folder
                </Button>
              </div>
              {preview && (
                <>
                  <p className="text-fg2 text-sm">
                    Register “{preview.directory}” with {preview.frameCount}{" "}
                    frames? Existing source is preserved; Design metadata may be
                    upgraded.
                  </p>
                  <Button
                    size="sm"
                    disabled={disabled}
                    onClick={() =>
                      void run(
                        () =>
                          workspaceOp(bridge(), "design.adoptDirectory", {
                            workspaceId,
                            repoRoot: workspaceId,
                            folder: preview.directory,
                            revision: preview.revision,
                          }),
                        () => {
                          setFolder(null);
                          setPreview(null);
                        },
                      )
                    }
                  >
                    Register folder
                  </Button>
                </>
              )}
            </div>
          )}
          {action && (
            <div
              className="border-border1 flex flex-col gap-2 rounded-lg border p-3"
              role="group"
              aria-label="Confirm Design directory change"
            >
              <p className="text-fg2 text-sm">
                {action.kind === "rename"
                  ? `Rename “${action.directory}” in one commit? Commit or stash this folder’s changes first.`
                  : `Unregister “${action.directory}”? Source files are preserved. Tracked registration removal is committed.`}
              </p>
              {action.kind === "rename" && (
                <Input
                  aria-label="Rename Design folder"
                  value={action.name}
                  disabled={disabled}
                  onChange={(event) =>
                    setAction({ ...action, name: event.target.value })
                  }
                />
              )}
              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => setAction(null)}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  disabled={
                    disabled ||
                    (action.kind === "rename" &&
                      (!action.name.trim() || action.name === action.directory))
                  }
                  onClick={() =>
                    void run(
                      () =>
                        workspaceOp(
                          bridge(),
                          action.kind === "rename"
                            ? "design.renameDirectory"
                            : "design.removeDirectory",
                          {
                            workspaceId,
                            repoRoot: workspaceId,
                            ...(action.kind === "rename"
                              ? {
                                  from: action.directory,
                                  to: action.name.trim(),
                                }
                              : { directory: action.directory }),
                          },
                        ),
                      () => setAction(null),
                    )
                  }
                >
                  {action.kind === "rename"
                    ? "Rename and commit"
                    : "Unregister folder"}
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
