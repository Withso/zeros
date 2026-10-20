import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudCommandSnapshotSchema, CloudBootCommandClaimSchema,
  type CloudCommandEngineRequest, type CloudBootCommandEngineRequest, type CloudQueuedPrompt } from "@zeros/protocol/cloud-commands";
import { CloudActorAuthorityRegistry } from "../agents/cloud-agent-lease";
import { CloudLocalCommandQueue } from "../cloud-local-command-queue";
import { CloudCommandRuntime } from "../cloud-command-runtime";

// Real SQLite/actor fixture copied from the reviewed suite; product source is unchanged.
const temporary: string[] = [];
const handles: CloudLocalCommandQueue[] = [];
const scope = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 3,
  engineInstanceId: randomUUID(), bootId: randomUUID(), writerEpoch: randomUUID(), fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 1 };
const actor = { userId: scope.fundingOwnerUserId, deviceId: randomUUID(), deviceKeyVersion: 2,
  role: "owner" as const, fingerprint: "a".repeat(64) };
const actorSessionId = randomUUID();
const now = 1_000_000;
function fixture(options: { file?: string; writer?: typeof scope; limits?: ConstructorParameters<typeof CloudLocalCommandQueue>[0]["limits"];
  selectExecution?: ConstructorParameters<typeof CloudLocalCommandQueue>[0]["selectExecution"];
  captureHistory?: ConstructorParameters<typeof CloudLocalCommandQueue>[0]["captureHistory"]; turnJournalChanged?: () => void } = {}) {
  const writer = options.writer ?? scope;
  const directory = options.file ? null : mkdtempSync(join(tmpdir(), "zeros-local-queue-"));
  if (directory) temporary.push(directory);
  const file = options.file ?? join(directory!, "queue.sqlite");
  const engineLive = vi.fn(() => true);
  const actors = new CloudActorAuthorityRegistry({ scope: writer, engineLive, time: { wall: () => now, monotonic: () => 0 } });
  actors.confirm({ scope: writer, actor, actorSessionId, authorityEpoch: 1, confirmedUntilMs: now + 9_000,
    fundingConsentVersion: 1, fundingGrant: { kind: "owner" } });
  const history = vi.fn(() => ({ recordSequence: 7, eventSequence: 12 }));
  const ready = vi.fn(() => true);
  const queue = new CloudLocalCommandQueue({ file, scope: writer, actors, engineLive, now: () => now, history, ready, limits: options.limits,
    ...(options.selectExecution ? { selectExecution: options.selectExecution } : {}),
    ...(options.captureHistory ? { captureHistory: options.captureHistory } : {}),
    ...(options.turnJournalChanged ? { turnJournalChanged: options.turnJournalChanged } : {}) });
  handles.push(queue);
  const request = (input: CloudCommandEngineRequest | CloudBootCommandEngineRequest, epoch = writer.writerEpoch, session = actorSessionId) =>
    queue.handle(input, { writerEpoch: epoch, actorSessionId: session });
  const snapshot = (conversationId = "chat") => CloudCommandSnapshotSchema.parse(request({ kind: "snapshot", conversationId }));
  const payload = (userMessageId = randomUUID()): CloudQueuedPrompt => ({ agentId: "claude", userMessageId, modeRevision: 0,
    model: "claude-sonnet-4-6", permissionMode: "default", prompt: [{ type: "text", text: "synthetic queue fixture" }] });
  const enqueue = (value = payload(), expectedRevision = snapshot().revision, conversationId = "chat") => ({ kind: "mutate" as const,
    mutation: { conversationId, operationId: randomUUID(), expectedRevision,
      action: { kind: "enqueue" as const, commandId: randomUUID(), payload: value } }, admissionError: null });
  const claim = (conversationId = "chat", claimId: string = randomUUID(), executionId: string = randomUUID()) =>
    CloudBootCommandClaimSchema.nullable().parse(request({ kind: "claim", conversationId, claimId, executionId }));
  return { queue, file, writer, actors, engineLive, history, ready, request, snapshot, payload, enqueue, claim };
}
afterEach(() => { for (const handle of handles.splice(0)) handle.close(); for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function gate() {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  return { wait, release };
}

describe("W3 exact Stop target across another command's admission", () => {
  it.each([
    { target: "queued", boundary: "prepare", expected: "succeeded" },
    { target: "queued", boundary: "dispatch", expected: "succeeded" },
    { target: "active", boundary: "prepare", expected: "cancelled" },
    { target: "legacy", boundary: "prepare", expected: "cancelled" },
  ] as const)("Stop $target while earlier command is at $boundary leaves it $expected", async ({ target, boundary, expected }) => {
    const f = fixture(), entered = gate(), release = gate();
    let execution: string | null = null;
    const prepare = vi.fn(async (claim: { executionId: string }) => {
      execution = claim.executionId;
      if (boundary === "prepare") { entered.release(); await release.wait; }
    });
    const dispatch = vi.fn(async () => {
      if (boundary === "dispatch") { entered.release(); await release.wait; }
      return { state: "succeeded" as const, resultCode: null };
    });
    const cancel = vi.fn(async () => {});
    const runtime = new CloudCommandRuntime({ request: async () => { throw new Error("Unexpected CP request"); },
      validate: () => {}, execution: () => execution, prepare, dispatch,
      retire: async () => {}, cancel, changed: () => {} });
    try {
      runtime.installLocalQueue(f.queue);
      const first = f.enqueue();
      await runtime.handle({ kind: "mutate", mutation: first.mutation }, actorSessionId);
      await entered.wait;
      const firstId = first.mutation.action.commandId;
      expect(f.snapshot().pending).toMatchObject([{ commandId: firstId, state: "dispatching" }]);
      const second = f.enqueue();
      await runtime.handle({ kind: "mutate", mutation: second.mutation }, actorSessionId);
      const secondId = second.mutation.action.commandId;
      expect(f.snapshot().pending).toMatchObject([
        { commandId: firstId, state: "dispatching" }, { commandId: secondId, state: "queued" },
      ]);
      await runtime.handle({ kind: "stop", conversationId: "chat", operationId: randomUUID(),
        ...(target === "legacy" ? {} : { commandId: target === "queued" ? secondId : firstId }) }, actorSessionId);
      expect(f.snapshot().paused).toBe(true);
      expect(cancel).toHaveBeenCalledTimes(target === "queued" ? 0 : 1);
      if (target === "queued") {
        await runtime.handle({ kind: "mutate", mutation: { conversationId: "chat", operationId: randomUUID(),
          expectedRevision: f.snapshot().revision, action: { kind: "remove", commandId: secondId } } }, actorSessionId);
        expect(f.snapshot().receipts.find(row => row.commandId === secondId)?.state).toBe("cancelled");
      }
      release.release();
      await vi.waitFor(() => expect(f.snapshot().receipts.some(row => row.commandId === firstId)).toBe(true));
      expect(f.snapshot().receipts.find(row => row.commandId === firstId)?.state).toBe(expected);
      expect(dispatch).toHaveBeenCalledTimes(expected === "succeeded" ? 1 : 0);
    } finally { release.release(); runtime.close(); }
  });
});
