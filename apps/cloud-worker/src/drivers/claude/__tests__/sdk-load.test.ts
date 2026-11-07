import { afterEach, expect, it } from "vitest";
import { ClaudeDriver } from "../driver";
import { createDeferred } from "../input-queue";
import { harness, input, result, text } from "./fake-query";

// The worker loads the Claude SDK on the first turn. A Stop or a dispose that
// lands while it loads must cancel that turn, as it did before the lazy load.
const drivers: ClaudeDriver[] = [];
afterEach(async () => { for (const driver of drivers.splice(0)) await driver.dispose(); });
function setup() {
  const h = harness(), load = createDeferred<typeof h.query>();
  const driver = new ClaudeDriver({ loadQuery: () => load.promise, executable: "/fixture/claude", environment: { PATH: "/usr/bin", HOME: "/fixture/home" } });
  drivers.push(driver);
  return { driver, load, ...h };
}

it("cancels a first turn stopped while the SDK loads and never starts its query", async () => {
  const { driver, load, query, queries } = setup();
  await driver.open(input);
  const turn = driver.prompt(text("hello"));
  await driver.interrupt();
  load.resolve(query);
  await expect(turn).resolves.toEqual({ stopReason: "cancelled" });
  expect(queries).toHaveLength(0);
  const next = driver.prompt(text("again"));
  await expect.poll(() => queries.length).toBe(1);
  const sent = await queries[0]!.read();
  queries[0]!.push(result(sent.uuid));
  await expect(next).resolves.toMatchObject({ stopReason: "end_turn" });
});

it("cancels a first turn when the driver is disposed while the SDK loads", async () => {
  const { driver, load, query, queries } = setup();
  await driver.open(input);
  const turn = driver.prompt(text("hello")), disposed = driver.dispose();
  load.resolve(query);
  await expect(turn).resolves.toEqual({ stopReason: "cancelled" });
  await disposed; expect(queries).toHaveLength(0);
});
