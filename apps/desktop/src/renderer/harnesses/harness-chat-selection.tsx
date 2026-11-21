// The chat transcript's selection popup over real messages, with the real
// composer receiving its pills, in each owner and placement. Send immediately
// appends the sent bubble here instead of reaching a provider.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { TextMessage } from "../features/agent/renderers/text-message";
import { EventRowRenderer } from "../features/agent/renderers/event-row-renderer";
import type { RendererContext } from "../features/agent/renderers/types";
import { useComposerEditor } from "../features/agent/composer-editor";
import { ChatSelectionPopup, stageChatText } from "../features/agent/chat-selection-popup";
import { formatReply, replyMessage } from "../features/agent/chat-selection";
import { Button } from "../shared/ui/primitives/button";
import { TooltipProvider } from "../shared/ui/primitives/tooltip";
import { cloudWorkspaceKey } from "../platform/bridge/cloud-workspace-key";
import { setPrefs } from "../shared/theme/store";

const workspaces = [
  { name: "Local", cwd: "/selection/personal" },
  { name: "Organization local", cwd: "/selection/organization" },
  {
    name: "Organization cloud",
    cwd: cloudWorkspaceKey({
      organizationId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
    }),
  },
];
const context: RendererContext = {
  isStreaming: false,
  lastMessageId: null,
  activeTurnStartedAt: 0,
  editBaselines: new Map(),
  pendingPermission: null,
  pendingQuestionToolCallIds: new Set(),
  chatId: "selection",
  setMode: null,
  subagentChildren: new Map(),
  respondToQuestion: () => {},
  respondToPermission: () => {},
  retrySafetyReview: async () => {},
  recordPolicy: () => {},
  editAndResubmit: () => {},
};
const answer = [
  "Two things I set that you didn’t specify:",
  "",
  "- **No push, no PR:** commits stay local on `iamarunrk/bootstrap-v153` until you say otherwise.",
  "- **Main component inspector:** it gets two tabs, Controls and Style, with no CSS tab. Because you chose full styles on the main, its root layer still needs a Style panel for fill, padding and layout, so it can’t be Controls-only like an instance.",
  "",
  "The demo repository is left untouched. Native macOS checks can’t run on this Linux VM, so those will be reported as not run.",
  "",
  "```ts",
  "const popup = placePopup({ selection, bounds, width, height });",
  "```",
].join("\n");
const filler = Array.from({ length: 12 }, (_, index) =>
  `Earlier answer ${index + 1}: the transcript is long enough to scroll, so a selection can leave the view and come back.`);

declare global {
  interface Window { sentReplies: string[] }
}
window.sentReplies = [];

function Chat({ cwd }: { cwd: string }) {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [sent, setSent] = useState<string[]>([]);
  const composer = useComposerEditor({
    cwd,
    agentId: null,
    agentName: null,
    agentSupportsImage: true,
    modelId: null,
    originUrl: null,
    availableCommands: [],
    placeholder: "Send follow up",
    onSubmit: () => {},
    discoverSkills: false,
    stageIntoContextGraph: false,
  });
  const ctx = { ...context, attachmentCwd: cwd };
  return (
    <div data-zeros-root="" className="zeros-agent-surface text-fg1 flex h-full min-h-0 flex-col text-sm">
      <div
        ref={setScroller}
        data-testid="transcript"
        className="zeros-agent-body zeros-agent-scrollbar relative isolate min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
      >
        <div className="zeros-agent-messages mx-auto flex w-full max-w-(--chat-column) min-w-0 flex-col gap-5 px-7 pt-8 pb-8">
          {filler.map((text, index) => (
            <div key={index} data-testid={`filler-${index}`}>
              <TextMessage message={{ id: `filler-${index}`, kind: "text", role: "agent", text, createdAt: index }} ctx={ctx} />
            </div>
          ))}
          <div data-testid="user-message" className="bg-bg2 w-fit max-w-7/8 min-w-0 self-end rounded-lg px-3 py-2">
            <TextMessage message={{ id: "user", kind: "text", role: "user", text: "What do you want to work on?", createdAt: 20 }} ctx={ctx} />
          </div>
          <div data-testid="thinking">
            <EventRowRenderer message={{ id: "thinking", kind: "text", role: "thought", text: "Weighing whether the inspector needs a CSS tab", createdAt: 21 }} ctx={ctx} />
          </div>
          <div data-testid="assistant-message">
            <TextMessage message={{ id: "assistant", kind: "text", role: "agent", text: answer, createdAt: 22 }} ctx={ctx} />
          </div>
          {sent.map((text, index) => (
            <div key={index} data-testid="sent-reply" className="bg-bg2 w-fit max-w-7/8 min-w-0 self-end rounded-lg px-3 py-2">
              <TextMessage message={{ id: `sent-${index}`, kind: "text", role: "user", text, createdAt: 30 + index }} ctx={ctx} />
            </div>
          ))}
        </div>
      </div>
      <div className="mx-auto w-full max-w-(--chat-column) px-7 pb-4">
        <div data-testid="composer" className="border-border2 bg-bg2 rounded-lg border p-3">
          {composer.editorContent}
          {composer.suggestionPopup}
        </div>
      </div>
      <ChatSelectionPopup
        root={scroller}
        active
        onAddSelection={(text) => stageChatText(composer.insertTextAttachment, "selection", text, text)}
        onAddReply={(quote, reply) => stageChatText(composer.insertTextAttachment, "reply", formatReply(quote, reply), reply)}
        onSendReply={(quote, reply) => {
          const message = replyMessage(quote, reply);
          window.sentReplies.push(message.text);
          setSent((current) => [...current, message.text]);
          return true;
        }}
      />
    </div>
  );
}

function Harness() {
  const [workspace, setWorkspace] = useState(workspaces[0]);
  return (
    <TooltipProvider>
      <main className="bg-bg1 text-fg1 flex h-screen flex-col">
        <nav className="flex shrink-0 gap-2 p-2" aria-label="Fixture">
          {workspaces.map((option) => (
            <Button key={option.cwd} variant="ghost" size="compact" onClick={() => setWorkspace(option)}>{option.name}</Button>
          ))}
          <Button variant="ghost" size="compact" onClick={() => setPrefs({ mode: "dark" })}>Dark theme</Button>
          <Button variant="ghost" size="compact" onClick={() => setPrefs({ mode: "light" })}>Light theme</Button>
        </nav>
        <div className="min-h-0 flex-1">
          <Chat key={workspace.cwd} cwd={workspace.cwd} />
        </div>
      </main>
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
