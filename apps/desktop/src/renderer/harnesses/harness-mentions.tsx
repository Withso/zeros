// Development-only harness for the real TipTap composer and async @ picker.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { TooltipProvider } from "../shared/ui/primitives/tooltip";
import { Button } from "../shared/ui/primitives/button";
import { useComposerEditor } from "../features/agent/composer-editor/use-composer-editor";
import { setActiveBridge } from "../platform/bridge/active-bridge";
import type { RuntimeClient } from "../platform/bridge/ws-client";
import {
  workspacePathScore,
  normalizeWorkspacePathQuery,
} from "@zeros/protocol/workspace-paths";
import { triggerGitRefresh } from "../shell/use-git-refresh-key";

const files = [
  ".context/attachments/rollout.jsonl",
  ".context/attachments/Screenshot at 7.31 AM.png",
  ".hidden/.config",
  ".empty/",
];
const requests: Record<string, unknown>[] = [];
let paused: Promise<void> | undefined;
let resume: (() => void) | undefined;
let pending = 0;
declare global {
  interface Window {
    mentionHarness: {
      pause: () => void;
      resume: () => void;
      addPath: (path: string) => void;
      pending: () => number;
    };
  }
}
window.mentionHarness = {
  pause: () => {
    paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
  },
  resume: () => {
    resume?.();
    paused = undefined;
  },
  addPath: (path) => {
    files.push(path);
    triggerGitRefresh("/a");
  },
  pending: () => pending,
};
setActiveBridge({
  request: async (message: { op: string; params: Record<string, unknown> }) => {
    const params = message.params;
    if (message.op === "workspace.list")
      return {
        type: "WORKSPACE_RESPONSE",
        result: { workspaces: [] },
      };
    if (message.op === "file.tree") {
      requests.push(params);
      pending += 1;
      await paused;
      pending -= 1;
      const query = normalizeWorkspacePathQuery(String(params.query ?? ""));
      const paths = params.workspaceId === "/b" ? ["b-only.txt"] : files;
      return {
        type: "WORKSPACE_RESPONSE",
        result: {
          files:
            params.includeIgnored === true
              ? paths.filter(
                  (p) =>
                    workspacePathScore(query, {
                      path: p.replace(/\/$/, ""),
                      kind: p.endsWith("/") ? "folder" : "file",
                    }) !== null,
                )
              : [],
        },
      };
    }
    return { type: "WORKSPACE_RESPONSE", result: {} };
  },
  onStatusChange: () => () => {},
  on: () => () => {},
} as unknown as RuntimeClient);

function Harness() {
  const [cwd, setCwd] = useState("/a");
  const [sent, setSent] = useState("");
  const composer = useComposerEditor({
    cwd,
    agentId: null,
    agentName: null,
    agentSupportsImage: false,
    modelId: null,
    originUrl: null,
    availableCommands: [],
    placeholder: "Message",
    stageIntoContextGraph: false,
    onSubmit: () => setSent(JSON.stringify(composer.serialize())),
  });
  return (
    <TooltipProvider>
      <div className="bg-bg1 flex h-screen flex-col gap-3 p-10">
        <div className="flex gap-2">
          <Button onClick={() => setCwd(cwd === "/a" ? "/b" : "/a")}>
            Switch workspace
          </Button>
          <Button
            onClick={() => {
              files.push(".context/attachments/new-attachment.txt");
              triggerGitRefresh("/a");
            }}
          >
            Create attachment
          </Button>
          <Button onClick={() => setSent(JSON.stringify({ requests }))}>
            Inspect requests
          </Button>
        </div>
        <div className="flex-1" />
        <div className="border-border1 relative rounded-lg border p-3">
          {composer.editorContent}
          {composer.suggestionPopup}
        </div>
        <output data-mention-sent>{sent}</output>
      </div>
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
