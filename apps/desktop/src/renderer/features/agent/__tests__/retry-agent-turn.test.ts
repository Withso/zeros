import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTextMessage } from "@zeros/protocol/agent-messages";
import type { ChatThread } from "../../../state/store";
import type { SessionsActions } from "../sessions-context";
import { retryAgentTurn } from "../retry-agent-turn";

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

function harness() {
  const chats = new Map([[source.id, source]]);
  let messages = [prompt];
  let generation = 0;
  const sessions = {
    getSendGeneration: vi.fn(() => generation),
    getSession: vi.fn((id: string) => ({
      agentId: "codex",
      agentRole: "code",
      cwd: "/repo",
      messages: id === source.id ? messages : [],
      status: "ready",
    })),
    getCloseActivity: vi.fn(() => ({ running: false, queuedCount: 0 })),
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
      messages = [...messages, { ...prompt, id: "u2" }];
    },
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
