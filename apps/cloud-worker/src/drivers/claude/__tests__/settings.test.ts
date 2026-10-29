import { afterEach, expect, it, vi } from "vitest";
import { ClaudeDriver } from "../driver";
import { createDeferred } from "../input-queue";
import { harness, input, nativeId, result, text, tick } from "./fake-query";

const drivers: ClaudeDriver[] = [];
afterEach(async () => { for (const driver of drivers.splice(0)) await driver.dispose(); });
function setup() {
  const h = harness(), driver = new ClaudeDriver({ query: h.query, executable: "/fixture/claude", environment: {} });
  drivers.push(driver); return { driver, ...h };
}

it("applies effort and Fast to a running query, clears them explicitly, and retains the next send", async () => {
  const { driver, queries } = setup();
  await driver.open({ ...input, effort: "low", fast: true });
  let settled = false;
  const turn = driver.prompt(text("one")).then(value => { settled = true; return value; });
  const query = queries[0], one = await query.read();
  expect(query.args.options.settings).toMatchObject({ effortLevel: "low", fastMode: true, ultracode: false });
  await driver.updateConfig({ effort: "ultracode", fast: false });
  expect(query.flagSettings.at(-1)).toEqual({ effortLevel: "xhigh", fastMode: false, ultracode: true });
  expect(settled).toBe(false); expect(query.closed).toBe(false); expect(query.interrupts).toBe(0);
  query.push(result(one.uuid)); await turn;
  const next = driver.prompt(text("two")), two = await query.read();
  expect(queries).toHaveLength(1);
  query.push(result(two.uuid)); await next;
  await driver.updateConfig({ fast: false });
  expect(query.flagSettings.at(-1)).toEqual({ effortLevel: null, fastMode: false, ultracode: false });
  query.end(); await tick();
  const resumed = driver.prompt(text("three")), replacement = queries[1], three = await replacement.read();
  expect(replacement.args.options).toMatchObject({ resume: nativeId, settings: { fastMode: false, ultracode: false } });
  expect(replacement.args.options.settings).not.toHaveProperty("effortLevel");
  replacement.push(result(three.uuid)); await resumed;
});

it.each([
  ["low", "max"], ["max", "high"], ["max", undefined], ["ultracode", "max"],
])("stages %s → %s until the next prompt without retiring the running query", async (before, after) => {
  const { driver, queries } = setup(); await driver.open({ ...input, effort: before });
  const first = driver.prompt(text("one")), query = queries[0], one = await query.read();
  await driver.updateConfig({ effort: after, fast: true });
  expect(query.flagSettings).toEqual([]); expect(query.closed).toBe(false); expect(query.interrupts).toBe(0);
  query.push(result(one.uuid)); await first;
  expect(query.closed).toBe(false);
  const next = driver.prompt(text("two")), replacement = queries[1], two = await replacement.read();
  expect(query.closed).toBe(true);
  expect(replacement.args.options).toMatchObject({ resume: nativeId, settings: { fastMode: true, ultracode: false } });
  if (after === "max") expect(replacement.args.options.effort).toBe("max");
  else {
    expect(replacement.args.options).not.toHaveProperty("effort");
    expect((replacement.args.options.settings as Record<string, unknown>).effortLevel).toBe(after);
  }
  // The old consumer cannot settle or close its replacement.
  query.push(result(one.uuid)); await tick(); expect(replacement.closed).toBe(false);
  replacement.push(result(two.uuid)); await next;
});

it("keeps Fast live while Max stays selected and stages an idle Max transition until send", async () => {
  const { driver, queries } = setup(); await driver.open({ ...input, effort: "max" });
  const first = driver.prompt(text("one")), query = queries[0], one = await query.read();
  await driver.updateConfig({ effort: "max", fast: true });
  expect(query.flagSettings).toEqual([{ fastMode: true, ultracode: false }]);
  query.push(result(one.uuid)); await first;
  await driver.updateConfig({ effort: "low", fast: false });
  expect(query.closed).toBe(false); expect(queries).toHaveLength(1);
  const next = driver.prompt(text("two")), replacement = queries[1], two = await replacement.read();
  expect(replacement.args.options.settings).toMatchObject({ effortLevel: "low", fastMode: false });
  replacement.push(result(two.uuid)); await next;
});

it("applies a full model snapshot and preserves selections when native live settings reject", async () => {
  const { driver, queries } = setup(); await driver.open({ ...input, effort: "low" });
  const first = driver.prompt(text("one")), query = queries[0], one = await query.read();
  await driver.updateConfig({ model: "claude-opus-5-5", effort: "high", fast: true });
  expect(query.models).toEqual(["claude-opus-5-5"]);
  expect(query.flagSettings.at(-1)).toEqual({ effortLevel: "high", fastMode: true, ultracode: false });
  vi.spyOn(query, "applyFlagSettings").mockRejectedValue(new Error("Synthetic settings rejection"));
  await expect(driver.updateConfig({ effort: "xhigh", fast: false })).resolves.toBeUndefined();
  expect(query.closed).toBe(false); expect(query.interrupts).toBe(0);
  query.push(result(one.uuid)); await first;
  query.end(); await tick();
  const next = driver.prompt(text("two")), replacement = queries[1], two = await replacement.read();
  expect(replacement.args.options).toMatchObject({ model: "claude-opus-5-5", settings: { effortLevel: "xhigh", fastMode: false } });
  replacement.push(result(two.uuid)); await next;
});

it("fences a delayed model update after a newer snapshot and query replacement", async () => {
  const { driver, queries } = setup(); await driver.open({ ...input, effort: "low" });
  const first = driver.prompt(text("one")), query = queries[0], one = await query.read();
  const pending = createDeferred<void>();
  vi.spyOn(query, "setModel").mockImplementation(() => pending.promise);
  const oldUpdate = driver.updateConfig({ model: "claude-opus-5-5", effort: "high", fast: true });
  await driver.updateConfig({ effort: "max", fast: false });
  query.push(result(one.uuid)); await first;
  const next = driver.prompt(text("two")), replacement = queries[1], two = await replacement.read();
  pending.resolve(); await oldUpdate;
  expect(query.flagSettings).toEqual([]); expect(replacement.flagSettings).toEqual([]);
  expect(replacement.args.options).toMatchObject({ model: "claude-opus-5-5", effort: "max", settings: { fastMode: false } });
  replacement.push(result(two.uuid)); await next;
});

it("keeps a newer full config when an earlier model-only control acknowledges late", async () => {
  const { driver, queries } = setup(); await driver.open({ ...input, effort: "low" });
  const first = driver.prompt(text("one")), query = queries[0], one = await query.read();
  const pending = createDeferred<void>();
  vi.spyOn(query, "setModel").mockImplementationOnce(() => pending.promise);
  const oldSelection = driver.setModel("claude-opus-5-5");
  await driver.updateConfig({ model: "claude-opus-5-5", effort: "ultracode", fast: true });
  pending.resolve(); await oldSelection;
  expect(query.flagSettings).toEqual([{ effortLevel: "xhigh", fastMode: true, ultracode: true }]);
  query.push(result(one.uuid)); await first;
  query.end(); await tick();
  const next = driver.prompt(text("two")), replacement = queries[1], two = await replacement.read();
  expect(replacement.args.options).toMatchObject({ model: "claude-opus-5-5", settings: { effortLevel: "xhigh", fastMode: true, ultracode: true } });
  replacement.push(result(two.uuid)); await next;
});
