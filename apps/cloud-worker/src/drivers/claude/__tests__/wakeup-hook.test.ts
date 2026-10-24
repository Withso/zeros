import { afterEach, expect, it } from "vitest";
import type { SessionNotification } from "@zeros/protocol/agent-events";
import { ClaudeDriver } from "../driver";
import { harness, input, nativeId, result, text, tick } from "./fake-query";

const drivers: ClaudeDriver[] = [];
afterEach(async () => { for (const driver of drivers.splice(0)) await driver.dispose(); });

it.each(["loop_wakeup", "schedule_wakeup"] as const)("emits a root %s notice before work without changing background membership", async source => {
  const f = harness(), events: SessionNotification[] = [];
  const driver = new ClaudeDriver({ query: f.query, environment: {}, executable: "/fixture/claude" });
  drivers.push(driver); driver.onEvent(event => events.push(event)); await driver.open(input);
  const initial = driver.prompt(text("Watch deployment")), query = f.queries[0], message = await query.read();
  const loop = source === "loop_wakeup", due = 1_800_000_017_000;
  query.push({ type: "system", subtype: "init", session_id: nativeId });
  query.push({ type: "assistant", uuid: "tool-frame", message: { id: "tool-message", role: "assistant", content: [{
    type: "tool_use", id: "tool", name: loop ? "ScheduleWakeup" : "CronCreate",
    input: loop ? { prompt: "Check deployment", reason: "Deployment still provisioning" } : { cron: "* * * * *", prompt: "Check deployment" },
  }] } });
  query.push({ type: "user", tool_use_result: loop ? { scheduledFor: due } : { id: "job", recurring: true, nextFireAt: due },
    message: { content: [{ type: "tool_result", tool_use_id: "tool", content: "Scheduled" }] } });
  query.push(result(message.uuid, { uuid: "initial-result" })); await initial; await tick();
  const hook = query.args.options.hooks?.UserPromptSubmit?.[0].hooks[0];
  expect(hook).toBeTypeOf("function");
  expect(query.args.options.hooks?.Stop).toBeUndefined();
  const before = events.length;
  const wake = { hook_event_name: "UserPromptSubmit" as const, session_id: nativeId, transcript_path: "/fixture/transcript", cwd: input.cwd, prompt: "Check deployment", source, prompt_id: "native-wake" };
  const callbackOptions = { signal: new AbortController().signal };
  await hook?.({ ...wake, agent_id: "child" }, undefined, callbackOptions);
  expect(events).toHaveLength(before);
  await hook?.(wake, undefined, callbackOptions); await hook?.(wake, undefined, callbackOptions);
  const notices = events.slice(before);
  expect(notices).toEqual([expect.objectContaining({ update: expect.objectContaining({ sessionUpdate: "wakeup_notice", source, reason: loop ? "Deployment still provisioning" : "Check deployment", scheduledFor: due }) })]);
  query.push({ type: "assistant", message: { id: "continuation", content: [{ type: "text", text: "Checking again." }] } });
  await tick();
  expect(events.indexOf(notices[0])).toBeLessThan(events.findIndex(event => event.update.sessionUpdate === "agent_message_chunk" && event.update.content.type === "text" && event.update.content.text === "Checking again."));
  await driver.interrupt();
  const afterStop = events.length;
  await hook?.({ ...wake, prompt_id: "retired-wake" }, undefined, callbackOptions);
  expect(events).toHaveLength(afterStop);
  const next = driver.prompt(text("New request")), replacement = f.queries[1], nextMessage = await replacement.read();
  replacement.push(result(nextMessage.uuid, { uuid: "next-result" })); await next;
  const afterReplacement = events.length;
  await hook?.({ ...wake, prompt_id: "old-query-wake" }, undefined, callbackOptions);
  expect(events).toHaveLength(afterReplacement);
});
