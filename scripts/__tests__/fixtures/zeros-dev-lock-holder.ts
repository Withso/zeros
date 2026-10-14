import { RunStore } from "../../zeros-dev/receipts";

// Separate OS process: the regression must kill a real lock owner, not mock
// process.kill or turn a clock forward. Only synthetic values arrive by IPC.
process.once("message", async (input: Parameters<typeof JSON.parse>[0]) => {
  try {
    const { directory, fixture, device, runId, source, intent } = JSON.parse(input);
    const store = new RunStore(directory, fixture, device);
    await store.withRun(runId, source, async handle => {
      handle.run.lifecycle.push({ operation: "wake", key: intent, generation: 1, confirmed: false });
      await handle.save();
      process.send?.({ event: "held" });
      await new Promise<void>(resolve => process.once("message", () => resolve()));
    });
    process.send?.({ event: "released" });
  } catch { process.send?.({ event: "failed" }); process.exitCode = 1; }
  finally { process.disconnect?.(); }
});
