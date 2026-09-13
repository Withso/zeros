// Development-only harness: real retained FileViewer effects against slow,
// explicitly released bridge reads. No repository or native process is used.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";

import React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { setActiveBridge } from "../platform/bridge/active-bridge";
import { TooltipProvider } from "../shared/ui/primitives/tooltip";
import { FileViewer } from "../shell/workbench/tabs/file-viewer";
import {
  invalidateWorkspaceFileData,
  prefetchWorkspaceFileDiff,
} from "../shell/workspace-file-data-cache";

const workspaceId = "/workspace-prefetch";
const requests: { op: string; path: string }[] = [];
const pending: (() => void)[] = [];
setActiveBridge({
  status: "connected",
  on: () => () => {},
  onStatusChange: () => () => {},
  request: async (message: {
    op?: string;
    params?: Record<string, unknown>;
  }) => {
    const op = message.op ?? "";
    const path = String(message.params?.filePath ?? message.params?.path ?? "");
    requests.push({ op, path });
    let result: unknown = {};
    if (op === "git.diff") {
      await new Promise<void>((resolve) => pending.push(resolve));
      result = { hunks: [], patch: "" };
    } else if (op === "file.read") {
      const content = `Contents of ${path}`;
      result = { kind: "text", path, content, bytes: content.length };
    } else if (op === "workspace.list") {
      result = [];
    }
    return { type: "WORKSPACE_RESPONSE", result };
  },
} as never);

const root = createRoot(document.getElementById("root")!);
let revision = 0;
const harness = {
  requests,
  render(active: boolean, path: string) {
    flushSync(() => {
      root.render(
        <TooltipProvider>
          <main
            className="bg-bg1 text-fg1 h-[500px] w-[700px]"
            {...(!active ? { inert: "" } : {})}
            aria-hidden={!active}
            style={{ visibility: active ? "visible" : "hidden" }}
          >
            <FileViewer
              key={path}
              tabId="prefetch-viewer"
              cwd={workspaceId}
              workspaceId={workspaceId}
              path={path}
              diff
              diffScope="staged"
              active={active}
              refreshKey={revision}
            />
          </main>
        </TooltipProvider>,
      );
    });
  },
  prefetch(path: string) {
    prefetchWorkspaceFileDiff({ workspaceId, path, diffScope: "staged" });
  },
  invalidate() {
    revision += 1;
    invalidateWorkspaceFileData(workspaceId, workspaceId);
  },
  release() {
    for (const resolve of pending.splice(0)) resolve();
  },
};

declare global {
  interface Window {
    __zerosFilePrefetchHarness: typeof harness;
  }
}
window.__zerosFilePrefetchHarness = harness;
