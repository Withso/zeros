/** Pure fail-closed gates shared by the paid/provider qualification commands.
 * Keeping verdict logic here makes it unit-testable without creating or
 * deleting a real sandbox. */

export function assertCommandExitCode(
  label: string,
  exitCode: unknown,
): asserts exitCode is 0 {
  if (exitCode !== 0) {
    throw new Error(`${label} failed (exit ${String(exitCode)})`);
  }
}

export function requireHttpRoundTrip(
  label: string,
  status: unknown,
): asserts status is 200 {
  if (status !== 200) {
    throw new Error(`${label} failed (HTTP ${String(status)})`);
  }
}

export interface SoakOptions {
  readonly hours: number;
  readonly pingMs: number;
  readonly maxDrops: number;
}

function finiteNumber(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
  const value = raw === undefined || raw.trim() === "" ? fallback : Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} soak value is invalid`);
  return value;
}

export function parseSoakOptions(
  env: Record<string, string | undefined>,
): SoakOptions {
  const hours = finiteNumber(env.ZEROS_SOAK_HOURS, 4, "duration");
  const pingMs = finiteNumber(env.ZEROS_SOAK_PING_MS, 25_000, "cadence");
  const maxDrops = finiteNumber(env.ZEROS_SOAK_MAX_DROPS, 0, "drop budget");
  if (hours < 1 / 60 || hours > 24) {
    throw new Error(
      "duration soak value must be from 1 minute through 24 hours",
    );
  }
  if (!Number.isInteger(pingMs) || pingMs < 1_000 || pingMs > 60_000) {
    throw new Error(
      "cadence soak value must be an integer from 1000 through 60000",
    );
  }
  if (!Number.isInteger(maxDrops) || maxDrops < 0 || maxDrops > 100) {
    throw new Error(
      "drop budget soak value must be an integer from 0 through 100",
    );
  }
  return { hours, pingMs, maxDrops };
}

export interface SoakGateInput {
  readonly drops: number;
  readonly maxDrops: number;
  readonly connected: boolean;
  readonly completed: boolean;
}

export interface SoakGateVerdict {
  readonly ok: boolean;
  readonly reason: string;
}

export function evaluateSoakGate(input: SoakGateInput): SoakGateVerdict {
  if (
    !Number.isSafeInteger(input.drops) ||
    input.drops < 0 ||
    !Number.isSafeInteger(input.maxDrops) ||
    input.maxDrops < 0 ||
    input.maxDrops > 100 ||
    typeof input.connected !== "boolean" ||
    typeof input.completed !== "boolean"
  ) {
    return { ok: false, reason: "invalid soak metrics" };
  }
  if (!input.completed) return { ok: false, reason: "stopped before deadline" };
  if (!input.connected) {
    return { ok: false, reason: "no live bridge at the deadline" };
  }
  if (input.drops > input.maxDrops) {
    return {
      ok: false,
      reason: `${input.drops} drop(s) exceeded the ${input.maxDrops}-drop budget`,
    };
  }
  return {
    ok: true,
    reason: input.drops === 0 ? "stable" : "within drop budget",
  };
}

export function parseRequiredCloudAgents(raw: string | undefined): string[] {
  if (!raw?.trim()) {
    throw new Error(
      "required agents are missing (set ZEROS_CLOUD_REQUIRED_AGENTS for the paid live check)",
    );
  }
  const agents = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (agents.length < 1 || agents.length > 16) {
    throw new Error("required agents must contain from 1 through 16 agent ids");
  }
  for (const agent of agents) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(agent)) {
      throw new Error(`required agent id is invalid: ${agent}`);
    }
  }
  if (new Set(agents).size !== agents.length) {
    throw new Error("required agents contain a duplicate agent id");
  }
  return agents;
}

export function assertFullCloudBoundary(agentId: string, raw: unknown): void {
  const boundary =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null;
  const design =
    boundary?.designProtection &&
    typeof boundary.designProtection === "object" &&
    !Array.isArray(boundary.designProtection)
      ? (boundary.designProtection as Record<string, unknown>)
      : null;
  const parity =
    boundary?.parity &&
    typeof boundary.parity === "object" &&
    !Array.isArray(boundary.parity)
      ? (boundary.parity as Record<string, unknown>)
      : null;
  if (
    boundary?.version !== 1 ||
    boundary.actor !== "agent-code" ||
    boundary.state !== "ready" ||
    boundary.backend !== "cloud-worker" ||
    design?.required !== true ||
    design.enforced !== true ||
    !Number.isInteger(design.protectedDirectoryCount) ||
    Number(design.protectedDirectoryCount) < 1 ||
    parity?.level !== "full" ||
    !Array.isArray(parity.restrictions) ||
    parity.restrictions.length !== 0
  ) {
    throw new Error(
      `${agentId} did not receive a full, Design-enforced cloud-worker boundary`,
    );
  }
}

export function assertLiveAgentChallengeResponse(
  agentId: string,
  responseText: string,
  marker: string,
): void {
  if (!/^[A-Z0-9_]{16,128}$/.test(marker) || !responseText.includes(marker)) {
    throw new Error(`${agentId} live response omitted its unique marker`);
  }
}

export function validateEphemeralSnapshotName(name: string): void {
  if (!/^zeros-zsr-ci-[1-9][0-9]{0,19}-[1-9][0-9]{0,9}$/.test(name)) {
    throw new Error(
      "automated snapshot deletion requires a run-scoped zeros-zsr-ci-<run>-<attempt> name",
    );
  }
}

export function parseValidationAutoDeleteMinutes(
  raw: string | undefined,
): number {
  if (raw === undefined || raw.trim() === "") return -1;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 60 || value > 7 * 24 * 60) {
    throw new Error(
      "cloud validation auto-delete must be an integer from 60 through 10080 minutes",
    );
  }
  return value;
}

export function shouldDeleteStaleEphemeralSnapshot(
  snapshot: { name?: unknown; createdAt?: unknown },
  nowMs: number,
  minimumAgeMs: number,
): boolean {
  if (
    typeof snapshot.name !== "string" ||
    !/^zeros-zsr-ci-[1-9][0-9]{0,19}-[1-9][0-9]{0,9}$/.test(snapshot.name) ||
    !Number.isFinite(nowMs) ||
    !Number.isFinite(minimumAgeMs) ||
    minimumAgeMs <= 0
  ) {
    return false;
  }
  const createdAt =
    snapshot.createdAt instanceof Date
      ? snapshot.createdAt.getTime()
      : typeof snapshot.createdAt === "string"
        ? Date.parse(snapshot.createdAt)
        : Number.NaN;
  return (
    Number.isFinite(createdAt) &&
    createdAt <= nowMs &&
    nowMs - createdAt > minimumAgeMs
  );
}

export function resolveRemoteSourceCommit(
  lsRemoteOutput: string,
  expectedCommit?: string,
): string {
  const commits = new Set(
    lsRemoteOutput
      .split("\n")
      .map((line) => /^([a-f0-9]{40,64})\s/.exec(line)?.[1])
      .filter((value): value is string => Boolean(value)),
  );
  if (commits.size !== 1) {
    throw new Error("repository ref does not resolve to one immutable commit");
  }
  const resolved = [...commits][0];
  if (
    expectedCommit !== undefined &&
    (!/^[a-f0-9]{40,64}$/.test(expectedCommit) || resolved !== expectedCommit)
  ) {
    throw new Error("repository ref no longer resolves to the exact commit");
  }
  return resolved;
}
