// Real tab strip and details popover; only workspace data is a fixture.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatTabs } from "../shell/conversation/chat-tabs";
import {
  ActionsCtx,
  type SessionsActions,
} from "../features/agent/sessions-context";
import { Button, TooltipProvider } from "../shared/ui/primitives";
import {
  cloudScopedId,
  cloudWorkspaceKey,
} from "../platform/bridge/cloud-workspace-key";
import { acceptCloudWorkspaceDocument } from "../state/cloud-workspace-catalog";
import type { ChatThread } from "../state/store";

const target = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
};
const folder = cloudWorkspaceKey(target);
acceptCloudWorkspaceDocument({
  id: target.workspaceId,
  organizationId: target.organizationId,
  teamId: target.organizationId,
  createdBy: target.organizationId,
  name: "Cloud workspace",
  placement: "cloud",
  status: "ready",
  version: 1,
  error: null,
  createdAt: "2026-09-26T10:00:00Z",
  updatedAt: "2026-09-26T10:00:00Z",
  deletedAt: null,
  capabilities: {
    canWrite: true,
    canManage: true,
    canStart: true,
    startUnavailableReason: null,
  },
  repository: {
    forge: "github.com",
    owner: "example",
    name: "project",
    revision: "refs/heads/main",
  },
  generation: {
    number: 1,
    architecture: "x86_64",
    resources: { cpuMillicores: 2000, memoryMiB: 4096, storageMiB: 20480 },
    observedState: "running",
    lastObservedAt: null,
  },
});
const chats: ChatThread[] = Array.from({ length: 12 }, (_, i) => ({
  id: cloudScopedId(target, `chat-${i}`),
  folder,
  agentId: "claude",
  agentName: "Claude",
  title: i === 0 ? "Workspace UI" : `Conversation ${i + 1}`,
  model: null,
  effort: "high",
  permissionMode: "auto",
  createdAt: i,
  updatedAt: i,
}));
function Harness() {
  const [cloud, setCloud] = useState(true);
  const [selected, setSelected] = useState(chats[0].id);
  return (
    <ActionsCtx.Provider value={{} as SessionsActions}>
      <TooltipProvider>
        <main className="bg-bg0 text-fg1 min-h-screen p-6">
          <div className="mb-6 flex gap-2">
            <Button onClick={() => setCloud(true)}>Cloud fixture</Button>
            <Button onClick={() => setCloud(false)}>Local fixture</Button>
          </div>
          <section className="border-border1 bg-bg1 h-[500px] max-w-[740px] overflow-hidden rounded-lg border [--pane-bg:var(--bg1)]">
            <ChatTabs
              workspaceFolder={cloud ? folder : "/fixture/local"}
              paneId="main"
              chats={chats}
              activeChatId={selected}
              historyChats={[]}
              showSyntheticUntitled={false}
              onSelectUntitled={() => {}}
              onSelectChat={setSelected}
              onPrefetchChat={() => {}}
              onCloseTab={() => {}}
              onRestoreChat={() => {}}
              onSplit={() => {}}
              canSplitRight={false}
              canSplitDown={false}
            />
          </section>
        </main>
      </TooltipProvider>
    </ActionsCtx.Provider>
  );
}
createRoot(document.getElementById("root")!).render(<Harness />);
