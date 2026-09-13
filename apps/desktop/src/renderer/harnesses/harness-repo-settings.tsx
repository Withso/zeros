// Development-only navigation fixture using the real repository page and store.
// Transport reads are synthetic; no checkout or Design file is modified.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import React from "react";
import { createRoot } from "react-dom/client";
import { RepoPage } from "../features/repositories/repo-page";
import {
  ActionsCtx,
  type SessionsActions,
} from "../features/agent/sessions-context";
import { BridgeProvider } from "../platform/bridge/use-bridge";
import { RuntimeClient } from "../platform/bridge/ws-client";
import type { BridgeMessage } from "../platform/bridge/messages";
import { Button } from "../shared/ui/primitives/button";
import { TooltipProvider } from "../shared/ui/primitives/tooltip";
import { upsertProject } from "../state/projects-store";
import { useWorkspaceStore } from "../state/workspace-store";

const projects = [
  upsertProject({ repoRoot: "/fixture/settings-alpha", name: "Alpha" }),
  upsertProject({ repoRoot: "/fixture/settings-beta", name: "Beta" }),
];
// There are no workspace rows or agent actions in this settings-only fixture.
const sessions = {} as SessionsActions;
const state = useWorkspaceStore.getState();
state.dispatch({
  type: "OPEN_REPO_PAGE",
  projectId:
    projects.find((project) => project.id === state.activeRepoId)?.id ??
    projects[0].id,
});

const folderNames = new Map<string, string[]>();
Object.defineProperty(RuntimeClient.prototype, "status", {
  get: () => "connected",
});
RuntimeClient.prototype.connect = () => Promise.resolve();
RuntimeClient.prototype.request = async function <
  T extends BridgeMessage = BridgeMessage,
>(message: Partial<BridgeMessage> & { type: string }): Promise<T> {
  const request = message as {
    op?: string;
    params?: Record<string, unknown>;
    requestId?: string;
  };
  const root = String(
    request.params?.repoRoot ?? request.params?.workspaceId ?? "user",
  );
  const directory = root.endsWith("beta") ? "Beta - Design" : "Alpha - Design";
  let result: unknown = {};
  if (request.op === "settings.resolve")
    result = { effective: {}, sources: {}, warnings: [] };
  if (request.op === "settings.read")
    result = {
      doc: {},
      text: "",
      exists: false,
      path: `${root}/.zeros/settings.local.toml`,
    };
  if (request.op === "workspace.list") result = { workspaces: [] };
  const names = folderNames.get(root) ?? [directory];
  if (request.op === "design.renameDirectory") {
    folderNames.set(
      root,
      names.map((name) =>
        name === request.params?.from ? String(request.params.to) : name,
      ),
    );
    const counter = document.getElementById("design-renames");
    if (counter) counter.textContent = String(Number(counter.textContent) + 1);
  }
  if (request.op === "design.removeDirectory") {
    folderNames.set(
      root,
      names.filter((name) => name !== request.params?.directory),
    );
    const counter = document.getElementById("design-removals");
    if (counter) counter.textContent = String(Number(counter.textContent) + 1);
  }
  if (request.op === "design.listDirectories") {
    result = {
      directories: names,
      directoryIds: { [directory]: "fixture-design" },
      pointer: directory,
      active: directory,
      target: names.length ? { directory: names[0], exists: true } : null,
    };
    const counter = document.getElementById("design-reads");
    if (counter) counter.textContent = String(Number(counter.textContent) + 1);
  }
  return {
    type: "WORKSPACE_RESPONSE",
    requestId: request.requestId ?? "fixture",
    result,
  } as T;
};

function Harness() {
  const projectId = useWorkspaceStore((snapshot) => snapshot.activeRepoId);
  const project =
    projects.find((candidate) => candidate.id === projectId) ?? projects[0];
  return (
    <TooltipProvider>
      <ActionsCtx.Provider value={sessions}>
        <BridgeProvider>
          <main className="bg-bg1 flex h-screen flex-col">
            <nav
              aria-label="Fixture repositories"
              className="flex shrink-0 gap-2 p-2"
            >
              {projects.map((candidate) => (
                <Button
                  key={candidate.id}
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    useWorkspaceStore.getState().dispatch({
                      type: "OPEN_REPO_PAGE",
                      projectId: candidate.id,
                    })
                  }
                >
                  {candidate.name}
                </Button>
              ))}
            </nav>
            <RepoPage project={project} />
            <output id="design-renames" hidden>
              0
            </output>
            <output id="design-removals" hidden>
              0
            </output>
            <output id="design-reads" hidden>
              0
            </output>
          </main>
        </BridgeProvider>
      </ActionsCtx.Provider>
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
