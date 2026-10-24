import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionNotification } from "../../packages/protocol/src/agent-events";

interface Translator {
  feed(event: unknown): unknown;
  beginProcess(): void;
  setScheduledWakeups(crons: { id: string; schedule: string; recurring: boolean; prompt: string }[]): void;
  announceWakeup(input: { source: "loop_wakeup" | "schedule_wakeup"; prompt?: string; promptId?: string }): void;
}

/** Same native frames exercise both independently shipped translators. */
export function claudeWakeupContract(factory: (emit: (event: SessionNotification) => void) => Translator) {
  describe("Claude scheduled wake-up facts", () => {
    afterEach(() => vi.restoreAllMocks());
    const now = new Date(2026, 7, 4, 10, 0).getTime();
    const estimated = new Date(2026, 7, 5, 12, 0).getTime();
    const due = estimated + 17_000;
    function setup() {
      vi.spyOn(Date, "now").mockReturnValue(now);
      const events: SessionNotification[] = [];
      const t = factory(event => events.push(event));
      let sequence = 0;
      const tool = (name: string, input: unknown, output: unknown, options: { error?: boolean; child?: boolean; batch?: boolean } = {}) => {
        const id = `tool-${++sequence}`;
        const parent = options.child ? { parent_tool_use_id: "child-owner" } : {};
        const invocation = { type: "assistant", uuid: `frame-${id}`, ...parent, message: { id: `message-${id}`, role: "assistant", content: [{ type: "tool_use", id, name, input }] } };
        const result = { type: "user", uuid: `result-${id}`, ...parent, tool_use_result: output, message: { role: "user", content: [
          { type: "tool_result", tool_use_id: id, content: "Scheduled", is_error: options.error },
          ...(options.batch ? [{ type: "tool_result", tool_use_id: "other", content: "Unrelated" }] : []),
        ] } };
        t.feed(invocation); t.feed(result);
        return () => { t.feed(invocation); t.feed(result); };
      };
      const wake = (source: "loop_wakeup" | "schedule_wakeup", prompt?: string, promptId = "wake-1") => t.announceWakeup({ source, prompt, promptId });
      const notices = () => events.map(event => event.update).filter(event => event.sessionUpdate === "wakeup_notice");
      const tasks = () => events.map(event => event.update).filter(event => event.sessionUpdate === "background_tasks_update").at(-1)?.tasks;
      const snapshot = (prompt = "Check the deployment") => t.setScheduledWakeups([{ id: "job", schedule: "0 12 5 8 *", recurring: false, prompt }]);
      return { t, events, tool, wake, notices, tasks, snapshot };
    }

    it("announces a dynamic wake with its own reason and exact ScheduleWakeup time", () => {
      const f = setup();
      f.tool("ScheduleWakeup", { prompt: "<<autonomous-loop-dynamic>>", reason: "The deployment is still provisioning" }, { scheduledFor: due });
      f.wake("loop_wakeup", "<<autonomous-loop-dynamic>>");
      expect(f.notices()).toEqual([expect.objectContaining({ source: "loop_wakeup", reason: "The deployment is still provisioning", scheduledFor: due })]);
      expect(f.events.filter(event => event.update.sessionUpdate === "background_tasks_update")).toEqual([]);
    });

    it("keeps ScheduleWakeup's exact due time across repeated Stop snapshots", () => {
      const f = setup();
      f.tool("ScheduleWakeup", { prompt: "Check the deployment", reason: "Still provisioning" }, { scheduledFor: due });
      f.snapshot();
      expect(f.tasks()?.[0].scheduledFor).toBe(due);
      f.snapshot();
      expect(f.tasks()?.[0].scheduledFor).toBe(due);
    });

    it("uses CronCreate nextFireAt ahead of the cron estimate", () => {
      const f = setup();
      f.tool("CronCreate", { cron: "0 12 5 8 *", prompt: "Check the deployment", recurring: false }, { id: "job", recurring: false, nextFireAt: due });
      f.snapshot();
      expect(f.tasks()).toEqual([expect.objectContaining({ scheduledFor: due })]);
      f.wake("schedule_wakeup", "Check the deployment");
      expect(f.notices()).toEqual([expect.objectContaining({ source: "schedule_wakeup", reason: "Check the deployment", scheduledFor: due })]);
    });

    it("refreshes an unchanged job with CronList's authoritative due time", () => {
      const f = setup(); f.snapshot();
      expect(f.tasks()?.[0].scheduledFor).toBe(estimated);
      f.tool("CronList", {}, { jobs: [{ id: "job", cron: "0 12 5 8 *", prompt: "Check the deployment", recurring: false, nextFireAt: due }] });
      f.snapshot();
      expect(f.tasks()?.[0].scheduledFor).toBe(due);
      f.wake("schedule_wakeup", "Check the deployment");
      expect(f.notices()[0]).toMatchObject({ scheduledFor: due });
    });

    it("uses the created job's actual recurring mode when estimating absent native due time", () => {
      const f = setup();
      f.tool("CronCreate", { cron: "0 12 5 8 *", prompt: "Check the deployment" }, { id: "job", recurring: false });
      f.wake("schedule_wakeup", "Check the deployment");
      expect(f.notices()[0]).toMatchObject({ scheduledFor: estimated });
    });

    it("does not lend a loop's reason or due time to an unrelated single Stop job", () => {
      const f = setup();
      f.tool("ScheduleWakeup", { prompt: "Loop prompt", reason: "Waiting for the loop" }, { scheduledFor: due });
      f.snapshot("Other job");
      f.wake("schedule_wakeup", "Other job");
      expect(f.notices()[0]).toMatchObject({ reason: "Other job", scheduledFor: estimated });
    });

    it.each([undefined, NaN, Infinity, -1, "tomorrow"])("falls back to the one-shot estimate for invalid or absent due time %s", nextFireAt => {
      const f = setup();
      f.tool("CronCreate", { cron: "0 12 5 8 *", prompt: "Check the deployment", recurring: false }, { id: "job", recurring: false, nextFireAt });
      f.snapshot();
      expect(f.tasks()?.[0].scheduledFor).toBe(estimated);
      f.wake("schedule_wakeup", "Check the deployment");
      expect(f.notices()[0]).toMatchObject({ scheduledFor: estimated });
    });

    it("matches the fired prompt instead of the most recently created job", () => {
      const f = setup();
      for (const [id, prompt, nextFireAt] of [["one", "First job", due], ["two", "Second job", due + 60_000]] as const)
        f.tool("CronCreate", { cron: "* * * * *", prompt }, { id, recurring: true, nextFireAt });
      f.wake("schedule_wakeup", "First job");
      expect(f.notices()[0]).toMatchObject({ reason: "First job", scheduledFor: due });
    });

    it.each(["same prompt", undefined, "unmatched"])("does not guess a job for ambiguous or absent prompt %s", prompt => {
      const f = setup();
      for (const id of ["one", "two"])
        f.tool("CronCreate", { cron: "* * * * *", prompt: "same prompt" }, { id, recurring: true, nextFireAt: due });
      f.wake("schedule_wakeup", prompt);
      expect(f.notices()).toHaveLength(1);
      expect(f.notices()[0]).not.toHaveProperty("reason");
      expect(f.notices()[0]).not.toHaveProperty("scheduledFor");
    });

    it("lets a newer ScheduleWakeup supersede the pending dynamic wake", () => {
      const f = setup();
      // The CLI keeps one pending dynamic wake; rescheduling replaces it.
      f.tool("ScheduleWakeup", { prompt: "Check CI", reason: "First estimate" }, { scheduledFor: due });
      f.tool("ScheduleWakeup", { prompt: "Check CI", reason: "Builds are slow today" }, { scheduledFor: due + 600_000 });
      f.wake("loop_wakeup", "Check CI");
      expect(f.notices()[0]).toMatchObject({ reason: "Builds are slow today", scheduledFor: due + 600_000 });
      f.tool("ScheduleWakeup", { prompt: "Check CI", reason: "Still running" }, { scheduledFor: due + 1_200_000 });
      f.wake("loop_wakeup", "Check CI", "wake-2");
      expect(f.notices()[1]).toMatchObject({ reason: "Still running", scheduledFor: due + 1_200_000 });
    });

    it("keeps an unknown loop reason generic instead of exposing its prompt sentinel", () => {
      const f = setup();
      f.tool("ScheduleWakeup", { prompt: "<<autonomous-loop-dynamic>>" }, { scheduledFor: due });
      f.wake("loop_wakeup", "<<autonomous-loop-dynamic>>");
      expect(f.notices()).toHaveLength(1);
      expect(f.notices()[0]).not.toHaveProperty("reason");
    });

    it.each([{ error: true }, { child: true }, { batch: true }])("ignores failed, child and unowned batched results: %j", options => {
      const f = setup();
      f.tool("CronCreate", { cron: "* * * * *", prompt: "Wrong job" }, { id: "job", recurring: true, nextFireAt: due }, options);
      f.wake("schedule_wakeup", "Wrong job");
      expect(f.notices()).toHaveLength(1);
      expect(f.notices()[0]).not.toHaveProperty("reason");
      expect(f.notices()[0]).not.toHaveProperty("scheduledFor");
    });

    it("deduplicates the native prompt ID through replay and query resume", () => {
      const f = setup();
      const replay = f.tool("ScheduleWakeup", { prompt: "Check", reason: "Still waiting" }, { scheduledFor: due });
      f.wake("loop_wakeup", "Check"); replay(); f.wake("loop_wakeup", "Check");
      f.t.beginProcess(); f.wake("loop_wakeup", "Check");
      expect(f.notices()).toHaveLength(1);
      f.wake("loop_wakeup", "Check", "wake-2");
      expect(f.notices()).toHaveLength(2);
      expect(f.notices()[1]).not.toHaveProperty("scheduledFor");
    });

    it("does not reuse a recurring job's previous due time for its next firing", () => {
      const f = setup();
      f.tool("CronCreate", { cron: "* * * * *", prompt: "Check" }, { id: "job", recurring: true, nextFireAt: due });
      f.wake("schedule_wakeup", "Check"); f.wake("schedule_wakeup", "Check", "wake-2");
      expect(f.notices()).toHaveLength(2);
      expect(f.notices()[1]).not.toHaveProperty("scheduledFor");
    });

    it("forgets deleted jobs and stopped dynamic loops", () => {
      const f = setup();
      f.tool("CronCreate", { cron: "* * * * *", prompt: "Cron" }, { id: "job", recurring: true, nextFireAt: due });
      f.tool("CronDelete", { id: "job" }, { id: "job" });
      f.tool("ScheduleWakeup", { prompt: "Loop", reason: "Waiting" }, { scheduledFor: due });
      f.tool("ScheduleWakeup", { stop: true }, { stopped: true, scheduledFor: 0 });
      f.wake("schedule_wakeup", "Cron"); f.wake("loop_wakeup", "Loop", "wake-2");
      expect(f.notices()).toHaveLength(2);
      for (const notice of f.notices()) expect(notice).not.toHaveProperty("scheduledFor");
    });
  });
}
