import assert from "node:assert/strict";

const roots = new Set(["Browser", "GPU", "local-engine"]);
const identity = rows => rows.map(row => `${row.role}:${row.pid}`).sort().join(",");
const counters = rows => rows.map(({ pid, role, cpuSeconds }) => ({ pid, role, cpuSeconds }));

function cpuDelta(before, after, seconds) {
  assert(seconds >= 60, "Idle observation is too short.");
  assert.deepEqual(after.map(p => p.pid).sort(), before.map(p => p.pid).sort(), "Process ownership changed during idle observation.");
  return after.map(row => {
    const old = before.find(p => p.pid === row.pid);
    assert(Number.isFinite(row.cpuSeconds) && Number.isFinite(old.cpuSeconds) && row.cpuSeconds >= old.cpuSeconds, "Missing CPU counter.");
    return { pid: row.pid, role: row.role, percent: (row.cpuSeconds - old.cpuSeconds) / seconds * 100 };
  });
}

/** A retired guest has no final cumulative CPU reading. Preserve that invalid
 * window and allow one complete replacement, never an invented zero or retry
 * of a high valid result. Continuous guard samples catch a transient child
 * whose start and exit both fall between the endpoints. */
export async function measureNativeIdleCpu({ sample, pause, now = () => performance.now(),
  sampleHistory = () => [], onObservation }) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const before = await sample(), firstObserved = sampleHistory().length, start = now();
    assert([...roots].every(role => before.some(row => row.role === role)), "Missing idle root process.");
    await pause(60500);
    const after = await sample(), seconds = (now() - start) / 1000;
    const observed = sampleHistory().slice(firstObserved);
    for (const rows of [...observed, after]) {
      assert.equal(identity(rows.filter(row => roots.has(row.role))), identity(before.filter(row => roots.has(row.role))),
        "An idle root process changed.");
      for (const row of rows) {
        const old = before.find(previous => previous.pid === row.pid);
        assert(Number.isFinite(row.cpuSeconds) && row.cpuSeconds >= 0 &&
          (!old || (Number.isFinite(old.cpuSeconds) && row.cpuSeconds >= old.cpuSeconds)), "Missing or reset CPU counter.");
      }
    }
    if ([...observed, after].some(rows => identity(rows) !== identity(before))) {
      await onObservation({ attempt, valid: false, reason: "process-ownership-changed", seconds,
        before: counters(before), after: counters(after),
        observedProcessSets: [...new Set(observed.map(identity))] });
      continue;
    }
    const cpu = cpuDelta(before, after, seconds);
    const observation = { attempt, valid: true, seconds, cpu, percent: cpu.reduce((sum, row) => sum + row.percent, 0) };
    await onObservation(observation);
    return observation;
  }
  throw new Error("No stable idle process window after two observations.");
}
