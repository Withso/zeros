import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

import * as contract from "../browser/codex-native-contract";
import { browserError, browserErrorMessage } from "../browser/errors";

// The IAB dispatcher is private to the Electron browser service, which needs a
// live Electron runtime to import. Run its real source in an isolated context
// with only the collaborators these wire methods are allowed to reach.
const source = ts.createSourceFile(
  "service.ts",
  readFileSync(new URL("../browser/service.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
);

function declaration(name: string): string {
  const node = source.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  if (!node) throw new Error(`service.ts no longer declares ${name}()`);
  return node.getText(source);
}

type Dispatch = (
  request: Record<string, unknown>,
  context: Record<string, unknown>,
) => Promise<unknown>;

function loadDispatcher(publishState: ReturnType<typeof vi.fn>): Dispatch {
  const program = [
    "handleCodexBrowserUseRequest",
    "assertCodexBrowserTab",
    "ensureCodexBrowserUseReady",
  ]
    .map(declaration)
    .join("\n");
  const sandbox: Record<string, unknown> = {
    ...contract,
    browserError,
    publishState,
    withTimeout: (pending: Promise<unknown>) => pending,
    BROWSER_USE_BOOTSTRAP_TIMEOUT_MS: 10_000,
  };
  vm.runInNewContext(
    ts.transpileModule(
      `${program}\nglobalThis.dispatch = handleCodexBrowserUseRequest;`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
    ).outputText,
    sandbox,
  );
  return sandbox.dispatch as Dispatch;
}

function conversationTab(
  initialUrl: string,
  { commitsBlank = true, codexNativeEnabled = true } = {},
) {
  let url = initialUrl;
  const webContents = {
    id: 42,
    isDestroyed: () => false,
    getURL: () => url,
    getTitle: () => "Example",
    loadURL: vi.fn(async (next: string) => {
      if (commitsBlank) url = next;
    }),
  };
  const lease = {
    view: { webContents },
    actor: "user",
    browserUseReady: null,
    browserUseTurnId: null,
  };
  const record = {
    id: "browser_conversation",
    lease,
    interruptionGeneration: 0,
    activeOperations: 0,
  };
  const binding = {
    browserSessionId: record.id,
    activeTurnId: null,
    blockedTurnId: null,
    touchedAt: 0,
  };
  const publishState = vi.fn();
  const context = {
    sessions: new Map([["codex-thread", binding]]),
    records: new Map([[record.id, record]]),
    options: {},
    confirmations: { clearSession: vi.fn() },
    pipe: () => ({}),
    browserEnabled: () => true,
    codexNativeEnabled: () => codexNativeEnabled,
    trustedSurfaceAvailable: () => true,
    showAgentCursor: () => false,
    navigationApproval: () => "always-ask",
    touchRecord: vi.fn(),
    scheduleLeaseCleanup: vi.fn(),
  };
  const dispatch = loadDispatcher(publishState);
  const send = (method: string, params: Record<string, unknown> = {}) =>
    Promise.resolve(
      dispatch(
        {
          method,
          params,
          sessionId: "codex-thread",
          turnId: "turn-1",
          socket: {},
        },
        context,
      ),
    );
  return { send, lease, record, webContents, publishState };
}

describe("native Codex Browser IAB wire methods", () => {
  it("reports the conversation tab's committed URL for the official security checks", async () => {
    const { send, lease, record, publishState } = conversationTab(
      "https://example.com/docs?q=1",
    );
    await expect(send("getCommittedTabUrl", { tabId: 42 })).resolves.toBe(
      "https://example.com/docs?q=1",
    );
    // A URL read precedes every guarded command. It must not take the page
    // from the user or flash agent activity on its own.
    expect(lease.actor).toBe("user");
    expect(publishState).not.toHaveBeenCalled();
    expect(record.activeOperations).toBe(0);
  });

  it("commits a blank document before reporting a tab that has not navigated", async () => {
    const { send, webContents } = conversationTab("");
    await expect(send("getCommittedTabUrl", { tabId: 42 })).resolves.toBe(
      "about:blank",
    );
    expect(webContents.loadURL).toHaveBeenCalledWith("about:blank");
  });

  it("reports no URL instead of an empty string when nothing has committed", async () => {
    const { send } = conversationTab("", { commitsBlank: false });
    await expect(
      send("getCommittedTabUrl", { tabId: 42 }),
    ).resolves.toBeUndefined();
  });

  it("refuses page work once Codex's built-in browser is switched off", async () => {
    const { send, webContents, publishState } = conversationTab(
      "https://example.com/",
      { codexNativeEnabled: false },
    );
    // The plugin can still discover the host; the live session is resumed
    // with the Zeros browser tools once it is idle.
    await expect(send("ping")).resolves.toBe("pong");
    await expect(send("getCommittedTabUrl", { tabId: 42 })).rejects.toThrow(
      "Codex’s built-in browser is turned off in Settings > Browser.",
    );
    expect(webContents.loadURL).not.toHaveBeenCalled();
    expect(publishState).not.toHaveBeenCalled();
  });

  it("refuses to report a tab outside this conversation", async () => {
    const { send } = conversationTab("https://example.com/");
    await expect(send("getCommittedTabUrl", { tabId: 43 })).rejects.toThrow(
      "Browser tab does not belong to this Zeros conversation.",
    );
  });

  it.each([
    "executeCdpWithCachedExpression",
    "executeTabRead",
    "executeUnhandledCommand",
    "browserAuthNewTargetProtection",
    "setBlobDownloadOrigin",
    "followSessionTab",
  ])(
    "answers optional %s with the exact no-handler text the client falls back on",
    async (method) => {
      const { send } = conversationTab("https://example.com/");
      const failure = await send(method, { tabId: 42 }).then(
        () => null,
        (reason: unknown) => reason,
      );
      // The pipe forwards only browser request errors verbatim; anything else
      // becomes an opaque message the official client cannot recognise.
      expect(browserErrorMessage(failure)).toBe(
        `No handler registered for method: ${method}`,
      );
    },
  );

  it("does not advertise optional features whose wire methods Zeros leaves unanswered", () => {
    const info: Record<string, unknown> =
      contract.codexBrowserIabInfo("codex-thread");
    expect(info).not.toHaveProperty("blobDownloadsSupported");
    expect(info).not.toHaveProperty("sessionTabForegroundEnabled");
    expect(info.capabilities).toEqual({ browser: [], tab: [] });
  });
});
