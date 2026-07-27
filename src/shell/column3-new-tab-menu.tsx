// ──────────────────────────────────────────────────────────
// Column 3 + menu — new File/Browser + quick open
// ──────────────────────────────────────────────────────────

import React, { useEffect, useMemo, useState } from "react";
import { File, Globe, Plus } from "lucide-react";

import {
  useActiveColumn3TabId,
  useColumn3Tabs,
  useRecentColumn3Browsers,
  useWorkspaceDispatch,
} from "@/zeros/store/store";
import { Button } from "@/zeros/ui/primitives/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
} from "@/zeros/ui/primitives";
import {
  createBrowserTab,
  createEmptyFilesTab,
  createFilesTab,
} from "./column3-tab-manager";
import {
  searchRecentBrowsers,
  searchWorkspaceFiles,
} from "./column3-quick-open";
import { useChatCwd } from "./use-chat-cwd";
import {
  loadWorkspaceFiles,
  peekWorkspaceFiles,
} from "./workspace-files-cache";
import {
  looksLikeBrowserUrl,
  normalizeBrowserUrl,
} from "./column3-tabs/localhost-url";

export function Column3NewTabMenu() {
  const dispatch = useWorkspaceDispatch();
  const tabs = useColumn3Tabs();
  const activeId = useActiveColumn3TabId();
  const recentBrowsers = useRecentColumn3Browsers();
  const cwd = useChatCwd();
  // Whether the + palette is currently visible.
  const [open, setOpen] = useState(false);
  // The user's combined file/page query.
  const [query, setQuery] = useState("");
  // Async state carries its semantic owner. A reused menu fiber can switch cwd
  // before its effect runs; it must never search the previous workspace's rows.
  const [fileSnapshot, setFileSnapshot] = useState<{
    cwd: string;
    files: string[];
    resolved: boolean;
    error: boolean;
  } | null>(null);
  const peekedFiles = cwd ? peekWorkspaceFiles(cwd) : null;
  const exactSnapshot = fileSnapshot?.cwd === cwd ? fileSnapshot : null;
  const files = useMemo(
    () => exactSnapshot?.files ?? peekedFiles ?? [],
    [exactSnapshot, peekedFiles],
  );
  const filesResolved = exactSnapshot?.resolved ?? peekedFiles !== null;
  const filesFailed = exactSnapshot?.error ?? false;

  // Load only while the palette is useful. The shared short-lived cache dedupes
  // this with the Files tree and keeps repeat opens instant.
  useEffect(() => {
    if (!open || !cwd) {
      return;
    }
    let cancelled = false;
    const retained = peekWorkspaceFiles(cwd);
    setFileSnapshot({
      cwd,
      files: retained ?? [],
      resolved: retained !== null,
      error: false,
    });
    void loadWorkspaceFiles(cwd)
      .then((next) => {
        if (!cancelled) {
          setFileSnapshot({ cwd, files: next, resolved: true, error: false });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFileSnapshot({
            cwd,
            files: retained ?? [],
            resolved: retained !== null,
            error: true,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, cwd]);

  const fileResults = useMemo(
    () => searchWorkspaceFiles(files, query),
    [files, query],
  );
  const directUrl = useMemo(
    () => (looksLikeBrowserUrl(query) ? normalizeBrowserUrl(query) : null),
    [query],
  );
  const browserResults = useMemo(
    () =>
      searchRecentBrowsers(recentBrowsers, query).filter(
        (entry) => entry.url !== directUrl,
      ),
    [recentBrowsers, query, directUrl],
  );
  const searching = query.trim().length > 0;
  const hasSearchResults =
    Boolean(directUrl) || browserResults.length > 0 || fileResults.length > 0;

  /** Close cleanly so every reopen starts at the two requested actions. */
  const close = () => {
    setOpen(false);
    setQuery("");
  };

  /** Create an independent, closable Open file surface. */
  const addBlankFile = () => {
    dispatch({ type: "ADD_COLUMN3_TAB", tab: createEmptyFilesTab() });
    close();
  };

  /** Open a blank/page Browser tab, focusing an exact page already mounted. */
  const addBrowser = (url?: string, title?: string) => {
    if (url) {
      const existing = tabs.find(
        (tab) => tab.type === "browser" && tab.url === url,
      );
      if (existing) {
        dispatch({ type: "ACTIVATE_COLUMN3_TAB", id: existing.id });
        close();
        return;
      }
    }
    dispatch({
      type: "ADD_COLUMN3_TAB",
      tab: createBrowserTab({ url, title }),
    });
    close();
  };

  /** Focus an existing path; otherwise consume a blank before allocating one. */
  const openFile = (path: string, name: string) => {
    const existing = tabs.find(
      (tab) => tab.type === "files" && tab.filePath === path,
    );
    if (existing) {
      dispatch({ type: "ACTIVATE_COLUMN3_TAB", id: existing.id });
      close();
      return;
    }
    // A blank tab is an explicit placeholder, so consume it before allocating a
    // duplicate surface. This also makes the fresh workspace's Open file tab do
    // useful work when the user searches immediately.
    const empty =
      tabs.find(
        (tab) => tab.id === activeId && tab.type === "files" && !tab.filePath,
      ) ?? tabs.find((tab) => tab.type === "files" && !tab.filePath);
    if (empty) {
      dispatch({
        type: "OPEN_COLUMN3_TAB",
        id: empty.id,
        updates: { filePath: path, title: name, viewerMode: undefined },
      });
    } else {
      dispatch({ type: "ADD_COLUMN3_TAB", tab: createFilesTab(path) });
    }
    close();
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <Tooltip label="New tab">
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="shrink-0"
            aria-label="New File or Browser tab"
          >
            <Plus className="size-3.5" />
          </Button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent
        align="start"
        sideOffset={4}
        className="w-96 overflow-hidden p-0"
      >
        <Command shouldFilter={false}>
          <CommandInput
            autoFocus
            placeholder="Open any file or URL…"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList className="max-h-96">
            {!searching && (
              <CommandGroup>
                <CommandItem value="new-file" onSelect={addBlankFile}>
                  <File className="size-4" />
                  <span>File</span>
                </CommandItem>
                <CommandItem value="new-browser" onSelect={() => addBrowser()}>
                  <Globe className="size-4" />
                  <span>Browser</span>
                </CommandItem>
              </CommandGroup>
            )}

            {searching && directUrl && (
              <CommandGroup heading="Browser">
                <CommandItem
                  value={`url:${directUrl}`}
                  onSelect={() => addBrowser(directUrl, "Browser")}
                >
                  <Globe className="size-4" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate">Open URL</div>
                    <div className="text-fg2 truncate text-xs">{directUrl}</div>
                  </div>
                </CommandItem>
              </CommandGroup>
            )}

            {searching && browserResults.length > 0 && (
              <CommandGroup heading="Recently browsed">
                {browserResults.map((entry) => (
                  <CommandItem
                    key={entry.url}
                    value={`recent:${entry.url}`}
                    onSelect={() => addBrowser(entry.url, entry.title)}
                  >
                    <Globe className="size-4" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate">{entry.title || "Browser"}</div>
                      <div className="text-fg2 truncate text-xs">
                        {entry.url}
                      </div>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {searching && fileResults.length > 0 && (
              <CommandGroup heading="Files">
                {fileResults.map((file) => (
                  <CommandItem
                    key={file.path}
                    value={`file:${file.path}`}
                    onSelect={() => openFile(file.path, file.name)}
                  >
                    <File className="size-4" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate">{file.name}</div>
                      {file.directory && (
                        <div className="text-fg2 truncate text-xs">
                          {file.directory}
                        </div>
                      )}
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {searching && filesFailed && fileResults.length === 0 && (
              <div className="text-fg2 px-3 py-4 text-center text-xs">
                Files are temporarily unavailable.
              </div>
            )}
            {searching &&
              filesResolved &&
              !filesFailed &&
              !hasSearchResults && (
                <CommandEmpty>No matching files or pages.</CommandEmpty>
              )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
