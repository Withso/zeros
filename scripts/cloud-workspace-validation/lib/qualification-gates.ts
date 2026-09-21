/** Pure fail-closed gates shared by the paid/provider qualification commands.
 * Keeping verdict logic here makes it unit-testable without creating or
 * deleting a real sandbox. */
import {CLOUD_CORE_EXECUTION_PROFILE,CLOUD_CORE_PROVIDER_RESTRICTIONS,type CloudCoreProvider} from "../../../packages/protocol/src/containment";

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

export type CloudAgentSelection = {
  agentId: string;
  model: string;
  env: Record<string, string>;
  agentCredentialGrantId?: string;
};

/** A successful response on a substituted model is not a successful paid
 * qualification. Claude may resolve an undated model ID to its dated version. */
export function assertCloudAgentModel(
  selection: CloudAgentSelection,
  response: Record<string, unknown> | null,
): void {
  const matches = (model: unknown) =>
    typeof model === "string" &&
    (model === selection.model ||
      (selection.agentId === "claude" &&
        model.startsWith(`${selection.model}-`) &&
        /^\d{8}$/.test(model.slice(selection.model.length + 1))));
  if (!matches(response?.effectiveModel))
    throw new Error(`${selection.agentId} did not confirm the selected model`);
  const usage = response?.usage;
  if (usage && typeof usage === "object" && !Array.isArray(usage)) {
    const perModel = (usage as Record<string, unknown>).perModel;
    if (
      perModel !== undefined &&
      (!Array.isArray(perModel) ||
        perModel.some(
          (entry) =>
            !entry || typeof entry !== "object" || !matches(entry.model),
        ))
    ) {
      throw new Error(
        `${selection.agentId} reported usage outside the selected model`,
      );
    }
  }
}

/** No account/model defaults in paid qualification. This data contains only
 * public selection controls; credentials remain in the trusted projection. */
export function parseCloudAgentSelections(
  agents: readonly string[],
  raw: string | undefined,
): CloudAgentSelection[] {
  const invalid = () =>
    new Error(
      "Cloud agent selection is invalid or missing (ZEROS_CLOUD_AGENT_SELECTIONS)",
    );
  if (!raw || raw.length > 4096 || agents.length < 1) throw invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalid();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw invalid();
  const plans = parsed as Record<string, unknown>;
  const variables: Readonly<Record<string, string>> = {
    claude: "ANTHROPIC_MODEL",
    codex: "OPENAI_MODEL",
    cursor: "CURSOR_MODEL",
  };
  if (Object.keys(plans).some((key) => !agents.includes(key))) throw invalid();
  return agents.map((agentId) => {
    const plan = plans[agentId];
    if (
      !Object.hasOwn(variables, agentId) ||
      !plan ||
      typeof plan !== "object" ||
      Array.isArray(plan)
    )
      throw invalid();
    const value = plan as Record<string, unknown>;
    if (
      Object.keys(value).some(
        (key) =>
          !["model", "effort", "fast", "agentCredentialGrantId"].includes(key),
      ) ||
      typeof value.model !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._/[\]-]{0,255}$/.test(value.model) ||
      /^(auto|default)$/i.test(value.model) ||
      (value.fast !== undefined && typeof value.fast !== "boolean") ||
      (value.agentCredentialGrantId !== undefined &&
        (typeof value.agentCredentialGrantId !== "string" ||
          !/^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/iu.test(
            value.agentCredentialGrantId,
          )))
    )
      throw invalid();
    if (
      (agentId !== "claude" && value.effort === undefined) ||
      (value.effort !== undefined &&
        (typeof value.effort !== "string" ||
          ![
            "minimal",
            "low",
            "medium",
            "high",
            "xhigh",
            "max",
            "ultra",
          ].includes(value.effort)))
    )
      throw new Error(
        "Cloud agent selection requires a supported explicit effort",
      );
    return {
      agentId,
      model: value.model,
      ...(typeof value.agentCredentialGrantId === "string"
        ? { agentCredentialGrantId: value.agentCredentialGrantId }
        : {}),
      env: {
        [variables[agentId]]: value.model,
        ...(agentId === "claude"
          ? { CLAUDE_CODE_SUBAGENT_MODEL: value.model }
          : {}),
        ...(typeof value.effort === "string"
          ? { ZEROS_THINKING_EFFORT: value.effort }
          : {}),
        ZEROS_REQUIRE_EXACT_MODEL: "1",
        ZEROS_FAST_MODE: value.fast === true ? "1" : "0",
      },
    };
  });
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

/** Checks the installed core contract only. Live tool effects, Design behavior,
 * image identity and credential qualification remain independent requirements.
 * Never use this as a fallback when the full-native gate fails. */
export function assertCloudCoreBoundary(agentId: string, raw: unknown): void {
  const record = (value:unknown):Record<string,unknown>|null => value&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:null;
  const boundary = record(raw),profile=record(boundary?.cloudExecution),design=record(boundary?.designProtection),parity=record(boundary?.parity);
  const expected = Object.hasOwn(CLOUD_CORE_PROVIDER_RESTRICTIONS, agentId)
    ? CLOUD_CORE_PROVIDER_RESTRICTIONS[agentId as CloudCoreProvider] : null;
  const restrictions = parity?.restrictions;
  if (!expected || boundary?.version !== 1 || boundary.actor !== "agent-code" || boundary.state !== "ready" ||
      boundary.backend !== "cloud-worker" || design?.required !== true ||
      design.enforced !== true || !Number.isSafeInteger(design.protectedDirectoryCount) ||
      Number(design.protectedDirectoryCount) < 1 || parity?.level !== "restricted" ||
      !Array.isArray(restrictions) || restrictions.length !== expected.length ||
      restrictions.some((value: unknown, index: number) => value !== expected[index]) ||
      profile?.version !== 1 || profile.profile !== CLOUD_CORE_EXECUTION_PROFILE ||
      profile.runtimeProfile !== "zeros-cloud-worker-v3" || profile.provider !== agentId || profile.designApi !== "admitted") {
    throw new Error(`${agentId} did not receive the declared cloud core and admitted Design API contract`);
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

export function validateDeletableQualificationSnapshotName(name: string): void {
  if (
    !/^zeros-zsr-(?:ci|candidate)-[1-9][0-9]{0,19}-[1-9][0-9]{0,9}$/.test(name)
  ) {
    throw new Error(
      "automated snapshot deletion requires a run-scoped zeros-zsr-ci or zeros-zsr-candidate name",
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
