import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { EventStripe } from "../features/agent/renderers/event-stripe";
import type { RendererContext } from "../features/agent/renderers/types";
import type { AgentToolMessage } from "../features/agent/use-agent-session";
import { Button } from "../shared/ui/primitives/button";
import { TooltipProvider } from "../shared/ui/primitives/tooltip";
import { setPrefs } from "../shared/theme/store";

// Synthetic test artwork only. Product icons come from the user's runtime.
const icon = (color: string) =>
  `data:image/svg+xml;base64,${btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" rx="5" fill="${color}"/></svg>`)}`;
const nativeIcons: Record<string, string> = {
  "com.google.Chrome": icon("green"),
  "com.apple.Calculator": icon("blue"),
};
const images: Record<string, string> = {
  "https://example.com/favicon.ico": icon("purple"),
  "https://cdn.example.com/app.png": icon("black"),
  "https://cdn.example.com/app-dark.png": icon("white"),
};
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP0cAAAAASUVORK5CYII=";
const requests: unknown[] = [];
function bridge(host: string) {
  return {
    on: () => () => {},
    invoke: async <T,>(
      command: string,
      args?: Record<string, unknown>,
    ): Promise<T> => {
      requests.push({ host, command, args });
      document.getElementById("requests")!.textContent =
        JSON.stringify(requests);
      await new Promise((resolve) => setTimeout(resolve, 40));
      if (command === "native_app_icons")
        return Object.fromEntries(
          (args?.bundleIds as string[]).map((id) => [
            id,
            host === "a" ? (nativeIcons[id] ?? null) : null,
          ]),
        ) as T;
      if (command === "tool_artwork_images")
        return Object.fromEntries(
          (args?.urls as string[]).map((url) => [url, images[url] ?? null]),
        ) as T;
      return undefined as T;
    },
  };
}
window.__ZEROS_NATIVE__ = bridge("a");
const ctx: RendererContext = {
  isStreaming: false,
  lastMessageId: null,
  activeTurnStartedAt: 1,
  editBaselines: new Map(),
  pendingPermission: null,
  pendingQuestionToolCallIds: new Set(),
  chatId: "native-tools-fixture",
  setMode: null,
  subagentChildren: new Map(),
  respondToQuestion: () => {},
  respondToPermission: () => {},
  retrySafetyReview: async () => {},
  recordPolicy: () => {},
  editAndResubmit: () => {},
};
function call(
  id: string,
  title: string,
  surface: unknown,
  code: string,
  failed = false,
): AgentToolMessage {
  return {
    id,
    kind: "tool",
    toolKind: "mcp",
    toolCallId: id,
    title,
    status: failed ? "failed" : "completed",
    createdAt: 1,
    updatedAt: 2,
    rawInput: { server: "cua_repl", tool: "js", arguments: { title, code } },
    rawOutput: { _meta: { "codex/toolSurface": surface } },
    content: [
      {
        type: "content",
        content: {
          type: "text",
          text: failed
            ? "Accessibility access was denied by the user."
            : "Recorded result",
        },
      },
      {
        type: "content",
        content: { type: "image", mimeType: "image/png", data: png },
      },
    ],
  };
}
const chrome = {
  kind: "browserUse",
  backend: "chrome",
  browserFamily: "chrome",
  browserId: "2",
  extensionInstanceId: "profile-a",
};
const events: AgentToolMessage[] = [
  call("inventory", "Find Chrome tabs", chrome, "await cua.getState()"),
  call(
    "website",
    "Inspect website",
    {
      ...chrome,
      openTabs: [{ id: 7, url: "https://example.com/settings" }],
      screenshot: { tabId: "7", pageUrl: "https://example.com/settings" },
    },
    "await tab.getAXStateAndScreenshot()",
  ),
  call(
    "calculator",
    "Inspect Calculator",
    {
      kind: "computerUse",
      app: { kind: "appId", appId: "com.apple.Calculator" },
    },
    "await calculator.getAXStateAndScreenshot()",
  ),
  call(
    "failure",
    "Click Calculator",
    {
      kind: "computerUse",
      app: { kind: "appId", appId: "com.apple.Calculator" },
    },
    "await calculator.click()",
    true,
  ),
  {
    ...call("connector", "workos.query", null, ""),
    rawInput: {
      server: "codex_apps",
      tool: "workos.query",
      appContext: {
        connectorId: "workos",
        appName: "WorkOS",
        actionName: "Query",
      },
      _zerosToolArtwork: {
        icon: "https://cdn.example.com/app.png",
        iconDark: "https://cdn.example.com/app-dark.png",
        name: "WorkOS",
      },
    },
  },
];
function Harness() {
  const [active, setActive] = useState(true);
  const [host, setHost] = useState("a");
  const context = {
    ...ctx,
    chatId: `native-tools-${host}`,
    attachmentImagesActive: active,
  };
  return (
    <TooltipProvider>
      <main className="bg-bg1 text-fg1 mx-auto flex max-w-[760px] flex-col gap-6 p-6">
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setActive((value) => !value)}>
            Toggle active
          </Button>
          <Button
            onClick={() => {
              window.__ZEROS_NATIVE__ = bridge("b");
              setHost("b");
            }}
          >
            Switch host
          </Button>
          <Button onClick={() => setPrefs({ mode: "light" })}>
            Light theme
          </Button>
          <Button onClick={() => setPrefs({ mode: "dark" })}>Dark theme</Button>
        </div>
        <div id="transcript" hidden={!active}>
          <EventStripe
            events={events}
            ctx={context}
            live={false}
            alwaysExpanded
          />
        </div>
        <div id="collapsed" hidden={!active}>
          <EventStripe events={events} ctx={context} live={false} />
        </div>
        <output id="requests" hidden />
      </main>
    </TooltipProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Harness />);
