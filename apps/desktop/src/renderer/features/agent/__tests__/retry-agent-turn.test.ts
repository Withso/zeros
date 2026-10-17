import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTextMessage } from "@zeros/protocol/agent-messages";
import type { ChatThread } from "../../../state/store";
import type { SessionsActions } from "../sessions-context";
import type { ComposerAttachment } from "../composer-attachments";
import { retryAgentTurn } from "../retry-agent-turn";
import { BLANK } from "../sessions-store";
import type { AgentSessionState } from "../use-agent-session";

const { encode, transcript } = vi.hoisted(() => ({
  encode: vi.fn(),
  transcript: vi.fn(),
}));
vi.mock("../encode-attachments", () => ({ encodeAttachments: encode }));
vi.mock("../chat-transcript-attach", async (original) => ({
  ...(await original<typeof import("../chat-transcript-attach")>()),
  loadTranscriptSnapshot: transcript,
}));

const prompt: AgentTextMessage = {
  id: "u1",
  kind: "text",
  role: "user",
  text: "Fix `a.ts`",
  retryText: "Fix the original expanded file context",
  createdAt: 1,
};
const source: ChatThread = {
  id: "source",
  folder: "/repo",
  agentId: "codex",
  agentName: "Codex",
  model: "chosen-model",
  effort: "high",
  permissionMode: "tool-approval",
  title: "Fix race",
  createdAt: 1,
  updatedAt: 2,
};

const output: AgentTextMessage = {
  id: "a1", kind: "text", role: "agent", text: "Work completed so far", createdAt: 2,
};

function harness(initial: Partial<AgentSessionState> = {}) {
  const chats = new Map([[source.id, source]]);
  let slot: AgentSessionState = {
    ...BLANK, agentId: "codex", agentRole: "code", cwd: "/repo",
    messages: [prompt], status: "ready", ...initial,
  };
  let generation = 0;
  const sessions = {
    getSendGeneration: vi.fn(() => generation),
    getSession: vi.fn((id: string): AgentSessionState => id === source.id ? slot : {
      ...BLANK, agentId: "codex", agentRole: "code", cwd: slot.cwd, status: "ready",
    }),
    getCloseActivity: vi.fn(() => ({ running: false, queuedCount: 0 })),
    prepareForSend: vi.fn<() => Promise<void> | null>(() => null),
    ensureSession: vi.fn(async () => {}),
    sendPrompt: vi.fn(async () => {}),
  };
  const dependencies = {
    sessions: sessions as unknown as SessionsActions,
    getChat: (id: string) => chats.get(id),
    publishChat: vi.fn((chat: ChatThread) => chats.set(chat.id, chat)),
  };
  return {
    chats,
    sessions,
    dependencies,
    cancel: () => {
      generation += 1;
    },
    advance: () => {
      slot = { ...slot, messages: [...slot.messages, { ...prompt, id: "u2" }] };
    },
    update: (patch: Partial<AgentSessionState>) => { slot = { ...slot, ...patch }; },
  };
}

beforeEach(() => {
  encode
    .mockReset()
    .mockResolvedValue({
      blocks: [{ type: "text", text: "file bytes" }],
      bubbleAttachments: [{ kind: "text", name: "a.txt" }],
      skipped: [],
    });
  transcript
    .mockReset()
    .mockResolvedValue({
      text: "User: fix race\nAgent: inspected a.ts",
      count: 2,
      complete: true,
    });
});

describe("explicit failed-turn recovery", () => {
  describe.each([
    { owner: "Local", folder: "/repo", offWindow: true },
    { owner: "organization-local", folder: "/organization/repo", offWindow: true },
    { owner: "cloud", folder: "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222", offWindow: false },
  ])("$owner", ({ folder, offWindow }) => {
    it.each([false, true])("retries the confirmed opening prompt, new chat: %s", async (newChat) => {
      const h = harness({
        cwd: folder, transcriptState: "resident",
        messages: offWindow ? [output] : [prompt, output],
        leadingPrompt: offWindow ? prompt : null,
      });
      h.chats.set(source.id, { ...source, folder });
      await retryAgentTurn({ chatId: source.id, prompt, events: [output], newChat }, h.dependencies);
      expect(h.sessions.sendPrompt).toHaveBeenCalledOnce();
      const args = h.sessions.sendPrompt.mock.calls[0] as unknown[];
      expect(args[0]).toBe(newChat ? h.dependencies.publishChat.mock.calls[0][0].id : source.id);
      expect(args[1]).toContain(prompt.retryText);
      expect(transcript).toHaveBeenCalledTimes(newChat ? 1 : 0);
    });
  });

  it.each(["cold", "loading"] as const)("does not retry an off-window prompt from a %s transcript", async (transcriptState) => {
    const h = harness({
      messages: [output], leadingPrompt: prompt, transcriptState,
      transcriptPresentation: { source: "cache" },
    });
    await retryAgentTurn({ chatId: source.id, prompt, events: [output], newChat: false }, h.dependencies);
    expect(h.sessions.prepareForSend).not.toHaveBeenCalled();
    expect(h.sessions.sendPrompt).not.toHaveBeenCalled();
  });

  it.each(["newer turn", "changed opening", "eviction", "cached presentation", "workspace change", "cancellation"] as const)(
    "revalidates an off-window opening after attachment reads: %s",
    async (change) => {
      const h = harness({ messages: [output], leadingPrompt: prompt, transcriptState: "resident" });
      let release!: () => void;
      encode.mockReturnValueOnce(new Promise(resolve => {
        release = () => resolve({ blocks: [], bubbleAttachments: [], skipped: [] });
      }));
      const retry = retryAgentTurn({ chatId: source.id, prompt, events: [output], newChat: false }, h.dependencies);
      try {
        expect(encode).toHaveBeenCalledOnce();
        switch (change) {
          case "newer turn": h.advance(); break;
          case "changed opening": h.update({ leadingPrompt: { ...prompt, id: "u2" } }); break;
          case "eviction": h.update({ transcriptState: "cold", messages: [], leadingPrompt: null }); break;
          case "cached presentation": h.update({ transcriptState: "loading", transcriptPresentation: { source: "cache" } }); break;
          case "workspace change": h.chats.set(source.id, { ...source, folder: "/another-repo" }); break;
          case "cancellation": h.cancel(); break;
        }
      } finally {
        release();
        await retry;
      }
      expect(h.sessions.sendPrompt).not.toHaveBeenCalled();
    },
  );

  it("uses the same cloud wake identity for preparation and the queued retry", async () => {
    const h = harness();
    h.chats.set(source.id, { ...source, folder: "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222" });
    await retryAgentTurn({ chatId: source.id, prompt, events: [], newChat: false }, h.dependencies);
    const prepared = h.sessions.prepareForSend.mock.calls[0] as unknown[];
    const sent = h.sessions.sendPrompt.mock.calls[0] as unknown[];
    expect(prepared[1]).toEqual({ id: expect.any(String) });
    expect(sent[9]).toBe(prepared[1]);
  });
  it.each([false, true])("prepares cloud use before admission and honors cancellation: %s", async cancel => {
    const h = harness();
    let ready!: () => void;
    h.sessions.prepareForSend.mockReturnValue(new Promise<void>(resolve => { ready = resolve; }));
    const retry = retryAgentTurn({ chatId: "source", prompt, events: [], newChat: false }, h.dependencies);
    try {
      await Promise.resolve();
      expect(h.sessions.prepareForSend).toHaveBeenCalledExactlyOnceWith("source");
      expect(h.sessions.ensureSession).not.toHaveBeenCalled();
      expect(h.sessions.sendPrompt).not.toHaveBeenCalled();
      if (cancel) h.cancel();
    } finally { ready(); await retry; }
    expect(h.sessions.ensureSession).toHaveBeenCalledTimes(cancel ? 0 : 1);
    expect(h.sessions.sendPrompt).toHaveBeenCalledTimes(cancel ? 0 : 1);
    expect(h.sessions.getSession("source").messages).toEqual([prompt]);
  });
  it("refreshes inline attachment metadata without changing text or mention order", async () => {
    const oldPath = ".context/local/attachments/attachment/report.pdf";
    const newPath = ".context/shared/attachments/attachment/report.pdf";
    const attachment = {
      kind: "file" as const,
      name: "report.pdf",
      mimeType: "application/pdf",
      delivery: "reference" as const,
      attachmentId: "attachment",
      diskPath: oldPath,
    };
    const before = { type: "text" as const, text: "Read " };
    const after = { type: "mention" as const, label: "a.ts", path: "a.ts", kind: "file" as const };
    const withAttachment: AgentTextMessage = {
      ...prompt,
      attachments: [attachment],
      segments: [before, { type: "attachment", ...attachment }, after],
    };
    const h = harness();
    h.sessions.getSession.mockImplementation(() => ({ ...BLANK, agentId: "codex", agentRole: "code", cwd: "/repo", messages: [withAttachment], status: "ready" }));
    const refreshed = { ...attachment, diskPath: newPath, size: 42 };
    encode.mockResolvedValue({ blocks: [{ type: "text", text: "current file reference" }], bubbleAttachments: [refreshed], skipped: [] });
    await retryAgentTurn({ chatId: "source", prompt: withAttachment, events: [], newChat: false }, h.dependencies);
    expect(h.sessions.sendPrompt).toHaveBeenCalledOnce();
    const args = h.sessions.sendPrompt.mock.calls[0] as unknown[];
    expect(args[4]).toEqual([refreshed]);
    expect(args[5]).toEqual([before, { type: "attachment", ...refreshed }, after]);
  });

  it("retains the source transcript through repeated recovery of a segmented prompt", async () => {
    const segmentedPrompt: AgentTextMessage = { ...prompt, segments: [{ type: "text", text: prompt.text }] };
    const h = harness();
    const messages = new Map<string, AgentTextMessage[]>([["source", [segmentedPrompt]]]);
    h.sessions.getSession.mockImplementation((id: string) => ({ ...BLANK, agentId: "codex", agentRole: "code", cwd: "/repo", messages: messages.get(id) ?? [], status: "ready" }));
    encode.mockImplementation(async (attachments: ComposerAttachment[]) => ({
      blocks: attachments.map(a => ({ type: "text", text: a.text || a.name })),
      bubbleAttachments: attachments.map(a => ({ kind: a.kind, name: a.name, mimeType: a.mimeType, delivery: "reference", attachmentId: a.contextAttachmentId ?? a.id, diskPath: a.diskPath ?? `.context/local/attachments/${a.id}/transcript.txt` })),
      skipped: [],
    }));
    await retryAgentTurn({ chatId: "source", prompt: segmentedPrompt, events: [], newChat: true }, h.dependencies);
    const first = h.sessions.sendPrompt.mock.calls[0] as unknown as Parameters<SessionsActions["sendPrompt"]>;
    const chatId = first[0];
    const retriedPrompt: AgentTextMessage = { ...segmentedPrompt, id: "retry-1", attachments: first[4], segments: first[5] };
    messages.set(chatId, [retriedPrompt]);
    expect(retriedPrompt.attachments).toHaveLength(1);
    await retryAgentTurn({ chatId, prompt: retriedPrompt, events: [], newChat: false }, h.dependencies);
    expect(encode).toHaveBeenCalledTimes(2);
    expect(encode.mock.calls[1][0]).toHaveLength(1);
    expect(encode.mock.calls[1][0][0]).toMatchObject({ contextAttachmentId: retriedPrompt.attachments![0].attachmentId });
    const second = h.sessions.sendPrompt.mock.calls[1] as unknown[];
    expect(second[4]).toEqual(first[4]);
    expect(second[5]).toEqual([{ type: "text", text: prompt.text }, { type: "attachment", ...retriedPrompt.attachments![0] }]);
  });

  it("resends the undelivered expanded request with its attachments", async () => {
    const h = harness();
    await retryAgentTurn(
      { chatId: "source", prompt, events: [], newChat: false },
      h.dependencies,
    );
    expect(h.sessions.sendPrompt).toHaveBeenCalledWith(
      "source",
      prompt.retryText,
      prompt.text,
      [{ type: "text", text: "file bytes" }],
      [{ kind: "text", name: "a.txt" }],
      undefined,
      undefined,
    );
  });

  it("continues partial work and sends a concise transcript in a fresh chat", async () => {
    const h = harness();
    const pending = retryAgentTurn(
      {
        chatId: "source",
        prompt,
        events: [
          {
            id: "a1",
            kind: "text",
            role: "agent",
            text: "I fixed the first file",
            createdAt: 2,
          },
        ],
        newChat: true,
      },
      h.dependencies,
    );
    expect(h.dependencies.publishChat).toHaveBeenCalledTimes(1);
    const fresh = h.dependencies.publishChat.mock.calls[0][0];
    expect(fresh).toMatchObject({
      sourceChatId: "source",
      model: "chosen-model",
    });
    expect(fresh.providerBinding).toBeUndefined();
    await pending;
    expect(transcript).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "source",
        mode: "concise",
        throughMessageId: "u1",
      }),
    );
    expect(encode.mock.calls[0][0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "text",
          text: expect.stringContaining("inspected a.ts"),
        }),
      ]),
    );
    expect(h.sessions.sendPrompt).toHaveBeenCalledWith(
      fresh.id,
      expect.stringContaining("Continue the interrupted request"),
      "Continue",
      expect.any(Array),
      expect.any(Array),
      undefined,
      undefined,
    );
  });

  it("deduplicates clicks and abandons preparation if the source moves to a newer turn", async () => {
    const h = harness();
    let release!: (value: unknown) => void;
    encode.mockReturnValueOnce(
      new Promise((r) => {
        release = r;
      }),
    );
    const first = retryAgentTurn(
      { chatId: "source", prompt, events: [], newChat: false },
      h.dependencies,
    );
    await retryAgentTurn(
      { chatId: "source", prompt, events: [], newChat: true },
      h.dependencies,
    );
    expect(h.dependencies.publishChat).not.toHaveBeenCalled();
    h.advance();
    release({ blocks: [], bubbleAttachments: [], skipped: [] });
    await first;
    expect(h.sessions.sendPrompt).not.toHaveBeenCalled();
  });

  it("does not send an incomplete retry when an attachment cannot be read", async () => {
    const h = harness();
    encode.mockResolvedValueOnce({
      blocks: [],
      bubbleAttachments: [],
      skipped: [{ name: "a.txt", reason: "unavailable" }],
    });
    await expect(
      retryAgentTurn(
        { chatId: "source", prompt, events: [], newChat: false },
        h.dependencies,
      ),
    ).rejects.toThrow("a.txt");
    expect(h.sessions.sendPrompt).not.toHaveBeenCalled();
  });

  it("abandons a deleted destination without sending into another chat", async () => {
    const h = harness();
    transcript.mockImplementationOnce(async () => {
      h.chats.clear();
      return { text: "history", count: 1, complete: true };
    });
    await retryAgentTurn(
      { chatId: "source", prompt, events: [], newChat: true },
      h.dependencies,
    );
    expect(h.sessions.sendPrompt).not.toHaveBeenCalled();
  });

  it("honors Stop or close while retry preparation is awaiting attachment reads", async () => {
    const h = harness();
    encode.mockImplementationOnce(async () => {
      h.cancel();
      return { blocks: [], bubbleAttachments: [], skipped: [] };
    });
    await retryAgentTurn(
      { chatId: "source", prompt, events: [], newChat: false },
      h.dependencies,
    );
    expect(h.sessions.sendPrompt).not.toHaveBeenCalled();
  });
});
