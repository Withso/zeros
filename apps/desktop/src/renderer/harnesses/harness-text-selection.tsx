// Real content/control primitives under the desktop cascade. Synthetic owner
// identities exercise the same presentation without filesystem or provider IO.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { CodeView } from "@pierre/diffs/react";
import { parsePatchFiles } from "@pierre/diffs";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { TextMessage } from "../features/agent/renderers/text-message";
import { EventRowRenderer } from "../features/agent/renderers/event-row-renderer";
import { CodeWithGutter } from "../features/agent/renderers/highlighted-code";
import { QuestionCard } from "../features/agent/question-card";
import { QueuedMessagesCard } from "../features/agent/queued-messages-card";
import { PermissionCard } from "../features/agent/permission-card";
import type { RendererContext } from "../features/agent/renderers/types";
import { useComposerEditor } from "../features/agent/composer-editor";
import { CodeEditor } from "../shell/workbench/tabs/code-editor";
import { MarkdownPreview } from "../shell/workbench/tabs/file-viewer";
import { zerosCodeViewOptions } from "../shared/theme/diff-theme";
import { Button } from "../shared/ui/primitives/button";
import { Input } from "../shared/ui/primitives/input";
import { Textarea } from "../shared/ui/primitives/textarea";
import { CodeBlock } from "../shared/ui/primitives/elements/code-block";
import { TooltipProvider } from "../shared/ui/primitives/tooltip";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "../shared/ui/primitives/dialog";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "../shared/ui/primitives/popover";
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
const patch =
  "--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-const before = 1;\n+const after = 2;\n";
const items = [
  {
    type: "diff" as const,
    id: "example.ts",
    fileDiff: parsePatchFiles(patch)[0].files[0],
  },
];
const diffOptions = zerosCodeViewOptions({
  diffStyle: "unified",
  disableFileHeader: true,
});

function Composer({ cwd }: { cwd: string }) {
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
    initialContent: {
      json: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Editable composer message" }],
          },
        ],
      },
      attachments: [],
    },
  });
  return (
    <div
      data-testid="composer"
      className="border-border2 bg-bg2 rounded-lg border p-3"
    >
      {composer.editorContent}
      {composer.suggestionPopup}
    </div>
  );
}

function TerminalFixture() {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const terminal = new Terminal({
      cols: 40,
      rows: 3,
      allowProposedApi: true,
      screenReaderMode: true,
    });
    terminal.open(host.current!);
    terminal.write("Terminal output remains selectable");
    terminal.onSelectionChange(() => {
      host.current!.dataset.selection = terminal.getSelection();
    });
    return () => terminal.dispose();
  }, []);
  return <div ref={host} data-testid="terminal" />;
}

function Harness() {
  const [workspace, setWorkspace] = useState(workspaces[0]);
  const [streamed, setStreamed] = useState(false);
  const [code, setCode] = useState("const editable = 1;");
  const [showRequests, setShowRequests] = useState(false);
  const ctx = {
    ...context,
    chatId: workspace.cwd,
    attachmentCwd: workspace.cwd,
  };
  return (
    <TooltipProvider>
      <main
        data-zeros-root=""
        data-testid="shell"
        tabIndex={-1}
        className="bg-bg1 text-fg1 min-h-screen p-4"
      >
        <header
          data-tauri-drag-region=""
          className="flex items-center gap-3 pb-4"
        >
          <span data-testid="title">Workspace application title</span>
          <Button onClick={() => setPrefs({ mode: "dark" })}>Dark theme</Button>
          <Button onClick={() => setPrefs({ mode: "light" })}>
            Light theme
          </Button>
          <Button onClick={() => setStreamed(true)}>Append reply</Button>
          <Button onClick={() => setShowRequests(true)}>
            Inspect request content
          </Button>
        </header>
        <div className="grid grid-cols-[190px_1fr_400px] items-start gap-4">
          <aside className="flex flex-col gap-3">
            <p data-testid="sidebar-label">Workspaces and repositories</p>
            {workspaces.map((item) => (
              <Button key={item.name} onClick={() => setWorkspace(item)}>
                {item.name}
              </Button>
            ))}
            <output data-testid="workspace-key">{workspace.cwd}</output>
            <a
              data-testid="chrome-link"
              href="https://example.com/settings"
              onClick={(event) => event.preventDefault()}
            >
              Application settings
            </a>
            <img
              data-testid="chrome-image"
              alt="App icon"
              width="32"
              height="32"
              src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32'%3E%3Crect width='32' height='32' fill='gray'/%3E%3C/svg%3E"
            />
            <div
              data-testid="draggable-tab"
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData("text/plain", "tab");
              }}
            >
              Reorder conversation tab
            </div>
            <Dialog>
              <DialogTrigger asChild>
                <Button>Open dialog</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogTitle>Application dialog title</DialogTitle>
                <DialogDescription>
                  Application dialog explanation
                </DialogDescription>
                <Input
                  aria-label="Dialog input"
                  defaultValue="Editable dialog value"
                />
              </DialogContent>
            </Dialog>
            <Popover>
              <PopoverTrigger asChild>
                <Button>Open popover</Button>
              </PopoverTrigger>
              <PopoverContent>
                <p>Application popover explanation</p>
                <Input
                  aria-label="Popover input"
                  defaultValue="Editable popover value"
                />
              </PopoverContent>
            </Popover>
          </aside>
          <section
            key={workspace.cwd}
            className="min-w-0 space-y-3"
            aria-label="Conversation"
          >
            <div data-testid="user-message">
              <TextMessage
                message={{
                  id: "user",
                  kind: "text",
                  role: "user",
                  text: "User message remains selectable",
                  createdAt: 1,
                }}
                ctx={ctx}
              />
            </div>
            <div data-testid="assistant-message">
              <TextMessage
                message={{
                  id: "assistant",
                  kind: "text",
                  role: "agent",
                  text: `Assistant **formatted output** and [a link](https://example.com) with \`inline code\`.${streamed ? " Appended reply remains selectable." : ""}\n\n- List output\n\n| Result | Value |\n| --- | --- |\n| Table output | 42 |\n\n\`\`\`ts\nconst chatCode = 42;\n\`\`\``,
                  createdAt: 2,
                }}
                ctx={ctx}
              />
            </div>
            <div data-testid="system-message">
              <TextMessage
                message={{
                  id: "system",
                  kind: "text",
                  role: "system",
                  text: "Provider message remains selectable",
                  createdAt: 3,
                }}
                ctx={ctx}
              />
            </div>
            <div data-testid="thinking">
              <EventRowRenderer
                message={{
                  id: "thinking",
                  kind: "text",
                  role: "thought",
                  text: "Thinking output remains selectable",
                  createdAt: 4,
                }}
                ctx={ctx}
              />
            </div>
            <div data-testid="tool">
              <EventRowRenderer
                message={{
                  id: "tool",
                  kind: "tool",
                  toolCallId: "tool",
                  title: "Bash",
                  toolKind: "execute",
                  status: "completed",
                  rawInput: { command: "echo selectable" },
                  rawOutput: {
                    exitCode: 0,
                    output: "Tool output remains selectable",
                  },
                  createdAt: 5,
                  updatedAt: 6,
                }}
                ctx={ctx}
              />
            </div>
            <div data-testid="read-output">
              <CodeWithGutter
                code="Read output remains selectable"
                lang="text"
                startLine={10}
              />
            </div>
            <div data-testid="nested-output" className="zeros-agent-md">
              <p>Nested agent report remains selectable</p>
              <Button>Output action label</Button>
              <Button asChild>
                <a href="#action">Linked output action</a>
              </Button>
            </div>
            <p data-testid="footer">Application duration and status</p>
            <Composer cwd={workspace.cwd} />
          </section>
          <section className="min-w-0 space-y-3" aria-label="Workbench">
            <p data-testid="workbench-label">Checks and review controls</p>
            <label>
              Application field label
              <Input
                aria-label="Settings input"
                defaultValue="Editable settings value"
              />
            </label>
            <Textarea
              aria-label="Settings textarea"
              defaultValue="Editable multiline value"
            />
            <Input
              aria-label="Read-only input"
              defaultValue="Copyable read-only value"
              readOnly
            />
            <div
              contentEditable="plaintext-only"
              suppressContentEditableWarning
              data-testid="plaintext-editor"
            >
              Plaintext editor value
            </div>
            <div
              ref={(element) => {
                element?.setAttribute("contenteditable", "");
              }}
              suppressContentEditableWarning
              data-testid="empty-attribute-editor"
            >
              Empty attribute editor value
            </div>
            <div contentEditable={false} data-testid="noneditable-label">
              Noneditable application label
            </div>
            <div data-testid="readonly-code" className="h-16">
              <CodeEditor
                value="const readonly = 1;"
                filePath="example.ts"
                readOnly
              />
            </div>
            <div data-testid="editable-code" className="h-16">
              <CodeEditor
                value={code}
                filePath="example.ts"
                onChange={setCode}
              />
            </div>
            <div data-testid="markdown-preview">
              <MarkdownPreview html="<p>Repository markdown remains selectable</p>" />
            </div>
            <div data-testid="diff" className="relative h-32">
              <CodeView
                items={items}
                options={diffOptions}
                className="absolute inset-0 overflow-auto"
              />
            </div>
            <TerminalFixture />
            <iframe
              title="Workspace preview"
              srcDoc="<p>Embedded preview remains selectable</p>"
              className="h-12 w-full"
            />
          </section>
        </div>
        {showRequests && (
          <section
            className="mx-auto mt-6 max-w-2xl space-y-4"
            aria-label="Agent requests"
          >
            <QuestionCard
              request={{
                sessionId: "selection" as never,
                questionId: "question",
                nativeRequestId: "question",
                source: "native_rpc",
                blocking: false,
                questions: [
                  {
                    id: "q",
                    prompt: "Agent question remains selectable",
                    options: [{ id: "one", label: "First option" }],
                    allowOther: true,
                  },
                ],
              }}
              onRespond={() => {}}
            />
            <QuestionCard
              request={{
                sessionId: "selection" as never,
                questionId: "approval",
                nativeRequestId: "approval",
                source: "native_rpc",
                blocking: false,
                allowDecline: true,
                questions: [
                  {
                    id: "approval",
                    prompt: "Agent approval remains selectable",
                    presentation: "one_click_approval",
                    options: [{ id: "accept", label: "Allow" }],
                    allowOther: false,
                  },
                ],
              }}
              onRespond={() => {}}
            />
            <QueuedMessagesCard
              messages={[
                {
                  id: "queued",
                  kind: "text",
                  role: "user",
                  text: "Queued user message remains selectable",
                  createdAt: 1,
                  queued: true,
                },
              ]}
              selectedId={null}
              editingId={null}
              collapsed={false}
              onToggleCollapsed={() => {}}
              onSelect={() => {}}
              onEdit={() => {}}
              onSaveEdit={() => {}}
              saveDisabled={false}
              onDelete={() => {}}
              onSendNow={() => {}}
              steeringSupported
              streaming={false}
              agentName="Codex"
            />
            <PermissionCard
              request={{
                sessionId: "selection" as never,
                toolCall: {
                  toolCallId: "permission",
                  title: "Bash",
                  kind: "execute",
                  status: "pending",
                  rawInput: {
                    command: "echo permission",
                    description: "Agent permission description",
                  },
                },
                options: [],
              }}
              onRespond={() => {}}
            />
            <CodeBlock filename="output.log">
              <pre data-testid="diagnostic-output">
                Diagnostic output remains selectable
              </pre>
            </CodeBlock>
          </section>
        )}
      </main>
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
