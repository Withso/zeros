// The Workbench Agents tab with every row state, and a side chat's branch
// banner, for ui-smoke and screenshots. Side chats must never appear in the
// tab; a question, a plan, a running and an unread child do, with a cloud
// child workspace and a child in another folder.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import { createRoot } from "react-dom/client";
import type { ChatThread } from "../state/store";
import { useWorkspaceStore } from "../state/store";
import { BLANK, useSessionsStore } from "../features/agent/sessions-store";
import { noteChatsFinished } from "../features/agent/chat-unread";
import { AgentsTab } from "../shell/workbench/tabs/agents-tab";
import { SideChatBranchBanner } from "../features/agent/side-chat-banner";
import { rememberColumnChat, setSideChatSeed } from "../features/agent/side-chat";
import { TooltipProvider } from "../shared/ui/primitives/tooltip";
import type { WorkbenchTab } from "../shell/workbench/tab-model";

const now = Date.now();
const chat = (id: string, title: string, extra: Partial<ChatThread> = {}): ChatThread => ({
  id, folder: "/repo", agentId: "claude", agentName: "Claude", model: null, effort: "high",
  permissionMode: "auto", title, createdAt: now - 10_000_000 + id.length, updatedAt: now - 3_600_000, ...extra,
});
const child = (id: string, title: string, extra: Partial<ChatThread> = {}) =>
  chat(id, title, { parentChatId: "p1", rootChatId: "p1", ...extra });

const chats: ChatThread[] = [
  chat("p1", "Research multi-agent chat UX", { createdAt: 1 }),
  chat("p2", "Test PRs in zeros-design-demo", { createdAt: 2 }),
  chat("p3", "Design tab and local dev setup", { createdAt: 3 }),
  child("c-input", "Add side chats and message hover popup"),
  child("c-plan", "Two-row workspace rows", { agentId: "codex" }),
  child("c-done", "Persist attachments on native rows", { agentId: "cursor", folder: "cloud://org-1/ws-64" }),
  child("c-run", "Add Open in submenu to agent chat menu"),
  child("c-idle", "Switch harness and model in place", { updatedAt: now - 11 * 3_600_000 }),
  child("c-other", "Update sidebar docs page", { folder: "/docs", updatedAt: now - 86_400_000 }),
  child("c-arch", "Spike: shared session store", { archived: true }),
  chat("side", "Side chat", { kind: "side", sourceChatId: "p1" }),
  // Branched before the side-chat kind existed: a Local child known by its seed.
  child("side-legacy", "Side chat", { sourceChatId: "p1" }),
  chat("term", "Claude Code · Terminal 2", { kind: "terminal" }),
];

setSideChatSeed("side-legacy", {
  sourceChatId: "p1", sourceTitle: "Research multi-agent chat UX", messageId: "m1", promptId: null,
  role: "agent", quote: "Earlier branch", pending: false, createdAt: now, sourceUpdatedAt: now,
});
// A focused side chat: the tab stays on the chat column's own session.
rememberColumnChat("/repo", "c-idle");
useWorkspaceStore.setState({ chats, activeChatId: "side" });
useSessionsStore.setState({ pendingLocalTurns: { "c-run": "turn" } });
for (const [id, pending] of [
  ["c-input", { pendingQuestions: [{ request: { blocking: true } }] }],
  ["c-plan", { pendingQuestions: [{ request: { blocking: false } }] }],
] as const) {
  useSessionsStore.getState().setSession(id, { ...BLANK, cwd: "/repo", ...pending } as never);
}
noteChatsFinished(["c-done"]);

const tab = { id: "agents", type: "agents", title: "Agents" } as WorkbenchTab;
const seed = {
  sourceChatId: "p1", sourceTitle: "Research multi-agent chat UX", messageId: "m2", promptId: "m1", role: "agent" as const,
  quote: "Login now returns people to the page they started from. src/routes/login.ts reads a returnTo parameter and redirects there after sign-in, and src/lib/redirect.ts only allows paths on this site.",
  pending: false, createdAt: now, sourceUpdatedAt: now,
};

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <main className="bg-bg1 text-fg1 flex min-h-screen items-start gap-6 p-6">
      <section id="agents-tab-panel" className="border-border1 h-[820px] w-[600px] overflow-hidden rounded-lg border">
        <AgentsTab tab={tab} active scope="/repo" />
      </section>
      <section id="side-chat-banner-panel" className="border-border1 flex w-[600px] flex-col gap-5 rounded-lg border p-7">
        <SideChatBranchBanner seed={seed} />
        <SideChatBranchBanner seed={{ ...seed, quote: "Ran pnpm test --filter auth · 42 passed" }} />
      </section>
    </main>
  </TooltipProvider>,
);
