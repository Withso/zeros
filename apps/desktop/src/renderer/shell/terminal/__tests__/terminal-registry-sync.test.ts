import { describe, it, expect } from "vitest";
import {
  selectExcludedChatTerminalIds,
  selectPanelTerminals,
  normalizeFolder,
} from "../terminal-registry-sync";
import type { PtyTerminalLike } from "../../../platform/bridge/pty-bridge";

const term = (
  sessionId: string,
  cwd: string,
  createdAt = 1,
): PtyTerminalLike => ({ sessionId, cwd, workspaceId: null, createdAt });

describe("selectPanelTerminals", () => {
  it("excludes conversation pane terminal-agent (chat-bound) PTYs — the phantom-panel-tab bug", () => {
    // A real panel shell AND a conversation pane terminal-agent PTY (keyed by chat id)
    // both live in the engine registry for the same folder. The agent terminal
    // must NOT be adopted as a panel tab.
    const terms = [term("pty-panel-1", "/w"), term("chat-agent-1", "/w")];
    const { inFolder, aliveIds } = selectPanelTerminals(
      terms,
      new Set(["chat-agent-1"]),
      "/w",
    );
    expect(inFolder.map((t) => t.sessionId)).toEqual(["pty-panel-1"]);
    // Excluded from the alive-set too → a previously-adopted one is pruned by the
    // store's vanish-reconcile (closes the multiplayer race window).
    expect(aliveIds).toEqual(["pty-panel-1"]);
  });

  it("keeps panel terminals; add-list is folder-scoped, alive-set spans all folders", () => {
    const terms = [term("a", "/w"), term("b", "/other")];
    const { inFolder, aliveIds } = selectPanelTerminals(terms, new Set(), "/w");
    expect(inFolder.map((t) => t.sessionId)).toEqual(["a"]); // ADD-list: folder /w only
    expect(aliveIds).toEqual(["a", "b"]); // alive-set: every folder (vanish check)
  });

  it("matches a /private-prefixed engine cwd against the plain folder (macOS realpath)", () => {
    const terms = [term("a", "/private/var/folders/x/ws")];
    const { inFolder } = selectPanelTerminals(
      terms,
      new Set(),
      "/var/folders/x/ws",
    );
    expect(inFolder.map((t) => t.sessionId)).toEqual(["a"]);
  });

  it("no exclusions → all terminals are panel terminals", () => {
    const terms = [term("a", "/w"), term("b", "/w")];
    const { inFolder, aliveIds } = selectPanelTerminals(terms, new Set(), "/w");
    expect(inFolder.map((t) => t.sessionId)).toEqual(["a", "b"]);
    expect(aliveIds).toEqual(["a", "b"]);
  });
});

describe("selectExcludedChatTerminalIds", () => {
  it("excludes terminal chats whether LIVE or ARCHIVED — closes the kill-race", () => {
    // A just-closed conversation pane terminal agent is archived synchronously but its PTY is
    // reaped async. Keeping the archived id excluded is what stops the workbench
    // panel from adopting the still-dying shell as a phantom tab.
    const chats = [
      { id: "chat-1", kind: "chat" },
      { id: "term-live", kind: "terminal" },
      { id: "term-archived", kind: "terminal", archived: true },
    ];
    expect(selectExcludedChatTerminalIds(chats).sort()).toEqual([
      "term-archived",
      "term-live",
    ]);
  });

  it("ignores non-terminal chats", () => {
    expect(
      selectExcludedChatTerminalIds([
        { id: "a", kind: "chat" },
        { id: "b" },
      ]),
    ).toEqual([]);
  });

  it("is empty for an empty chat list", () => {
    expect(selectExcludedChatTerminalIds([])).toEqual([]);
  });
});

describe("normalizeFolder", () => {
  it("strips the /private prefix for var/tmp/etc, leaves other paths alone", () => {
    expect(normalizeFolder("/private/var/x")).toBe("/var/x");
    expect(normalizeFolder("/private/tmp/x")).toBe("/tmp/x");
    expect(normalizeFolder("/Users/dev/project")).toBe("/Users/dev/project");
    expect(normalizeFolder("/var/x")).toBe("/var/x");
  });
});
