import { afterEach, expect, it } from "vitest";
import type { BridgeMessage } from "@zeros/protocol/messages";
import type { AppClient } from "../../agents";
import { browserFrame } from "../../__tests__/worker-fixtures";
import { repositoryFixture } from "../../workspace/__tests__/repository-fixture";
import { Terminals, type TerminalPeople, type TerminalProcess, type TerminalSpawnOptions } from "../service";

/** Team sharing slice B: an activated workspace's shell runs as the person who opened it, and only they can use it. */
const ALEX = "44444444-4444-4444-8444-444444444444", SAM = "55555555-5555-4555-8555-555555555555";
const services: Terminals[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.dispose(); });
const frame = (type: string, fields: Record<string, unknown> = {}) => browserFrame(type, fields) as unknown as BridgeMessage;
function client(id: string, userId?: string) {
  const frames: BridgeMessage[] = [];
  const value: AppClient & { userId?: string } = { id, ...(userId ? { userId } : {}), send: async message => { frames.push(message); } };
  return { client: value, frames };
}
class FakeProcess implements TerminalProcess {
  pid = 4321; killed = false; written: string[] = [];
  private exit: (exit: { exitCode: number; signal?: number }) => void = () => {};
  onData() { return { dispose() {} }; }
  onExit(callback: (exit: { exitCode: number; signal?: number }) => void) { this.exit = callback; return { dispose() {} }; }
  write(data: string) { this.written.push(data); }
  resize() {}
  kill() { this.killed = true; this.exit({ exitCode: 0, signal: 15 }); }
  pause() {} resume() {}
}

async function setup() {
  const { scope } = await repositoryFixture();
  const spawned: TerminalSpawnOptions[] = [], natives: FakeProcess[] = [];
  const leases: Array<{ clientId: string; terminalId: string; requestId: string }> = [], retired: string[] = [];
  const ends = new Map<string, () => void>();
  let n = 0;
  const people: TerminalPeople = {
    of: value => (value as { userId?: string }).userId,
    lease: async (value, terminalId, requestId) => {
      leases.push({ clientId: value.id, terminalId, requestId });
      const userId = (value as { userId?: string }).userId!, contextId = `66666666-6666-4666-8666-66666666666${n++}`;
      return { contextId, userId, git: { GIT_AUTHOR_NAME: userId === ALEX ? "Alex" : "Sam" },
        zeros: { ZEROS_EXECUTION_CONTEXT: contextId }, application: { PERSONAL: userId === ALEX ? "alex" : "sam" } };
    },
    ended: (contextId, listener) => { ends.set(contextId, listener); return () => ends.delete(contextId); },
    retire: async contextId => { retired.push(contextId); },
  };
  const service = new Terminals(scope, { people, spawn: async options => { spawned.push(options); const native = new FakeProcess(); natives.push(native); return native; } });
  services.push(service);
  return { service, spawned, natives, leases, retired, ends };
}

it("spawns a shell from its opener's terminal lease, with that person's identity and context", async () => {
  const f = await setup(), alex = client("a", ALEX);
  const create = frame("PTY_CREATE", { sessionId: "t1" });
  await f.service.handle(alex.client, create);
  expect(f.leases).toEqual([{ clientId: "a", terminalId: "t1", requestId: create.id }]);
  expect(f.spawned[0]!.env).toMatchObject({ GIT_AUTHOR_NAME: "Alex", ZEROS_EXECUTION_CONTEXT: "66666666-6666-4666-8666-666666666660", PERSONAL: "alex" });
});

it("refuses a client without a person, and keeps another person out of the shell: no list, attach, input, resize or kill", async () => {
  const f = await setup(), nobody = client("x"), alex = client("a", ALEX), sam = client("s", SAM);
  await f.service.handle(nobody.client, frame("PTY_CREATE", { sessionId: "t0" }));
  expect(f.spawned).toHaveLength(0);
  expect(nobody.frames.find(message => message.type === "PTY_EXIT")).toMatchObject({ reason: "spawn-failed" });
  await f.service.handle(alex.client, frame("PTY_CREATE", { sessionId: "t1" }));
  await f.service.handle(sam.client, frame("PTY_CREATE", { sessionId: "t1" }));
  expect(f.spawned).toHaveLength(1);
  expect(sam.frames.some(message => message.type === "PTY_CREATED")).toBe(false);
  await f.service.handle(sam.client, frame("PTY_WRITE", { sessionId: "t1", data: "rm -rf ~\r" }));
  await f.service.handle(sam.client, frame("PTY_KILL", { sessionId: "t1" }));
  expect(f.natives[0]!.written).toEqual([]); expect(f.natives[0]!.killed).toBe(false);
  const listing = frame("PTY_LIST", { workspaceId: "11111111-1111-4111-8111-111111111111" });
  await f.service.handle(sam.client, { ...listing, workspaceId: (f.service as unknown as { scope: { workspace: { id: string } } }).scope.workspace.id } as BridgeMessage);
  expect(sam.frames.find(message => message.type === "PTY_LIST_RESULT")).toMatchObject({ terminals: [] });
  const again = client("a2", ALEX);
  await f.service.handle(again.client, frame("PTY_CREATE", { sessionId: "t1" }));
  expect(again.frames.find(message => message.type === "PTY_CREATED")).toMatchObject({ reattached: true });
  await f.service.handle(again.client, frame("PTY_WRITE", { sessionId: "t1", data: "ls\r" }));
  expect(f.natives[0]!.written).toEqual(["ls\r"]);
});

it("ends the shell when its context ends, and retires the context when the shell goes", async () => {
  const f = await setup(), alex = client("a", ALEX);
  await f.service.handle(alex.client, frame("PTY_CREATE", { sessionId: "t1" }));
  await f.service.handle(alex.client, frame("PTY_CREATE", { sessionId: "t2" }));
  f.ends.get("66666666-6666-4666-8666-666666666660")!();
  await f.service.flush();
  expect(f.natives[0]!.killed).toBe(true);
  expect(f.retired).toEqual(["66666666-6666-4666-8666-666666666660"]);
  await f.service.handle(alex.client, frame("PTY_KILL", { sessionId: "t2" }));
  await f.service.flush();
  expect(f.retired).toEqual(["66666666-6666-4666-8666-666666666660", "66666666-6666-4666-8666-666666666661"]);
});

it("shows an agent only its own person's shells", async () => {
  const f = await setup(), alex = client("a", ALEX);
  await f.service.handle(alex.client, frame("PTY_CREATE", { sessionId: "t1" }));
  expect(await f.service.output({ maxLines: 10, userId: ALEX })).toMatchObject({ terminalId: "t1" });
  expect(await f.service.output({ maxLines: 10, userId: SAM })).toBeUndefined();
  expect(await f.service.output({ maxLines: 10 })).toBeUndefined();
  expect(await f.service.output({ maxLines: 10, terminalId: "t1", userId: SAM })).toBeUndefined();
});
