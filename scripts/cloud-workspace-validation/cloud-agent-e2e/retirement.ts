import { HarnessFailure } from "./assertions";
export type NamespaceOutcome = { code: number | null; signal: NodeJS.Signals | null };
export type RetirementEvidence = { proof?: { engineScopeEmpty: boolean; cgroupRemoved: boolean; namespacePrivate: boolean;
  scopeKind?: "strict" | "cpu-private-pid-fixture"; pidNamespaceProcessesEmpty?: boolean; ownCpuCgroupRemoved?: boolean }; failure?: boolean };
export function assertRetirement(outcome: NamespaceOutcome, evidence: RetirementEvidence): void {
  if (outcome.code !== 0 || outcome.signal !== null || evidence.failure || !evidence.proof?.engineScopeEmpty ||
    !evidence.proof.namespacePrivate || (evidence.proof.scopeKind === "cpu-private-pid-fixture"
      ? evidence.proof.cgroupRemoved || !evidence.proof.pidNamespaceProcessesEmpty || !evidence.proof.ownCpuCgroupRemoved
      : !evidence.proof.cgroupRemoved)) throw new HarnessFailure("cleanup_unconfirmed");
}
/** completion must be the child close event (all stdio drained), never exit. */
export async function awaitRetirement(completion: Promise<NamespaceOutcome>, evidence: () => RetirementEvidence) {
  const outcome = await completion;
  assertRetirement(outcome, evidence());
  return outcome;
}
/** Retirement is independent of the provider case outcome. No child is pending. */
export function summarizeRetirement(outcome: NamespaceOutcome | undefined, evidence: RetirementEvidence): {
  status: "pending" | "passed" | "failed"; pidNamespaceRetired: boolean;
} {
  if (!outcome) return { status: "pending", pidNamespaceRetired: false };
  try { assertRetirement(outcome, evidence); }
  catch { return { status: "failed", pidNamespaceRetired: false }; }
  return { status: "passed", pidNamespaceRetired: evidence.proof?.pidNamespaceProcessesEmpty === true };
}
