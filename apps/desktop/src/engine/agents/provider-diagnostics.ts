import type {
  AgentConfigurationProvenance,
  AgentConfigurationSource,
  AgentProviderQuota,
} from "@zeros/protocol/agent-events";

type SupportedProvenanceProvider = "claude" | "cursor";

const CONFIGURATION_LAYERS: Record<
  SupportedProvenanceProvider,
  ReadonlyArray<{ id: string; label: string }>
> = {
  claude: [
    { id: "user", label: "User" },
    { id: "project", label: "Project" },
    { id: "local", label: "Local" },
  ],
  cursor: [
    { id: "user", label: "User" },
    { id: "project", label: "Project" },
    { id: "team", label: "Team" },
    { id: "mdm", label: "Device management" },
    { id: "plugins", label: "Plugins" },
  ],
};

const ZEROS_CONFIGURATION_SOURCE: AgentConfigurationSource = {
  id: "zeros-session",
  label: "Zeros session settings",
  status: "injected",
};

/** Project the provider loaders Zeros actually enables. This is intentionally
 * static and privacy-preserving: it reports eligible layers, not file paths,
 * values, plugin names, rules, commands, or credentials. */
export function configurationProvenanceFor(
  providerId: SupportedProvenanceProvider,
  options: {
    protectedTerritory: boolean;
    suppressUnsafeSources: boolean;
  },
): AgentConfigurationProvenance {
  const nativeStatus: AgentConfigurationSource["status"] =
    options.suppressUnsafeSources ? "suppressed" : "loaded";
  return {
    providerId,
    protectedTerritory: options.protectedTerritory,
    sources: [
      ...CONFIGURATION_LAYERS[providerId].map((source) => ({
        ...source,
        status: nativeStatus,
        ...(nativeStatus === "suppressed"
          ? {
              reason:
                "Suppressed to preserve protected workspace boundaries",
            }
          : {}),
      })),
      ZEROS_CONFIGURATION_SOURCE,
    ],
  };
}

const CODEX_LAYER_LABELS: Record<string, { id: string; label: string }> = {
  packagedDefaults: { id: "packaged-defaults", label: "Packaged defaults" },
  mdm: { id: "mdm", label: "Device management" },
  system: { id: "system", label: "System" },
  enterpriseManaged: { id: "enterprise-managed", label: "Enterprise" },
  user: { id: "user", label: "User" },
  project: { id: "project", label: "Project" },
  sessionFlags: { id: "session-flags", label: "Session flags" },
  legacyManagedConfigTomlFromFile: {
    id: "legacy-managed-file",
    label: "Managed configuration",
  },
  legacyManagedConfigTomlFromMdm: {
    id: "legacy-managed-mdm",
    label: "Managed configuration",
  },
};

/** Convert config/read(includeLayers) into labels only. Provider paths and
 * disabledReason text are intentionally discarded at the adapter boundary. */
export function provenanceFromCodexLayers(
  layers: unknown,
  protectedTerritory: boolean,
): AgentConfigurationProvenance {
  const native: AgentConfigurationSource[] = [];
  const occurrences = new Map<string, number>();
  if (Array.isArray(layers)) {
    for (const candidate of layers) {
      if (!isRecord(candidate) || !isRecord(candidate.name)) continue;
      const type = candidate.name.type;
      if (typeof type !== "string") continue;
      const known = CODEX_LAYER_LABELS[type] ?? {
        id: "provider-layer",
        label: "Provider layer",
      };
      const occurrence = (occurrences.get(known.id) ?? 0) + 1;
      occurrences.set(known.id, occurrence);
      const id = occurrence === 1 ? known.id : `${known.id}-${occurrence}`;
      const disabled =
        typeof candidate.disabledReason === "string" &&
        candidate.disabledReason.trim().length > 0;
      native.push({
        id,
        label: known.label,
        status: disabled ? "suppressed" : "loaded",
        ...(disabled ? { reason: "Disabled by provider policy" } : {}),
      });
    }
  }
  if (native.length === 0) {
    native.push({
      id: "native-layers",
      label: "Native configuration",
      status: "unavailable",
      reason: "Provider did not report layer details",
    });
  }
  return {
    providerId: "codex",
    protectedTerritory,
    sources: [...native, ZEROS_CONFIGURATION_SOURCE],
  };
}

export interface CodexRateLimitWindowLike {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface CodexRateLimitSnapshotLike {
  limitId: string | null;
  limitName: string | null;
  primary: CodexRateLimitWindowLike | null;
  secondary: CodexRateLimitWindowLike | null;
  credits: {
    hasCredits: boolean;
    unlimited: boolean;
    balance: string | null;
  } | null;
  individualLimit: unknown | null;
  spendControlReached: boolean | null;
  planType: string | null;
  rateLimitReachedType: unknown | null;
}

/** Merge a sparse rolling notification into the last authoritative read.
 * Null means unavailable in this update and therefore does not erase the last
 * confirmed account/window value. */
export function mergeCodexRateLimitSnapshot(
  previous: CodexRateLimitSnapshotLike | null,
  incoming: CodexRateLimitSnapshotLike,
): CodexRateLimitSnapshotLike {
  if (!previous) return incoming;
  return {
    limitId: incoming.limitId ?? previous.limitId,
    limitName: incoming.limitName ?? previous.limitName,
    primary: incoming.primary ?? previous.primary,
    secondary: incoming.secondary ?? previous.secondary,
    credits: incoming.credits ?? previous.credits,
    individualLimit: incoming.individualLimit ?? previous.individualLimit,
    spendControlReached:
      incoming.spendControlReached ?? previous.spendControlReached,
    planType: incoming.planType ?? previous.planType,
    rateLimitReachedType:
      incoming.rateLimitReachedType ?? previous.rateLimitReachedType,
  };
}

function normalizedWindow(raw: CodexRateLimitWindowLike | null) {
  if (!raw || !Number.isFinite(raw.usedPercent)) return undefined;
  const resetsAt =
    typeof raw.resetsAt === "number" && Number.isFinite(raw.resetsAt)
      ? raw.resetsAt < 10_000_000_000
        ? raw.resetsAt * 1_000
        : raw.resetsAt
      : undefined;
  return {
    usedPercent: Math.min(100, Math.max(0, raw.usedPercent)),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(typeof raw.windowDurationMins === "number" &&
    Number.isFinite(raw.windowDurationMins) &&
    raw.windowDurationMins >= 0
      ? { windowDurationMinutes: raw.windowDurationMins }
      : {}),
  };
}

export function normalizeCodexQuota(
  snapshot: CodexRateLimitSnapshotLike,
  now = Date.now(),
): AgentProviderQuota {
  const primary = normalizedWindow(snapshot.primary);
  const secondary = normalizedWindow(snapshot.secondary);
  return {
    providerId: "codex",
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
    ...(snapshot.credits
      ? {
          credits: {
            available:
              snapshot.credits.hasCredits || snapshot.credits.unlimited,
            unlimited: snapshot.credits.unlimited,
            ...(snapshot.credits.balance !== null
              ? { balance: snapshot.credits.balance }
              : {}),
          },
        }
      : {}),
    ...(snapshot.planType ? { plan: snapshot.planType } : {}),
    fetchedAt: now,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
