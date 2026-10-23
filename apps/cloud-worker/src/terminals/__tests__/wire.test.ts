import { afterEach, expect, it, vi } from "vitest";
import { CloudWorker } from "../../worker";
import { CLIENT_A, CLIENT_B, FakeRelay, browserFrame, config } from "../../__tests__/worker-fixtures";
import { repositoryFixture } from "../../workspace/__tests__/repository-fixture";
import { Terminals } from "../service";

const workers: CloudWorker[] = [];
afterEach(async () => { for (const worker of workers.splice(0)) await worker.dispose(); vi.useRealTimers(); vi.restoreAllMocks(); });

it("reports idle once when terminal activity expires between heartbeats", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  let active = true;
  vi.spyOn(Terminals.prototype, "busy", "get").mockImplementation(() => active);
  const { scope, state } = await repositoryFixture(), relay = new FakeRelay();
  const worker = new CloudWorker({ directory: state, transport: relay, prepareCheckout: async () => {} }); workers.push(worker); worker.start();
  await relay.receive({ ...config, workspace: scope.workspace });
  expect(relay.frames.filter(frame => frame.t === "idle").at(-1)).toEqual({ t: "idle", idle: false });
  active = false; await vi.advanceTimersByTimeAsync(55_000);
  expect(relay.frames.filter(frame => frame.t === "idle").at(-1)).toEqual({ t: "idle", idle: true });
  const count = relay.frames.filter(frame => frame.t === "idle").length;
  await vi.advanceTimersByTimeAsync(55_000);
  expect(relay.frames.filter(frame => frame.t === "idle")).toHaveLength(count);
});

it("keeps one native shell across relay reconnect and reports terminal activity", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const { scope, state } = await repositoryFixture(), relay = new FakeRelay();
  const worker = new CloudWorker({ directory: state, transport: relay, prepareCheckout: async () => {} }); workers.push(worker); worker.start();
  await relay.receive({ ...config, workspace: scope.workspace }); await relay.receive({ t: "open", clientId: CLIENT_A });
  await relay.request(CLIENT_A, browserFrame("PTY_CREATE", { sessionId: "wire", cwd: scope.root, workspaceId: scope.workspace.id }));
  await expect.poll(() => relay.bridge("PTY_CREATED").length, { timeout: 1000 }).toBe(1);
  const original = relay.bridge("PTY_CREATED")[0].frame;
  expect(relay.frames.filter(frame => frame.t === "idle").at(-1)).toEqual({ t: "idle", idle: false });
  const beforeHeartbeat = relay.frames.filter(frame => frame.t === "idle").length;
  await vi.advanceTimersByTimeAsync(55_000);
  expect(relay.frames.filter(frame => frame.t === "idle")).toHaveLength(beforeHeartbeat + 1);
  expect(relay.frames.filter(frame => frame.t === "idle").at(-1)).toEqual({ t: "idle", idle: false });
  relay.disconnect(); await relay.reconnect(); await relay.receive({ ...config, workspace: scope.workspace });
  await relay.receive({ t: "open", clientId: CLIENT_B });
  await relay.request(CLIENT_B, browserFrame("PTY_LIST", { workspaceId: scope.workspace.id }));
  expect(relay.bridge("PTY_LIST_RESULT").at(-1)?.frame).toMatchObject({ terminals: [{ sessionId: "wire", cwd: scope.root }] });
  await relay.request(CLIENT_B, browserFrame("PTY_CREATE", { sessionId: "wire" }));
  if (original.type !== "PTY_CREATED") throw new Error("Missing terminal create reply.");
  expect(relay.bridge("PTY_CREATED").at(-1)?.frame).toMatchObject({ reattached: true, pid: original.pid });
  await relay.request(CLIENT_B, browserFrame("PTY_KILL", { sessionId: "wire" })); await worker.flush();
  expect(relay.frames.filter(frame => frame.t === "idle").at(-1)).toEqual({ t: "idle", idle: true });
  await relay.request(CLIENT_B, browserFrame("PTY_LIST"));
  expect(relay.bridge("PTY_LIST_RESULT").at(-1)?.frame).toMatchObject({ terminals: [] });
});
