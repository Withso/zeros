import { describe, expect, it } from "vitest";

import {
  messageSnapshotsEqual,
  seedPersistedMessageRefs,
  updatePersistedMessageRefs,
} from "../message-persistence-tracker";
import type { AgentMessage } from "../use-agent-session";

const message = (id: string, text = id): AgentMessage => ({
  id,
  kind: "text",
  role: "agent",
  text,
  createdAt: 1,
});

describe("message persistence reference tracking", () => {
  it("drops references to messages that left the resident transcript window", () => {
    const old = message("old");
    const current = message("current");
    const refs = new Map<string, AgentMessage>([
      [old.id, old],
      [current.id, current],
    ]);

    expect(updatePersistedMessageRefs(refs, [current])).toEqual([]);
    expect([...refs.keys()]).toEqual(["current"]);
  });

  it("seeds disk-hydrated objects without scheduling redundant writes", () => {
    const refs = new Map<string, AgentMessage>();
    const hydrated = [message("one"), message("two")];

    seedPersistedMessageRefs(refs, hydrated);

    expect(updatePersistedMessageRefs(refs, hydrated)).toEqual([]);
    expect([...refs.keys()]).toEqual(["one", "two"]);
  });

  it("returns only changed durable messages and never tracks queued placeholders", () => {
    const first = message("one", "before");
    const changed = message("one", "after");
    const queued = {
      ...message("queued"),
      role: "user",
      queued: true,
    } as AgentMessage;
    const refs = new Map<string, AgentMessage>([[first.id, first]]);

    expect(updatePersistedMessageRefs(refs, [changed, queued])).toEqual([
      changed,
    ]);
    expect([...refs.keys()]).toEqual(["one"]);
  });

  it("detects a cross-device edit that preserves message count and ids", () => {
    expect(
      messageSnapshotsEqual(
        [message("same-id", "before")],
        [message("same-id", "after")],
      ),
    ).toBe(false);
  });
});
