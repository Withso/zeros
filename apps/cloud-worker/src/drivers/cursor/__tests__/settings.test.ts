import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { applyUpdate, type AgentMessage } from "@zeros/protocol/agent-messages";
import { CursorDriver } from "../driver";
import { fixtureHost, prompt, text } from "./fixture-host";

let host: Awaited<ReturnType<typeof fixtureHost>>, directory: string;
const drivers: CursorDriver[] = [];
beforeAll(async () => { host = await fixtureHost(); directory = await mkdtemp(join(tmpdir(), "cursor-config-")); });
afterEach(async () => { for (const driver of drivers.splice(0)) await driver.dispose(); });
afterAll(async () => { await host?.dispose(); await rm(directory, { recursive: true, force: true }); });
async function setup(selection: { model?: string; effort?: string; fast?: boolean } = {}) {
  const driver = new CursorDriver({ hostPath: host.path, environment: { PATH: process.env.PATH, HOME: directory } });
  drivers.push(driver); let rows: AgentMessage[] = [];
  driver.onEvent(event => { rows = applyUpdate(rows, event); });
  await driver.open({ sessionId: "execution", cwd: directory, apiKey: "fixture-cursor", ...selection });
  return { driver, last: () => rows.filter(row => row.kind === "text").at(-1)?.text };
}
const grok = (effort: string, fast: boolean) => ({ id: "grok-4.7", params: [
  { id: "context", value: "large" }, { id: "effort", value: effort }, { id: "fast", value: String(fast) },
] });

it("resolves the native catalog's defaults and requested knobs identically on open and send", async () => {
  const f = await setup({ model: "grok-4.7", effort: "low", fast: true });
  await f.driver.prompt(prompt({ inspect: true }));
  expect(JSON.parse(f.last()!)).toMatchObject({ initialModel: grok("low", true), model: grok("low", true) });
});

it("retains a mid-turn selection for the next send without changing or cancelling the running run", async () => {
  const f = await setup();
  const running = f.driver.prompt(prompt({ inspect: true, hang: true }));
  await expect.poll(f.last).toBe("Ready");
  await f.driver.updateConfig({ model: "grok-4.7", effort: "xhigh", fast: true });
  await expect(f.driver.steer(text("finish run"))).resolves.toBe("delivered");
  await expect(running).resolves.toMatchObject({ stopReason: "end_turn", effectiveModel: "composer-2.5" });
  expect(JSON.parse(f.last()!)).toMatchObject({ model: { id: "composer-2.5" } });
  await f.driver.prompt(prompt({ inspect: true }));
  expect(JSON.parse(f.last()!)).toMatchObject({ sends: 2, model: grok("xhigh", true) });
  await f.driver.updateConfig({ fast: false });
  await f.driver.prompt(prompt({ inspect: true }));
  expect(JSON.parse(f.last()!)).toMatchObject({ sends: 3, model: grok("high", false) });
});

it("uses only advertised legacy variants and can turn Fast back off without retaining a suffixed selection", async () => {
  const f = await setup({ fast: true });
  await f.driver.prompt(prompt({ inspect: true }));
  expect(JSON.parse(f.last()!).model).toEqual({ id: "composer-2.5-fast" });
  await f.driver.updateConfig({ effort: "xhigh", fast: false });
  await f.driver.prompt(prompt({ inspect: true }));
  expect(JSON.parse(f.last()!).model).toEqual({ id: "composer-2.5" });
});

it("captures the running send's selection before yielding to a configuration update", async () => {
  const f = await setup({ model: "grok-4.7", effort: "low", fast: false });
  const running = f.driver.prompt(prompt({ inspect: true }));
  await f.driver.updateConfig({ effort: "xhigh", fast: true });
  await running;
  expect(JSON.parse(f.last()!).model).toEqual(grok("low", false));
  await f.driver.prompt(prompt({ inspect: true }));
  expect(JSON.parse(f.last()!)).toMatchObject({ sends: 2, model: grok("xhigh", true) });
});
