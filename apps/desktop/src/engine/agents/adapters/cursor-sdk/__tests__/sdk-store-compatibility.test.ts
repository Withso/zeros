import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, JsonlLocalAgentStore } from "@cursor/sdk";
import { afterEach, beforeEach, expect, it } from "vitest";
import { cursorTokenUsage } from "../usage-accounting";

let cwd: string;
let store: JsonlLocalAgentStore;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "cursor-sdk-store-"));
  store = new JsonlLocalAgentStore(join(cwd, "store"));
  await store.agents.create({
    agent: {
      agentId: "fixture-agent",
      cwd,
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    },
  });
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

it.each([110, 165])(
  "reads stored usage with total %s without changing canonical counts or the saved row",
  async (totalTokens) => {
    const usage = {
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 50,
      cacheWriteTokens: 5,
      totalTokens,
    };
    await store.runs.create({
      run: {
        agentId: "fixture-agent",
        runId: "run-fixture",
        turnNumber: 1,
        status: "finished",
        usage,
        createdAt: 1,
        updatedAt: 2,
      },
    });
    const run = await Agent.getRun("run-fixture", {
      runtime: "local",
      cwd,
      store,
    });
    expect((await run.wait()).usage).toEqual({ ...usage, totalTokens: 110 });
    expect(cursorTokenUsage(run.usage)).toEqual({
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 50,
      cacheWriteTokens: 5,
    });
    expect(
      (await store.runs.get({ agentId: "fixture-agent", runId: "run-fixture" }))
        ?.usage,
    ).toEqual(usage);
    // No checkpoint is still a normal empty conversation after the declaration
    // stopped spelling out `unknown | null`. This uses the public SDK path.
    expect(await run.conversation()).toEqual([]);
  },
);

it.each([
  [
    "[resource_exhausted] Request rejected.",
    { code: "resource_exhausted", message: "Request rejected." },
  ],
  ["Legacy error text.", { message: "Legacy error text." }],
] as const)(
  "retains the installed SDK's stored error contract: %s",
  async (error, expected) => {
    await store.runs.create({
      run: {
        agentId: "fixture-agent",
        runId: "run-fixture",
        turnNumber: 1,
        status: "error",
        error,
        createdAt: 1,
        updatedAt: 2,
      },
    });
    const run = await Agent.getRun("run-fixture", {
      runtime: "local",
      cwd,
      store,
    });
    expect((await run.wait()).error).toEqual(expected);
  },
);
