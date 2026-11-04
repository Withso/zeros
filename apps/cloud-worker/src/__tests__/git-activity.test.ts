import { expect, it, vi } from "vitest";
import { CloudWorker } from "../worker";
import { RECENT_ACTIVITY_MS } from "../activity";
import { commandRunner } from "../workspace/commands";
import { repositoryFixture } from "../workspace/__tests__/repository-fixture";
import { CLIENT_A, FakeRelay, browserFrame, config } from "./worker-fixtures";

it("keeps catalog fetch active across the worker dispatcher while catalog reads stay passive", async () => {
  const fixture = await repositoryFixture();
  await fixture.git("remote", "add", "origin", ".");
  let release!: () => void, entered!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const relay = new FakeRelay(), run = commandRunner(fixture.root);
  const worker = new CloudWorker({ directory: fixture.state, homeDirectory: fixture.directory, transport: relay,
    prepareCheckout: async () => {}, drivers: {}, workspaceServices: { watch: false, run: async (command, args, options) => {
      if (command === "git" && args[0] === "fetch") { entered(); await hold; return { code: 0, stdout: "", stderr: "" }; }
      return run(command, args, options);
    } } });
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  let pending: Promise<void> | undefined;
  try {
    worker.start(); await relay.receive({ ...config, workspace: fixture.scope.workspace, agents: {} });
    await relay.receive({ t: "open", clientId: CLIENT_A });
    expect(relay.frames.filter(frame => frame.t === "idle").at(-1)).toEqual({ t: "idle", idle: true });
    const read = browserFrame("WORKSPACE_REQUEST", { op: "git.repoBranchCatalog", params: { fetch: false } });
    await relay.request(CLIENT_A, read);
    expect(relay.response(read.id)?.type).toBe("WORKSPACE_RESPONSE");
    expect(relay.frames.filter(frame => frame.t === "idle").at(-1)).toEqual({ t: "idle", idle: true });
    const fetch = browserFrame("WORKSPACE_REQUEST", { op: "git.repoBranchCatalog", params: { fetch: true } });
    pending = relay.request(CLIENT_A, fetch); await started;
    expect(relay.frames.filter(frame => frame.t === "idle").at(-1)).toEqual({ t: "idle", idle: false });
    now += RECENT_ACTIVITY_MS + 1;
    await vi.advanceTimersByTimeAsync(55_000);
    expect(relay.frames.filter(frame => frame.t === "idle").at(-1)).toEqual({ t: "idle", idle: false });
    const concurrent = browserFrame("WORKSPACE_REQUEST", { op: "git.repoBranchCatalog", params: {} });
    await relay.request(CLIENT_A, concurrent);
    expect(relay.response(concurrent.id)?.type).toBe("WORKSPACE_RESPONSE");
    expect(relay.response(fetch.id)).toBeUndefined();
    release(); await pending;
    expect(relay.response(fetch.id)?.type).toBe("WORKSPACE_RESPONSE");
    now += RECENT_ACTIVITY_MS + 1;
    await vi.advanceTimersByTimeAsync(55_000);
    await expect.poll(() => relay.frames.filter(frame => frame.t === "idle").at(-1)).toEqual({ t: "idle", idle: true });
  } finally {
    release(); await pending; await worker.dispose(); vi.useRealTimers(); vi.restoreAllMocks();
  }
});
