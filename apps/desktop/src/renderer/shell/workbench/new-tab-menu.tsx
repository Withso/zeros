// ──────────────────────────────────────────────────────────
// Workbench + menu — new tabs and quick open
// ──────────────────────────────────────────────────────────

import React, { useEffect, useMemo, useRef, useState } from "react";
import { File, Globe, Plus, Smartphone, Terminal } from "lucide-react";
import { addWorkbenchTerminal, openWorkbenchTerminal } from "./open-terminal";
import { useActiveWorkspace } from "../../state/use-active-workspace";
import { prefetchSettingsForRepo } from "../../features/settings/use-settings";
import { warmSimulatorHub } from "../../features/simulators/simulator-hub-store";
import { reusableSimulatorTab } from "../../features/simulators/simulator-tab-model";
import { isCloudWorkspace } from "../../platform/bridge/cloud-workspace-key";
import { useAgentControlFeatureActive } from "../../features/settings/agent-control-rollout";
import {
  NEW_TAB_MENU_CHROME,
  NewTabEnvironmentMenu,
  NewTabEnvironmentSearchResults,
} from "./new-tab-environment-menu";

import {
  useActiveWorkbenchTabId,
  useWorkbenchTabs,
  useRecentWorkbenchBrowsers,
  useWorkspaceDispatch,
} from "@/renderer/state/store";
import { FileTypeIcon } from "@/renderer/features/agent/composer-editor/file-type-icon";
import { Button } from "@/renderer/shared/ui/primitives/button";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
} from "@/renderer/shared/ui/primitives";
import { createBrowserTab, createEmptyFilesTab, createSimulatorTab } from "./tab-model";
import { buildDirectFileOpenAction } from "./direct-file-open";
import { searchRecentBrowsers, searchWorkspaceFiles } from "./quick-open";
import { useChatCwd } from "../use-chat-cwd";
import {
  loadWorkspaceFiles,
  peekWorkspaceFiles,
} from "../workspace-files-cache";
import { looksLikeBrowserUrl, normalizeBrowserUrl } from "./tabs/localhost-url";
import {
  simulatorPlatformLabel,
  type SimulatorPlatform,
} from "@zeros/protocol/simulators";

const SIMULATOR_ITEMS: ReadonlyArray<{ value: string; platform: SimulatorPlatform }> = [
  { value: "new-ios-simulator", platform: "ios" },
  { value: "new-android-simulator", platform: "android" },
];

export function WorkbenchNewTabMenu({
  terminalFolder,
  scope,
}: {
  terminalFolder: string;
  scope: string;
}) {
  const dispatch = useWorkspaceDispatch();
  const tabs = useWorkbenchTabs();
  const activeId = useActiveWorkbenchTabId();
  const recentBrowsers = useRecentWorkbenchBrowsers();
  const cwd = useChatCwd();
  const { workspace } = useActiveWorkspace();
  const simulatorsActive = useAgentControlFeatureActive("simulators");
  const menuRef = useRef<HTMLDivElement | null>(null);
  // Whether the + palette is currently visible.
  const [open, setOpen] = useState(false);
  // The user's combined file/page/environment query.
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState("new-file");
  const [environmentOpen, setEnvironmentOpen] = useState(false);
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
  const hasFileOrBrowserResults =
    Boolean(directUrl) || browserResults.length > 0 || fileResults.length > 0;

  /** Close cleanly so every reopen starts at the default actions. */
  const close = () => {
    setOpen(false);
    setQuery("");
    setSelection("new-file");
    setEnvironmentOpen(false);
  };

  const warm = () => {
    if (cwd) void loadWorkspaceFiles(cwd).catch(() => {});
    prefetchSettingsForRepo(
      workspace?.path || workspace?.repoRoot || terminalFolder,
    );
  };

  /** Create an independent, closable Open file surface. */
  const addBlankFile = () => {
    dispatch({ type: "ADD_WORKBENCH_TAB", tab: createEmptyFilesTab() });
    close();
  };

  /** Open a blank/page Browser tab, focusing an exact page already mounted. */
  const addBrowser = (url?: string, title?: string) => {
    if (url) {
      const existing = tabs.find(
        (tab) => tab.type === "browser" && tab.url === url,
      );
      if (existing) {
        dispatch({ type: "ACTIVATE_WORKBENCH_TAB", id: existing.id });
        close();
        return;
      }
    }
    dispatch({
      type: "ADD_WORKBENCH_TAB",
      tab: createBrowserTab({ url, title }),
    });
    close();
  };

  /** Focus an existing path; otherwise consume the active blank before the
   * fixed home, allocating a collapsed File tab only when neither exists. */
  const openFile = (path: string) => {
    dispatch(
      buildDirectFileOpenAction(tabs, path, {
        preferredExistingTabId: activeId,
        preferredBlankId: activeId,
      }),
    );
    close();
  };

  const openEnvironment = (terminalId: string, title: string) => {
    openWorkbenchTerminal(terminalFolder, { terminalId, title }, scope);
    close();
  };

  // Simulators run on this Mac, so cloud workspaces don't offer them.
  const simulatorsAvailable = simulatorsActive && !isCloudWorkspace(scope);
  /** Open a Simulator tab, reusing one that has no device yet. */
  const addSimulator = (platform: SimulatorPlatform) => {
    const blank = reusableSimulatorTab(tabs, platform);
    dispatch(
      blank
        ? { type: "ACTIVATE_WORKBENCH_TAB", id: blank.id }
        : { type: "ADD_WORKBENCH_TAB", tab: createSimulatorTab(platform) },
    );
    close();
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setQuery("");
          setSelection("new-file");
          setEnvironmentOpen(false);
        }
      }}
    >
      <Tooltip label="New tab">
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="shrink-0"
            aria-label="New File, Browser, or Terminal tab"
            onPointerEnter={warm}
            onFocus={warm}
          >
            <Plus className="text-fg2 size-3.5" />
          </Button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent
        ref={menuRef}
        aria-label="New tab"
        align="start"
        sideOffset={4}
        collisionPadding={8}
        className={`${NEW_TAB_MENU_CHROME} flex max-h-[var(--radix-popover-content-available-height)] flex-col overflow-hidden p-0`}
      >
        <Command
          shouldFilter={false}
          value={selection}
          onValueChange={(value) => {
            setSelection(value);
            if (value !== "environment") setEnvironmentOpen(false);
            if (SIMULATOR_ITEMS.some((item) => item.value === value)) {
              warmSimulatorHub();
            }
          }}
          className="min-h-0 rounded-none [&_[data-slot=command-input-wrapper]]:h-10 [&_[data-slot=command-input-wrapper]]:shrink-0 [&_[data-slot=command-input-wrapper]_svg]:size-3.5"
        >
          <CommandInput
            autoFocus
            placeholder="Search files, URLs, or actions…"
            value={query}
            onValueChange={(value) => {
              setQuery(value);
              setEnvironmentOpen(false);
            }}
            onKeyDown={(event) => {
              if (
                event.key === "ArrowRight" &&
                selection === "environment" &&
                !searching
              ) {
                event.preventDefault();
                setEnvironmentOpen(true);
              }
            }}
          />
          <CommandList className="max-h-96 min-h-0">
            {!searching && (
              <CommandGroup>
                <CommandItem value="new-file" onSelect={addBlankFile}>
                  <File className="size-3.5" />
                  <span>File</span>
                </CommandItem>
                <CommandItem value="new-browser" onSelect={() => addBrowser()}>
                  <Globe className="size-3.5" />
                  <span>Browser</span>
                </CommandItem>
                <CommandItem
                  value="new-terminal"
                  onSelect={() => {
                    addWorkbenchTerminal(terminalFolder, "tab", scope);
                    close();
                  }}
                >
                  <Terminal className="size-3.5" />
                  <span>Terminal</span>
                </CommandItem>
                {simulatorsAvailable &&
                  SIMULATOR_ITEMS.map(({ value, platform }) => (
                    <CommandItem
                      key={value}
                      value={value}
                      onSelect={() => addSimulator(platform)}
                      onPointerEnter={warmSimulatorHub}
                    >
                      <Smartphone className="size-3.5" />
                      <span>{simulatorPlatformLabel(platform)}</span>
                    </CommandItem>
                  ))}
                <NewTabEnvironmentMenu
                  open={environmentOpen}
                  onOpenChange={setEnvironmentOpen}
                  terminalFolder={terminalFolder}
                  cwd={cwd ?? undefined}
                  onSelect={openEnvironment}
                  restoreSearchFocus={() => {
                    const input =
                      menuRef.current?.querySelector<HTMLInputElement>(
                        "[cmdk-input]",
                      );
                    if (input?.isConnected)
                      input.focus({ preventScroll: true });
                  }}
                />
              </CommandGroup>
            )}

            {searching && directUrl && (
              <CommandGroup heading="Browser">
                <CommandItem
                  value={`url:${directUrl}`}
                  onSelect={() => addBrowser(directUrl, "Browser")}
                >
                  <Globe className="size-3.5" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate">Open URL</div>
                    <div className="text-fg2 truncate text-xs">{directUrl}</div>
                  </div>
                </CommandItem>
              </CommandGroup>
            )}

            {searching && (
              <NewTabEnvironmentSearchResults
                terminalFolder={terminalFolder}
                cwd={cwd ?? undefined}
                query={query}
                onSelect={openEnvironment}
                showEmpty={
                  filesResolved && !filesFailed && !hasFileOrBrowserResults
                }
              />
            )}

            {searching && browserResults.length > 0 && (
              <CommandGroup heading="Recently browsed">
                {browserResults.map((entry) => (
                  <CommandItem
                    key={entry.url}
                    value={`recent:${entry.url}`}
                    onSelect={() => addBrowser(entry.url, entry.title)}
                  >
                    <Globe className="size-3.5" />
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
                    onSelect={() => openFile(file.path)}
                  >
                    {/* The file's own type glyph — the tab this row opens will
                        carry the same one (workbenchTabIconPath). */}
                    <FileTypeIcon
                      name={file.path}
                      size={14}
                      className="size-3.5"
                    />
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
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
