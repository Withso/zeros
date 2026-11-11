// Production transcript rows, sessions store and unread state; only the bridge frame is a fixture.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import { createRoot } from "react-dom/client";
import type { AgentToolMessage } from "@zeros/protocol/agent-messages";
import { EventRowRenderer } from "../features/agent/renderers/event-row-renderer";
import type { RendererContext } from "../features/agent/renderers/types";
import { TooltipProvider } from "../shared/ui/primitives";
import { BLANK, setAttentionHandler, useSessionsStore } from "../features/agent/sessions-store";
import { ChatUnreadDot } from "../features/agent/chat-unread-dot";
import { setChatsInView, useChatUnread } from "../features/agent/chat-unread";
import { noteAttention } from "../platform/notify-user";
import { cloudScopedId } from "../platform/bridge/cloud-workspace-key";
import type { SessionNotification } from "../platform/bridge/agent-events";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark";
const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const chats = { simulator: cloudScopedId(target, "chat-simulator"), login: cloudScopedId(target, "chat-login") };
const args = { title: "Ready for review", message: "The login fix is ready; two tests changed.", kind: "review" };
const shapes: Array<[string, unknown, string]> = [
  ["codex", { server: "zeros_workspace", tool: "NotifyUser", arguments: args }, "zeros_workspace:NotifyUser"],
  ["claude", args, "mcp__zeros_workspace__NotifyUser"],
  ["cursor", { providerIdentifier: "zeros_workspace", toolName: "NotifyUser", args }, "MCP NotifyUser"],
];
const ctx = { attachmentCwd: `cloud://${target.organizationId}/${target.workspaceId}`, attachmentImagesActive: true, editBaselines: new Map() } as unknown as RendererContext;
const row = (id: string, rawInput: unknown, title: string, status: "completed" | "failed"): AgentToolMessage =>
  ({ kind: "tool", id, toolCallId: id, nativeToolCallId: id, title, toolKind: "mcp", status, createdAt: 1, updatedAt: 2, rawInput, content: [] }) as AgentToolMessage;

setAttentionHandler((chatId, update) => { noteAttention(chatId, update); });
for (const [name, chatId] of Object.entries(chats))
  useSessionsStore.getState().setSession(chatId, { ...BLANK, agentId: "codex", sessionId: `session-${name}`, status: "streaming" });
let sequence = 0;
/** One worker `attention` frame through the production store path. */
function deliver(chatId: string) {
  const id = `0f0e0d0c-0b0a-4908-8706-0504030201${String(++sequence).padStart(2, "0")}`;
  useSessionsStore.getState().applyBridgeUpdate({ sessionId: "s", chatId, update: { sessionUpdate: "attention", notificationId: id, ...args } } as unknown as SessionNotification);
}
Object.assign(globalThis, { __notifyUser: { deliver: (name: keyof typeof chats) => deliver(chats[name]), view: (names: Array<keyof typeof chats>) => setChatsInView(names.map(name => chats[name])),
  transcript: (name: keyof typeof chats) => useSessionsStore.getState().sessions[chats[name]]?.messages.length ?? 0 } });

function Tab({ name, label }: { name: keyof typeof chats; label: string }) {
  const unread = useChatUnread(chats[name]);
  return <div role="tab" aria-label={unread ? `${label}, unread` : label} className="bg-bg2 text-fg1 inline-flex items-center gap-2 rounded-md px-2 py-1 text-xs">
    {unread && <ChatUnreadDot />}{label}</div>;
}

function Fixture() {
  return <TooltipProvider>
    <main className="bg-bg1 text-fg1 min-h-screen space-y-4 p-6">
      <div role="tablist" aria-label="Chats" className="flex gap-2"><Tab name="simulator" label="Simulator" /><Tab name="login" label="Fix login" /></div>
      <div className="max-w-2xl space-y-2">
        {shapes.map(([provider, rawInput, title]) => <article key={provider} data-notify-row={provider}>
          <EventRowRenderer message={row(`notify-${provider}`, rawInput, title, "completed")} ctx={ctx} /></article>)}
        <article data-notify-row="failed"><EventRowRenderer message={row("notify-failed", args, "mcp__zeros_workspace__NotifyUser", "failed")} ctx={ctx} /></article>
      </div>
    </main>
  </TooltipProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
