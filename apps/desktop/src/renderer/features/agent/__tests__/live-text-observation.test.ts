import { describe, expect, it, vi } from "vitest";
import {
  observeLiveAgentText,
  observeLiveToolOutput,
  type LiveAgentTextSource,
} from "../local-live-text";
import type { AgentTextMessage, AgentToolMessage } from "../use-agent-session";

function fixture() {
  let message: AgentTextMessage = {
    id: "answer",
    kind: "text",
    role: "agent",
    text: "First token",
    createdAt: 1,
  };
  const listeners = new Set<() => void>(),
    watchers = new Set<() => void>();
  const frames = new Map<number, (now: number) => void>();
  let handle = 0,
    visible = true;
  const source: LiveAgentTextSource = {
    read: () => message,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const observation = observeLiveAgentText(source, message, {
    visible: () => visible,
    requestFrame: (callback) => {
      frames.set(++handle, callback);
      return handle;
    },
    cancelFrame: (id) => {
      frames.delete(id);
    },
    watch: (listener) => {
      watchers.add(listener);
      return () => {
        watchers.delete(listener);
      };
    },
  });
  const notify = vi.fn();
  const unsubscribe = observation.subscribe(notify);
  return {
    observation,
    notify,
    unsubscribe,
    frames,
    listeners,
    watchers,
    update(text: string) {
      message = { ...message, text };
      for (const listener of listeners) listener();
    },
    visible(value: boolean) {
      visible = value;
      for (const listener of watchers) listener();
    },
    frame(at: number) {
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback(at);
    },
    text: () => observation.getSnapshot().message.text,
  };
}

describe("Local live text publication", () => {
  it("keeps command output immediate, hidden-inert and releases both listeners", () => {
    let message: AgentToolMessage = { id: "command", toolCallId: "command", kind: "tool", toolKind: "execute",
      title: "Run checks", status: "in_progress", rawOutput: "First", createdAt: 1, updatedAt: 1 };
    let visible = true;
    const listeners = new Set<() => void>(), watchers = new Set<() => void>();
    const source: LiveAgentTextSource = { read: (initial) => initial, readTool: () => message,
      subscribe: (changed) => { listeners.add(changed); return () => { listeners.delete(changed); }; } };
    const observer = observeLiveToolOutput(source, message, { visible: () => visible,
      watch: (changed) => { watchers.add(changed); return () => { watchers.delete(changed); }; } });
    const changed = vi.fn(), release = observer.subscribe(changed);
    message = { ...message, rawOutput: "First grows" };
    for (const notify of listeners) notify();
    expect(changed).toHaveBeenCalledOnce();
    expect(observer.getSnapshot().message).toBe(message);
    for (const notify of listeners) notify();
    expect(changed).toHaveBeenCalledOnce();
    visible = false;
    message = { ...message, rawOutput: "First grows while hidden" };
    for (const notify of listeners) notify();
    expect(changed).toHaveBeenCalledOnce();
    expect(observer.getSnapshot().message).toBe(message);
    visible = true;
    for (const notify of watchers) notify();
    expect(changed).toHaveBeenCalledTimes(2);
    release();
    expect(listeners.size).toBe(0);
    expect(watchers.size).toBe(0);
  });

  it("publishes the full text as it arrives, at most once per frame", () => {
    const h = fixture();
    expect(h.text()).toBe("First token");
    const final = `First token${" abc".repeat(100)}`;
    h.update(final.slice(0, 100));
    h.update(final.slice(0, 200));
    h.update(final);
    // Several deltas in one frame lay out once, with everything received.
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.frames.size).toBe(1);
    h.frame(16);
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.text()).toBe(final);
    expect(h.frames.size).toBe(0);
    h.frame(32);
    expect(h.notify).toHaveBeenCalledTimes(1);
    h.unsubscribe();
  });

  it("publishes corrections and truncations as they arrive", () => {
    const h = fixture();
    h.update(`First token ${"x".repeat(500)}`);
    h.frame(16);
    h.update("Corrected");
    h.frame(32);
    expect(h.text()).toBe("Corrected");
    h.update("Correct");
    h.frame(48);
    expect(h.text()).toBe("Correct");
    h.unsubscribe();
  });

  it("stays silent while hidden and shows the full text when shown again", () => {
    const h = fixture();
    h.visible(false);
    h.update("First token plus hidden content");
    expect(h.frames.size).toBe(0);
    expect(h.notify).not.toHaveBeenCalled();
    h.visible(true);
    expect(h.text()).toBe("First token plus hidden content");
    expect(h.notify).toHaveBeenCalledOnce();
    expect(h.frames.size).toBe(0);
    h.unsubscribe();
  });

  it("removes the frame and both observers after the last subscriber leaves", () => {
    const h = fixture();
    h.update("First token plus content");
    h.unsubscribe();
    expect(h.frames.size).toBe(0);
    expect(h.listeners.size).toBe(0);
    expect(h.watchers.size).toBe(0);
    h.update("First token plus new hidden content");
    h.frame(160);
    expect(h.notify).not.toHaveBeenCalled();
    const unsubscribe = h.observation.subscribe(h.notify);
    expect(h.text()).toBe("First token plus new hidden content");
    expect(h.frames.size).toBe(0);
    unsubscribe();
  });
});
