import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import type { QuestionResponse, RequestPermissionResponse, SessionNotification } from "@zeros/protocol/agent-events";
import { CodexDriver } from "../driver";

it.each([
  { kind: "permission", foreign: false, afterAck: false },
  { kind: "question", foreign: false, afterAck: false },
  { kind: "permission", foreign: true, afterAck: true },
  { kind: "question", foreign: true, afterAck: true },
  { kind: "permission", foreign: true, afterAck: false },
  { kind: "question", foreign: true, afterAck: false },
])("matches native input to its actual turn: $kind foreign=$foreign afterAck=$afterAck", async spec => {
  const driver = new CodexDriver({ command: process.execPath, args: [fileURLToPath(new URL("./fixtures/native-owner.mjs", import.meta.url))], environment: {} });
  const onPermission = vi.fn(async (): Promise<RequestPermissionResponse> => ({ outcome: { outcome: "selected", optionId: "accept" } }));
  const onQuestion = vi.fn(async (): Promise<QuestionResponse> => ({ outcome: { outcome: "answered", answers: [{ questionId: "route", selectedOptionIds: ["A"] }] } }));
  const events: SessionNotification[] = [];
  driver.onEvent(event => events.push(event));
  try {
    await driver.open({ sessionId: "execution", cwd: process.cwd(), proxy: { baseUrl: "http://127.0.0.1:1/v1", token: "offline-review-placeholder" },
      modeId: "read-only", onPermission, onQuestion });
    await driver.prompt([{ type: "text", text: "first" }]);
    events.length = 0;
    await driver.prompt([{ type: "text", text: JSON.stringify(spec) }]);
    const output = events.flatMap(({ update }) => update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" ? [update.content.text] : []).join("");
    const callback = spec.kind === "permission" ? onPermission : onQuestion;
    expect({ callbackCount: callback.mock.calls.length, nativeReply: JSON.parse(output) }).toEqual({
      callbackCount: spec.foreign ? 0 : 1,
      nativeReply: spec.kind === "permission" ? { decision: spec.foreign ? "cancel" : "accept" }
        : spec.foreign ? { answers: {} } : { answers: { route: { answers: ["A"] } } },
    });
  } finally { await driver.dispose(); }
});

it.each(["permission", "question"])("cancels %s waiting for native ownership before a held start ACK", async kind => {
  const driver = new CodexDriver({ command: process.execPath, args: [fileURLToPath(new URL("./fixtures/native-owner.mjs", import.meta.url))], environment: {} });
  const onPermission = vi.fn(), onQuestion = vi.fn();
  let requested!: () => void;
  const received = new Promise<void>(resolve => { requested = resolve; });
  const boundary = driver as unknown as { nativeRequest(method: string, params: unknown, id: string | number): Promise<unknown> };
  const nativeRequest = boundary.nativeRequest.bind(driver);
  vi.spyOn(boundary, "nativeRequest").mockImplementation((...args) => { requested(); return nativeRequest(...args); });
  let prompt: Promise<unknown> | undefined;
  try {
    await driver.open({ sessionId: "execution", cwd: process.cwd(), proxy: { baseUrl: "http://127.0.0.1:1/v1", token: "offline-review-placeholder" },
      modeId: "read-only", onPermission, onQuestion });
    await driver.prompt([{ type: "text", text: "first" }]);
    prompt = driver.prompt([{ type: "text", text: JSON.stringify({ kind, ackOnResponse: true }) }]);
    void prompt.catch(() => {});
    await received;
    await driver.interrupt();
    await prompt;
    expect(onPermission).not.toHaveBeenCalled(); expect(onQuestion).not.toHaveBeenCalled();
  } finally { await driver.dispose(); await Promise.allSettled([prompt]); }
});

it.each(["permission", "question"])("bounds a %s ownership wait by the original start deadline", async kind => {
  const driver = new CodexDriver({ command: process.execPath, args: [fileURLToPath(new URL("./fixtures/native-owner.mjs", import.meta.url))], environment: {}, requestTimeoutMs: 1000 });
  const onPermission = vi.fn(), onQuestion = vi.fn();
  try {
    await driver.open({ sessionId: "execution", cwd: process.cwd(), proxy: { baseUrl: "http://127.0.0.1:1/v1", token: "offline-review-placeholder" },
      modeId: "read-only", onPermission, onQuestion });
    await driver.prompt([{ type: "text", text: "first" }]);
    await expect(driver.prompt([{ type: "text", text: JSON.stringify({ kind, missingAck: true }) }])).rejects.toThrow("timed out");
    expect(onPermission).not.toHaveBeenCalled(); expect(onQuestion).not.toHaveBeenCalled();
  } finally { await driver.dispose(); }
});
