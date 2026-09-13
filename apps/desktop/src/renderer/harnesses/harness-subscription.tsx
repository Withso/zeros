// Fake native/provider transports around the production connection UI and
// session send actions. No real account or model requests.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  BrowserSubscriptionProvider,
  ProviderSubscriptionStatus,
} from "@zeros/protocol/provider-auth";
import { ProvidersPanel } from "../features/settings/providers-panel";
import {
  requestProviderSettings,
  subscribeProviderSettingsTab,
} from "../features/settings/settings-navigation";
import { getProviderPrefs, setProviderPrefs } from "../features/settings/provider-prefs";
import { rememberConnectionMethod } from "../features/settings/connection-methods";
import { AuthenticationNotice } from "../features/agent/authentication-notice";
import {
  useAgentSessions,
  useChatSession,
} from "../features/agent/sessions-hooks";
import { AgentSessionsProvider } from "../features/agent/sessions-provider";
import { BLANK, useSessionsStore } from "../features/agent/sessions-store";
import {
  lastUserPrompt,
  authenticationTurnState,
  authenticationTurnOutput,
} from "../features/agent/auth-prompt-recovery";
import { groupMessagesIntoTurns } from "../features/agent/turn-grouping";
import { TurnFooter } from "../features/agent/turn-footer";
import { loadAgents, refreshAgents } from "../features/agent/agents-cache";
import { registerAgentPreferencesFlush } from "../platform/agent-preferences";
import { BridgeProvider } from "../platform/bridge/use-bridge";
import { RuntimeClient } from "../platform/bridge/ws-client";
import type {
  BridgeMessage,
  BridgeRegistryAgent,
} from "../platform/bridge/messages";
import type { AgentTextMessage } from "../features/agent/use-agent-session";
import { Button } from "../shared/ui";
import { TooltipProvider } from "../shared/ui/primitives/tooltip";
import { providerAuthChanged } from "../platform/provider-auth-state";
import { useWorkspaceStore } from "../state/workspace-store";

const ids = ["claude", "codex", "cursor"] as const;
const params = new URLSearchParams(location.search);
const usageFixture = ids.find((id) => id === params.get("usage"));
let holdUsage = params.has("holdUsage");
const pendingUsage = new Set<() => void>();
const names = { claude: "Claude Code", codex: "Codex", cursor: "Cursor" };
const accounts = {
  claude: "anthropic-api-key",
  codex: "openai-api-key",
  cursor: "cursor-api-key",
};
useWorkspaceStore.setState({
  chats: ids.map((id) => ({
    id: `chat-${id}`,
    folder: "/fixture/repository",
    agentId: id,
    agentName: names[id],
    model: null,
    effort: "medium",
    permissionMode: "plan",
    title: "Authentication fixture",
    createdAt: 1,
    updatedAt: 1,
  })),
});
const listeners = new Map<string, Set<(payload: unknown) => void>>();
const statuses = new Map<
  BrowserSubscriptionProvider,
  ProviderSubscriptionStatus
>();
if (usageFixture) {
  for (const [index, provider] of ids.entries()) {
    const id = `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    setProviderPrefs(provider, { authMethod: "cli", ...(provider === "cursor" ? { cursorSubscription: true } : {}) });
    rememberConnectionMethod(provider, "account");
    statuses.set(provider, {
      provider, state: "connected", revision: 1, method: "account", email: "user@example.test", plan: "Pro", activeAccountId: id,
      accounts: [{ id, email: "user@example.test", plan: "Pro", state: "connected" }],
    });
  }
}
const secrets = new Map<string, string>();
const rows = new Map<string, AgentTextMessage[]>();
const counts = {
  browser: 0,
  reads: 0,
  usageReads: 0,
  code: 0,
  prompts: 0,
  terminals: 0,
  lastTerminalInput: "",
  terminalWrites: 0,
  replayedHistory: false,
  dispatchedAccount: "",
  terminalLoginProvider: "",
  selectedAccount: "",
  closed: 0,
  resumed: 0,
  newTurn: false,
  includedContext: false,
  newMessage: "",
  savedDuringReconnection: false,
};
let initialTurnId: string | null = null;
let staleCredentialHint = false;
const showCounts = () => {
  const el = document.getElementById("counts");
  if (el) el.textContent = JSON.stringify(counts);
};
const publish = (status: ProviderSubscriptionStatus) => {
  statuses.set(status.provider, status);
  for (const listener of listeners.get("provider-subscription-status") ?? [])
    listener(status);
  providerAuthChanged();
};
const finishAccountLogin = (
  status: ProviderSubscriptionStatus,
): ProviderSubscriptionStatus => {
  const id = crypto.randomUUID();
  const email =
    (status.accounts?.length ?? 0) === 0
      ? "user@example.test"
      : "second@example.test";
  return {
    ...status,
    state: "connected",
    email,
    plan: "Pro",
    error: undefined,
    activeAccountId: id,
    accounts: [
      ...(status.accounts ?? []),
      { id, state: "connected", email, plan: "Pro" },
    ],
  };
};
const registry = (): BridgeRegistryAgent[] =>
  ids.map((id) => ({
    id,
    name: names[id],
    version: "fixture",
    description: "",
    distribution: {},
    installed: true,
    authBinary: id,
    authenticated:
      staleCredentialHint ||
      (getProviderPrefs(id).authMethod === "apiKey"
        ? secrets.has(accounts[id])
        : statuses.get(id)?.state === "connected"),
  }));
window.__ZEROS_NATIVE__ = {
  async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    if (command === "keychain_get")
      return (secrets.get(args?.account as string) ?? null) as T;
    if (command === "keychain_set") {
      secrets.set(args?.account as string, args?.value as string);
      return undefined as T;
    }
    if (command === "keychain_delete") {
      secrets.delete(args?.account as string);
      return undefined as T;
    }
    if (command !== "provider_subscription") return undefined as T;
    const provider = args?.provider as BrowserSubscriptionProvider;
    const status = statuses.get(provider) ?? {
      provider,
      state: "disconnected",
      revision: 1,
    };
    let result: ProviderSubscriptionStatus = status;
    if (args?.action === "usage") {
      counts.usageReads++;
      showCounts();
      if (holdUsage) await new Promise<void>((resolve) => pendingUsage.add(resolve));
      return {
        provider,
        method: args.method,
        identity: JSON.stringify([
          status.email ?? null,
          status.organization ?? null,
        ]),
        ...(args.accountId ? { accountId: args.accountId } : {}),
        plan: "Pro",
        ...(provider === "claude" ? { organization: "Example team" } : {}),
        windows: (provider === "cursor" ? ["cursor", "third-party"] : ["five-hour", "weekly"]).map((id, index) => ({
          id,
          usedPercent: (status.email === "second@example.test" ? 70 : 20) + index * 10,
          resetsAt: Date.now() + (index === 0 && provider !== "cursor" ? 5 : 48) * 3_600_000,
        })),
        fetchedAt: Date.now(),
      } as T;
    }
    if (args?.action === "status") counts.reads++;
    if (args?.action === "connect") {
      counts.browser++;
      result = {
        ...status,
        provider,
        state: "connecting",
        revision: status.revision + 1,
        attemptId: crypto.randomUUID(),
        canSubmitCode: provider === "claude",
      };
      publish(result);
    }
    if (args?.action === "cancel") {
      result = {
        ...status,
        state:
          status.accounts?.find((a) => a.id === status.activeAccountId)
            ?.state ?? "disconnected",
        canSubmitCode: false,
        error: "Sign-in canceled.",
        revision: status.revision + 1,
      };
      publish(result);
    }
    if (args?.action === "select-method") {
      result = {
        ...status,
        method: args.method as ProviderSubscriptionStatus["method"],
        revision: status.revision + 1,
      };
      publish(result);
    }
    if (args?.action === "select-account") {
      const account = status.accounts?.find((a) => a.id === args.accountId);
      if (!account) throw new Error("Account not found");
      result = {
        ...status,
        state: account.state,
        email: account.email,
        plan: account.plan,
        activeAccountId: account.id,
        revision: status.revision + 1,
        error: undefined,
      };
      counts.selectedAccount = account.id;
      publish(result);
    }
    if (args?.action === "remove-account") {
      result = {
        ...status,
        accounts: status.accounts?.filter((a) => a.id !== args.accountId),
        activeAccountId: undefined,
        state: "disconnected",
        revision: status.revision + 1,
      };
      publish(result);
    }
    if (args?.action === "submit-code") {
      counts.code++;
      result = {
        ...status,
        state: "connected",
        email: "user@example.test",
        revision: status.revision + 1,
        canSubmitCode: false,
      };
      result = finishAccountLogin(result);
      publish(result);
    }
    showCounts();
    return result as T;
  },
  on<T>(name: string, listener: (value: T) => void) {
    const handlers = listeners.get(name) ?? new Set();
    listeners.set(name, handlers);
    handlers.add(listener as (value: unknown) => void);
    return () => {
      handlers.delete(listener as (value: unknown) => void);
    };
  },
};
registerAgentPreferencesFlush(async () => {});
Object.defineProperty(RuntimeClient.prototype, "status", {
  get: () => "connected",
});
RuntimeClient.prototype.connect = () => Promise.resolve();
RuntimeClient.prototype.send = (message) => {
  if (message.type === "PTY_WRITE") {
    counts.lastTerminalInput = (message as { data: string }).data;
    counts.terminalWrites++;
    showCounts();
  }
};
const executionAccounts = new Map<string, string>();
RuntimeClient.prototype.request = async function <
  T extends BridgeMessage = BridgeMessage,
>(message: Partial<BridgeMessage> & { type: string }): Promise<T> {
  const request = message as unknown as {
    type: string;
    loginProvider?: string;
    agentId: BrowserSubscriptionProvider;
    sessionId: string;
    userMessageId: string;
    prompt: { type: string; text: string }[];
    op: string;
    params: Record<string, unknown>;
  };
  if (request.type === "AGENT_LIST_AGENTS")
    return { type: "AGENT_AGENTS_LIST", agents: registry() } as unknown as T;
  if (request.type === "AGENT_VALIDATE_KEY")
    return { type: "AGENT_KEY_VALIDATED", ok: true } as unknown as T;
  if (request.type === "RESOLVE_AGENT_BINARY")
    return {
      type: "AGENT_BINARY_RESOLVED",
      path: "/usr/bin/true",
    } as unknown as T;
  if (request.type === "PTY_CREATE") {
    counts.terminals++;
    counts.terminalLoginProvider = request.loginProvider ?? "";
    showCounts();
    return {
      type: "PTY_CREATED",
      sessionId: "fixture-terminal",
    } as unknown as T;
  }
  if (
    request.type === "AGENT_NEW_SESSION" ||
    request.type === "AGENT_LOAD_SESSION"
  ) {
    counts.savedDuringReconnection = (
      rows.get(`chat-${request.agentId}`) ?? []
    ).some((message) => message.id === initialTurnId);
    showCounts();
  }
  if (request.type === "AGENT_NEW_SESSION") {
    executionAccounts.set(
      `execution-${request.agentId}`,
      statuses.get(request.agentId)?.activeAccountId ?? "",
    );
    return {
      type: "AGENT_SESSION_CREATED",
      agentId: request.agentId,
      initialize: { protocolVersion: 1, agentCapabilities: {} },
      session: {
        sessionId: `execution-${request.agentId}`,
        executionId: `execution-${request.agentId}`,
      },
    } as unknown as T;
  }
  if (request.type === "AGENT_CLOSE_SESSION") {
    counts.closed++;
    showCounts();
    return { type: "AGENT_SESSION_CLOSED" } as unknown as T;
  }
  if (request.type === "AGENT_LOAD_SESSION") {
    counts.resumed++;
    executionAccounts.set(
      `resumed-${request.agentId}`,
      statuses.get(request.agentId)?.activeAccountId ?? "",
    );
    showCounts();
    return {
      type: "AGENT_SESSION_LOADED",
      agentId: request.agentId,
      sessionId: `resumed-${request.agentId}`,
      executionId: `resumed-${request.agentId}`,
      response: {
        resumedFresh: true,
        sessionId: `resumed-${request.agentId}`,
        executionId: `resumed-${request.agentId}`,
        providerBinding: {
          version: 1,
          providerId: request.agentId,
          kind: "native",
          resumeId: "fixture-conversation",
        },
      },
    } as unknown as T;
  }
  if (request.type === "AGENT_PROMPT") {
    const selected = statuses.get(request.agentId)?.activeAccountId ?? "";
    if (
      executionAccounts.has(request.sessionId) &&
      executionAccounts.get(request.sessionId) !== selected
    ) {
      return {
        type: "AGENT_PROMPT_FAILED",
        sessionId: request.sessionId,
        agentId: request.agentId,
        error: "Account changed",
        failure: {
          kind: "session-expired",
          stage: "prompt",
          message: "Account changed",
        },
      } as unknown as T;
    }
    counts.dispatchedAccount = selected;
    counts.replayedHistory = request.prompt.some(
      (block) =>
        block.text.includes("<previous_conversation>") &&
        block.text.includes("Another message"),
    );
    counts.prompts++;
    counts.newTurn = request.userMessageId !== initialTurnId;
    counts.includedContext =
      request.prompt.some(
        (block) => block.text === "Original expanded prompt",
      ) &&
      request.prompt.some(
        (block) => block.text === "Original attachment content",
      );
    counts.newMessage = request.prompt.at(-1)?.text ?? "";
    showCounts();
    if (
      statuses.get(request.agentId)?.state !== "connected" &&
      !secrets.has(accounts[request.agentId])
    )
      return {
        type: "AGENT_PROMPT_FAILED",
        sessionId: request.sessionId,
        agentId: request.agentId,
        error: "Sign in required",
        failure: {
          kind: "auth-required",
          stage: "prompt",
          agentId: request.agentId,
          message: "Sign in required",
        },
      } as unknown as T;
    return {
      type: "AGENT_PROMPT_COMPLETE",
      sessionId: request.sessionId,
      result: { stopReason: "end_turn" },
    } as unknown as T;
  }
  const params = request.params ?? {};
  const chatId = params.chatId as string;
  let result: unknown = {};
  if (request.op === "messages.import") {
    const messages = (params.messages as { payload: string }[]).map(
      (row) => JSON.parse(row.payload) as AgentTextMessage,
    );
    const existing = rows.get(chatId) ?? [];
    for (const message of messages) {
      const index = existing.findIndex((row) => row.id === message.id);
      if (index < 0) existing.push(message);
      else existing[index] = message;
    }
    rows.set(chatId, existing);
    initialTurnId = existing[0]?.id ?? initialTurnId;
    result = { imported: messages.length };
  } else if (request.op === "messages.truncateFrom") {
    rows.delete(chatId);
    result = { removed: 1 };
  } else if (request.op === "messages.window")
    result = (rows.get(chatId) ?? []).map((m) => ({
      msgId: m.id,
      kind: m.kind,
      payload: JSON.stringify(m),
      createdAt: m.createdAt,
    }));
  else if (request.op === "turns.get") result = null;
  else if (request.op === "workspace.list") result = [];
  else if (request.op === "settings.read")
    result = { doc: {}, raw: "", exists: true };
  return { type: "WORKSPACE_RESPONSE", op: request.op, result } as unknown as T;
};

function Harness() {
  const [provider, setProvider] =
    useState<BrowserSubscriptionProvider>(usageFixture ?? "claude");
  const [settings, setSettings] = useState(Boolean(usageFixture));
  const [active, setActive] = useState(true);
  const [draft, setDraft] = useState("Original message");
  const actions = useAgentSessions();
  const chatId = `chat-${provider}`;
  const session = useChatSession(chatId);
  const prompt = lastUserPrompt(session.messages);
  useEffect(() => subscribeProviderSettingsTab(() => setSettings(true)), []);
  useEffect(() => { if (usageFixture) requestProviderSettings(usageFixture); }, []);
  useEffect(() => {
    if (!useSessionsStore.getState().sessions[chatId])
      useSessionsStore.getState().setSession(chatId, {
        ...BLANK,
        transcriptState: "resident",
        agentId: provider,
        agentName: names[provider],
        cwd: "/fixture/repository",
        ...(provider === "codex"
          ? {
              executionId: "expired-execution",
              sessionId: "expired-execution",
              providerBinding: {
                version: 1,
                providerId: provider,
                kind: "native",
                resumeId: "fixture-conversation",
              } as const,
            }
          : {}),
      });
    actions.setRetainedChatIds(ids.map((id) => `chat-${id}`));
    void loadAgents(actions.listAgents);
  }, [actions, chatId, provider]);
  return (
    <main className="bg-bg1 text-fg1 flex min-h-screen flex-col gap-4 p-6">
      <div className="flex flex-wrap gap-2">
        {ids.map((id) => (
          <Button
            key={id}
            onClick={() => {
              setProvider(id);
              setDraft("Original message");
              setSettings(false);
            }}
          >
            {id}
          </Button>
        ))}
        <Button
          onClick={() => {
            staleCredentialHint = !staleCredentialHint;
            void refreshAgents(actions.listAgents);
          }}
        >
          Stale credential hint
        </Button>
        <Button onClick={() => setActive((v) => !v)}>
          Toggle retained surface
        </Button>
        <Button onClick={() => setSettings(false)}>Return to chat</Button>
        <Button onClick={() => requestProviderSettings(provider)}>
          Settings
        </Button>
        {usageFixture && <>
          <Button onClick={() => { holdUsage = true; }}>Hold usage responses</Button>
          <Button onClick={() => { holdUsage = false; for (const resolve of pendingUsage) resolve(); pendingUsage.clear(); }}>Release usage responses</Button>
        </>}
        <Button
          onClick={() => {
            const status = statuses.get(provider);
            if (status)
              publish(
                finishAccountLogin({
                  ...status,
                  canSubmitCode: false,
                  revision: status.revision + 1,
                }),
              );
          }}
        >
          Complete browser login
        </Button>
      </div>
      <section
        hidden={!settings || !active}
        {...(!settings || !active ? { inert: "" } : {})}
      >
        <ProvidersPanel surfaceActive={settings && active} />
      </section>
      {!settings && active && (
        <section data-chat>
          {groupMessagesIntoTurns(session.messages).map(
            (turn, index, turns) => {
              const state = authenticationTurnState({
                userPrompt: turn.userPrompt,
                events: turn.events,
                failureKind: session.failure?.kind,
                isTail: index === turns.length - 1,
                inFlight:
                  session.status === "streaming" || !!turn.userPrompt?.queued,
              });
              return (
                <React.Fragment key={turn.userPrompt?.id ?? index}>
                  {turn.userPrompt && (
                    <p data-user-prompt data-message-id={turn.userPrompt.id}>
                      {turn.userPrompt.text}
                    </p>
                  )}
                  {state === "sign-in" && (
                    <AuthenticationNotice
                      name={names[provider]}
                      onSignIn={() => requestProviderSettings(provider)}
                    />
                  )}
                  {state === "stopped" && turn.userPrompt && (
                    <TurnFooter
                      chatId={chatId}
                      turnId={turn.userPrompt.id}
                      startedAt={turn.userPrompt.createdAt}
                      events={authenticationTurnOutput(turn.events)}
                      live={false}
                      fallbackStatusLabel="AGENT STOPPED"
                    />
                  )}
                </React.Fragment>
              );
            },
          )}
          <input
            aria-label="Message"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <Button
            disabled={!draft.trim()}
            onClick={() => {
              const first = !prompt;
              void actions.sendPrompt(
                chatId,
                first ? "Original expanded prompt" : draft,
                draft,
                first
                  ? [{ type: "text", text: "Original attachment content" }]
                  : undefined,
              );
              setDraft("");
            }}
          >
            Send message
          </Button>
          <output id="session-status">{session.status}</output>
        </section>
      )}
      <output id="counts">{JSON.stringify(counts)}</output>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <BridgeProvider>
      <AgentSessionsProvider>
        <Harness />
      </AgentSessionsProvider>
    </BridgeProvider>
  </TooltipProvider>,
);
