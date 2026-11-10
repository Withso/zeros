import { afterEach, expect, it } from "vitest";
import { CloudWorker } from "../worker";
import type { KillReport } from "../resources/watchdog";
import { CLIENT_A, FakeDriver, FakeRelay, browserFrame, config } from "./worker-fixtures";
import { repositoryFixture } from "../workspace/__tests__/repository-fixture";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function setup() {
  const f = await repositoryFixture(), relay = new FakeRelay(), drivers: FakeDriver[] = [];
  const worker = new CloudWorker({ directory: f.state, homeDirectory: f.directory, transport: relay, prepareCheckout: async () => {},
    workspaceServices: { watch: false }, drivers: { codex: () => { const driver = new FakeDriver(); drivers.push(driver); return driver; } } });
  cleanups.push(() => worker.dispose());
  worker.start();
  await relay.receive({ ...config, workspace: f.scope.workspace });
  await relay.receive({ t: "open", clientId: CLIENT_A });
  const report = (value: KillReport) => (worker as unknown as { reportStopped(report: KillReport): Promise<void> }).reportStopped(value);
  return { f, relay, worker, drivers, report };
}

it("tells the chat whose agent started the process what the watchdog stopped", async () => {
  const { f, relay, worker, report } = await setup();
  await relay.request(CLIENT_A, browserFrame("AGENT_NEW_SESSION", { agentId: "codex", chatId: "chat-a", cwd: f.scope.key }));
  await worker.flush();
  await report({ pid: 4242, name: "node\u001b[2J", rssBytes: 1.5 * 2 ** 30, owner: { kind: "chat", chatId: "chat-a" } });
  await worker.flush();
  const notices = relay.bridge("AGENT_SESSION_UPDATE").flatMap(({ frame }) => frame.type === "AGENT_SESSION_UPDATE" && frame.notification.update.sessionUpdate === "error_notice" ? [frame.notification.update] : []);
  expect(notices).toMatchObject([{ severity: "warning", recoverable: true,
    message: "Zeros stopped node?[2J (PID 4242, 1.5 GB) because the workspace was almost out of memory." }]);
});

it.skipIf(process.platform !== "linux")("writes the notice into the terminal whose shell started the process", async () => {
  const { relay, worker, report } = await setup();
  await relay.request(CLIENT_A, browserFrame("PTY_CREATE", { sessionId: "shell", cols: 120, rows: 10 }));
  const created = relay.bridge("PTY_CREATED")[0]!.frame as { pid: number };
  await report({ pid: 77, name: "pnpm", rssBytes: 300 * 2 ** 20, owner: { kind: "terminal", shellPid: created.pid } });
  await worker.flush();
  const output = relay.bridge("PTY_DATA").map(({ frame }) => (frame as { data: string }).data).join("");
  expect(output).toContain("Zeros stopped pnpm (PID 77, 300 MB) because the workspace was almost out of memory.");
});
