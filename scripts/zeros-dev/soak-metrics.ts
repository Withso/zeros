import type { Run } from "./receipts";
import type { AdmissionObservation } from "./admission-observation";
import type { TransportObservation } from "./gate0-contract";
import type { EvidenceEvent } from "./evidence";

const counters = ["directAttempts", "directReady", "relayAttempts", "relayReady", "lostConnections", "authorityCloses", "unexplainedAuthorityCloses"] as const;
export type SoakEvidence = { run: Run; result: { admission?: AdmissionObservation; transport?: TransportObservation }; startedAt: string; completedAt: string };

/** Receipts repeat cumulative snapshots at failure/success/disconnect. Sum
 * distinct connections and admission calls, never the number of log lines. */
export function summarizeSoakEvidence(samples: SoakEvidence[], incomplete = false) {
  const connections = new Map<string, TransportObservation>(), admissions = new Map<string, AdmissionObservation>();
  const phases: Partial<Record<EvidenceEvent["phase"], number[]>> = {}, windows: Array<{ runId: string; startedAt: string; completedAt: string; durationMs: number }> = [];
  let transportComplete = !incomplete && samples.length > 0, admissionComplete = transportComplete, activeComplete = transportComplete;
  for (const { run, result, startedAt, completedAt } of samples) {
    let observedTransport = false;
    const transport = (row: TransportObservation | undefined) => {
      if (!row) return;
      observedTransport = true;
      const id = `${run.runId}/${row.connectionId}`, previous = connections.get(id);
      if (row.coverage !== "complete" || previous && counters.some(key => row[key] < previous[key])) transportComplete = false;
      connections.set(id, previous ? { ...row, ...Object.fromEntries(counters.map(key => [key, Math.max(row[key], previous[key])])) } : row);
    };
    const admission = (row: AdmissionObservation | undefined) => {
      if (!row) return;
      if (!row.connectionId) { admissionComplete = false; return; }
      const id = `${run.runId}/${row.connectionId}/${row.sequence}`, previous = admissions.get(id);
      if (previous && JSON.stringify(previous.firstFailure) !== JSON.stringify(row.firstFailure)) admissionComplete = false;
      if (!previous || previous.retryCount <= row.retryCount) admissions.set(id, row);
    };
    for (const row of run.evidence) {
      (phases[row.phase] ??= []).push(row.durationMs); transport(row.transport); admission(row.admission);
    }
    for (const row of run.hourly?.rehearsal?.transports ?? []) transport(row);
    transport(result.transport); admission(result.admission);
    if (!observedTransport) transportComplete = false;
    for (const window of run.hourly?.activeWindows ?? []) {
      const start = Date.parse(window.readyObservedAt), end = Date.parse(window.workCompletedAt);
      if (start < Date.parse(startedAt) - 60_000 || end > Date.parse(completedAt) + 60_000 || end < start ||
        Math.abs(end - start - window.durationMs) > 2000) { activeComplete = false; continue; }
      windows.push({ runId: run.runId, startedAt: window.readyObservedAt, completedAt: window.workCompletedAt, durationMs: window.durationMs });
    }
    if (!run.hourly?.activeWindows.length) activeComplete = false;
  }
  const totals = Object.fromEntries(counters.map(key => [key, [...connections.values()].reduce((sum, row) => sum + row[key], 0)])) as Record<typeof counters[number], number>;
  const quantile = (values: number[], p: number) => values[Math.max(0, Math.ceil(values.length * p) - 1)]!;
  const times = Object.fromEntries(Object.entries(phases).map(([phase, values]) => {
    values.sort((a, b) => a - b);
    return [phase, { samples: values.length, minMs: values[0], maxMs: values.at(-1), p50Ms: quantile(values, 0.5), p95Ms: quantile(values, 0.95), p99Ms: quantile(values, 0.99) }];
  }));
  return {
    transport: { coverage: transportComplete ? "complete" : "unavailable", observedConnections: connections.size, ...totals,
      directSuccessRate: transportComplete && totals.directAttempts > 0 ? totals.directReady / totals.directAttempts : null,
      relaySuccessRate: transportComplete && totals.relayAttempts > 0 ? totals.relayReady / totals.relayAttempts : null },
    admission: { coverage: admissionComplete && transportComplete ? "complete" : "unavailable", failedCalls: admissions.size,
      retries: [...admissions.values()].reduce((sum, row) => sum + row.retryCount, 0),
      failures: [...admissions.values()].map(row => ({ connectionId: row.connectionId!, sequence: row.sequence, firstFailure: row.firstFailure, retries: row.retries })) },
    active: { coverage: activeComplete ? "complete" : "unavailable", durationMs: windows.reduce((sum, row) => sum + row.durationMs, 0), windows },
    phases: times,
  };
}
