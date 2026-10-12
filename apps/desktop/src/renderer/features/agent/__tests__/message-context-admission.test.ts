import { expect, it, vi } from "vitest";
import type { AgentMessage } from "../use-agent-session";
import type { RendererContext } from "../renderers/types";

vi.mock("../renderers/registry", () => ({ defaultRegistry: {}, resolveRenderer: () => ({ Component: () => null }) }));
import { MessageView } from "../renderers/message-view";

const compare = (MessageView as unknown as { compare: (a: unknown, b: unknown) => boolean }).compare;
const message = { id: "question", kind: "tool", toolCallId: "question-tool" } as AgentMessage;
const context = { chatId: "chat", pendingPermission: null, subagentChildren: new Map() } as RendererContext;

it("retires cached row action closures when transcript authority changes, even with identical message objects", () => {
  const cached = { message, ctx: { ...context, transcriptReadOnly: true } };
  const confirmed = { message, ctx: { ...context, transcriptReadOnly: false } };
  expect(compare(cached, confirmed)).toBe(false);
  expect(compare(confirmed, cached)).toBe(false);
});

it("preserves unchanged Local and authoritative message references", () => {
  const local = { message, ctx: context };
  expect(compare(local, { ...local, ctx: { ...context } })).toBe(true);
  const confirmed = { message, ctx: { ...context, transcriptReadOnly: false } };
  expect(compare(confirmed, { ...confirmed, ctx: { ...confirmed.ctx } })).toBe(true);
});
