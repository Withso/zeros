import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { applyUpdate, type AgentMessage } from "@zeros/protocol/agent-messages";
import { CursorDriver } from "../driver";
import { fixtureHost, prompt, text } from "./fixture-host";

let host: Awaited<ReturnType<typeof fixtureHost>>, directory: string;
const drivers: CursorDriver[] = [];
beforeAll(async () => { host = await fixtureHost(); directory = await mkdtemp(join(tmpdir(), "cursor-driver-")); });
afterEach(async () => { for (const driver of drivers.splice(0)) await driver.dispose(); });
afterAll(async () => { await host?.dispose(); await rm(directory, { recursive: true, force: true }); });
async function setup(options: ConstructorParameters<typeof CursorDriver>[0] = {}, resume?: string) {
  const driver = new CursorDriver({ hostPath: host.path,
    environment: { PATH: process.env.PATH, HOME: directory, ZEROS_WORKER_TOKEN: "fixture-worker", ANTHROPIC_AUTH_TOKEN: "fixture-claude", NODE_OPTIONS: "--invalid-fixture", GH_TOKEN: "fixture-ambient" },
    ...options }); drivers.push(driver);
  let rows: AgentMessage[] = [];
  driver.onEvent(event => { rows = applyUpdate(rows, event); });
  const opened = await driver.open({ sessionId: "execution", cwd: directory, apiKey: "fixture-cursor", nativeSessionId: resume });
  return { driver, opened, rows: () => rows, last: () => rows.filter(row => row.kind === "text").at(-1)?.text };
}

it("runs the isolated host with only its own login, explicit models and image input", async () => {
  const f = await setup({}, "native-agent");
  expect(f.opened.nativeSessionId).toBe("native-agent");
  const response = await f.driver.prompt([...prompt({ inspect: true }), { type: "image", mimeType: "image/png", data: "AA==" }]);
  expect(response).toMatchObject({ stopReason: "end_turn", effectiveModel: "composer-2.5" });
  expect(JSON.parse(f.last()!)).toMatchObject({ sends: 1, resumed: true, model: { id: "composer-2.5" }, mode: "agent", ownLogin: true, forbidden: false,
    local: { cwd: directory, autoReview: false, sandboxOptions: { enabled: false } }, images: [{ mimeType: "image/png", data: "AA==" }] });
  await f.driver.setModel("grok-4.7"); await f.driver.prompt(prompt({ inspect: true }));
  expect(JSON.parse(f.last()!)).toMatchObject({ sends: 2, model: { id: "grok-4.7" } });
});

it("cancels a run whose send is pending and can explicitly send again", async () => {
  const f = await setup();
  const running = f.driver.prompt(prompt({ sendDelay: 80, hang: true, before: [{ kind: "delta", value: { type: "text-delta", text: "Preparing" } }] }));
  await expect.poll(f.last).toBe("Preparing"); await f.driver.interrupt();
  await expect(running).resolves.toMatchObject({ stopReason: "cancelled" });
  await expect(f.driver.prompt(prompt({ inspect: true }))).resolves.toMatchObject({ stopReason: "end_turn" });
});

it("preserves text steering, native receipts and uncertainty without affecting the next turn", async () => {
  const f = await setup({ requestTimeoutMs: 2000 });
  const running = f.driver.prompt(prompt({ hang: true })); await expect.poll(f.last).toBe("Ready");
  await expect(f.driver.steer([...text("follow up"), ...text(".context/reference.md")])).resolves.toBe("delivered");
  await expect(f.driver.steer([{ type: "image", mimeType: "image/png", data: "AA==" }])).resolves.toBe("queued");
  const receipt = f.driver.steer(text("lost receipt")); await f.driver.interrupt();
  await expect(receipt).resolves.toBe("interrupted"); await expect(running).resolves.toMatchObject({ stopReason: "cancelled" });
  await expect(f.driver.prompt(prompt({ inspect: true }))).resolves.toMatchObject({ stopReason: "end_turn" });
});

it("preserves a native revert-to-followup as queued", async () => {
  const f = await setup(); const running = f.driver.prompt(prompt({ hang: true, steer: "revert_to_followup" })); await expect.poll(f.last).toBe("Ready");
  await expect(f.driver.steer([...text("follow up"), ...text(".context/reference.md")])).resolves.toBe("queued");
  await f.driver.interrupt(); await running;
});

it.each(["sendHang", "waitHang"])("bounds Stop when native %s never settles and resumes only on an explicit send", async hang => {
  const f = await setup({ interruptTimeoutMs: 30 });
  const running = f.driver.prompt(prompt({ [hang]: true, before: [{ kind: "delta", value: { type: "text-delta", text: "Started" } }] }));
  await expect.poll(f.last).toBe("Started"); await f.driver.interrupt();
  await expect(running).resolves.toMatchObject({ stopReason: "cancelled" });
  await f.driver.prompt(prompt({ inspect: true })); expect(JSON.parse(f.last()!)).toMatchObject({ sends: 1, resumed: true });
});

it("does not confuse request metadata with a native question", async () => {
  const f = await setup();
  await expect(f.driver.prompt(prompt({ frames: [{ kind: "message", value: { type: "request", request_id: "normal-ack" } }], result: { result: "Done" } }))).resolves.toMatchObject({ stopReason: "end_turn" });
  await expect(f.driver.prompt(prompt({ frames: [{ kind: "message", value: { type: "tool_call", name: "askQuestion", status: "running" } }] }))).rejects.toThrow(/interactive/i);
});

it.each([{ status: "expired" }, { status: "running" }, { status: "finished", error: { message: "Native failure" } }])("rejects a failed or incomplete native result: $status", async result => {
  const f = await setup(); await expect(f.driver.prompt(prompt({ result }))).rejects.toThrow();
});

it("fails on host EOF or authentication errors without leaking credentials or retrying", async () => {
  const f = await setup(); await expect(f.driver.prompt(prompt({ eof: true }))).rejects.toThrow(/closed|exited|disconnected/i);
  const failure = await f.driver.prompt(prompt({ authError: true })).catch((error: Error) => error);
  expect(failure).toBeInstanceOf(Error); expect((failure as Error).message).toContain("[redacted]");
  expect((failure as Error).message).not.toContain("fixture-cursor");
});

it("fails promptly when the host cannot deliver its terminal IPC event", async () => {
  const f = await setup(); let failed = false;
  const running = f.driver.prompt(prompt({ outputFailure: true })).catch(() => { failed = true; });
  await expect.poll(() => failed).toBe(true); await running;
});

it("keeps the run alive past intermediate status and usage records", async () => {
  const f = await setup(); let settled = false;
  const running = f.driver.prompt(prompt({ hang: true, frames: [
    { kind: "message", value: { type: "status", status: "FINISHED" } },
    { kind: "delta", value: { type: "turn-ended", usage: { inputTokens: 3 } } },
  ] })).then(result => { settled = true; return result; });
  await expect.poll(f.last).toBe("Ready"); expect(settled).toBe(false);
  await f.driver.interrupt(); await expect(running).resolves.toMatchObject({ stopReason: "cancelled" });
});

it("uses cumulative wait usage and only an exact run's billed cost", async () => {
  const f = await setup();
  const frames = [{ kind: "delta", value: { type: "turn-ended", usage: { inputTokens: 500 } } },
    { kind: "message", value: { type: "usage", usage: { inputTokens: 300 } } }];
  const result = { usage: { inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 3, outputTokens: 4 } };
  const first = await f.driver.prompt(prompt({ frames, result, billed: { runs: [{ runId: "run-1", usage: { inputTokens: 999 }, cost: { chargedCents: 5 } }] } }));
  expect(first.usage).toMatchObject({ accountingVersion: 1, costKind: "reported", inputTokens: 33, cacheReadTokens: 20, outputTokens: 4, totalCostUsd: 0.05 });
  const second = await f.driver.prompt(prompt({ frames, result, billed: { runs: [{ runId: "different-billing-uuid", usage: result.usage, cost: { chargedCents: 5 } }] } }));
  expect(second.usage?.totalCostUsd).toBeUndefined(); expect(second.usage?.inputTokens).toBe(33);
});
