import React, { useCallback, useLayoutEffect, useRef, useState } from "react";
import { Search } from "lucide-react";

import {
  WorkspaceFileTree,
  type WorkspaceFileTreeHandle,
} from "./workspace-file-tree";

interface FilesSearchSidebarProps {
  cwd: string | undefined;
  reloadKey: number;
  onOpenFile: (path: string) => void;
  onOpenInNewTab: (path: string) => void;
  onClose: () => void;
}

/** Search is a peer of the tree and working-directories sidebars. Its empty
 * state deliberately paints only the search row; the file tree mounts after
 * the first non-whitespace query and uses the same base sidebar surface. */
export function FilesSearchSidebar({
  cwd,
  reloadKey,
  onOpenFile,
  onOpenInNewTab,
  onClose,
}: FilesSearchSidebarProps) {
  const [search, setSearch] = useState("");
  const treeRef = useRef<WorkspaceFileTreeHandle | null>(null);

  // The first keystroke creates the tree after the input's change event, so
  // synchronize the stable tree model in a layout effect before it can paint
  // an unfiltered listing.
  useLayoutEffect(() => {
    treeRef.current?.setSearch(search);
  }, [search]);

  const handleSearchChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      setSearch(event.currentTarget.value);
    },
    [],
  );

  const handleSearchKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        if (event.shiftKey) treeRef.current?.focusPreviousSearchMatch();
        else treeRef.current?.focusNextSearchMatch();
        return;
      }
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (search) setSearch("");
      else onClose();
    },
    [onClose, search],
  );

  return (
    <div
      data-testid="files-search-sidebar"
      className="bg-bg1 flex h-full min-h-0 flex-col overflow-hidden"
    >
      <div className="border-border1 flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <Search className="text-fg3 size-4 shrink-0" />
        <input
          autoFocus
          aria-label="Search workspace files"
          placeholder="Search…"
          value={search}
          onChange={handleSearchChange}
          onKeyDown={handleSearchKeyDown}
          className="placeholder:text-fg3 text-fg1 h-full min-w-0 flex-1 bg-transparent text-xs outline-hidden"
        />
      </div>
      {search.trim() && (
        <div className="min-h-0 flex-1">
          <WorkspaceFileTree
            ref={treeRef}
            cwd={cwd}
            reloadKey={reloadKey}
            deselectAfterOpen
            onOpenFile={onOpenFile}
            onOpenInNewTab={onOpenInNewTab}
          />
        </div>
      )}
    </div>
  );
}
