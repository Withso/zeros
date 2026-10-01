// Capacity envelope of CloudRuntimeBridgeRelay, and its validated environment.
// Sizing guidance and measurements: docs/cloud-workspace/relay-capacity.md.

const MiB = 1024 * 1024;

/** Largest message the relay assembles, in either direction. The engine
 * refuses client messages above the protocol's 16 MiB frame limit, but its
 * replies (Git diffs, Design frames, tool media) can be larger, and the
 * desktop drops those one at a time. A smaller relay cap would instead tear
 * down the whole connection, so this stays the message contract. */
export const CLOUD_RUNTIME_RELAY_MAX_MESSAGE_BYTES = 64 * MiB;

export function cloudRuntimeRelayOutboundBytes(payloadBytes: number): number {
  return Math.max(512, payloadBytes);
}

export type CloudRuntimeRelayLimits = {
  /** Active client↔engine connections on one relay process. */
  maxConnections: number;
  /** Writer connections for any one workspace. */
  maxConnectionsPerWorkspace: number;
  maxReadOnlyConnectionsPerWorkspace: number;
  /** Queued output summed across every connection. */
  outboundBudgetBytes: number;
  /** Declared bytes of partially received messages summed across every
   * connection. `ws` buffers a whole message before the relay can forward
   * it, so this bounds assembly memory independently of the connection
   * count. */
  inboundBudgetBytes: number;
};

export const DEFAULT_CLOUD_RUNTIME_RELAY_LIMITS: Readonly<CloudRuntimeRelayLimits> =
  Object.freeze({
    maxConnections: 64,
    maxConnectionsPerWorkspace: 10,
    maxReadOnlyConnectionsPerWorkspace: 10,
    outboundBudgetBytes: 128 * MiB,
    inboundBudgetBytes: 256 * MiB,
  });

/** Inclusive bounds. Both budgets must hold at least one maximum-size
 * message; the ceilings only catch unit mistakes. */
export const CLOUD_RUNTIME_RELAY_LIMIT_RANGES = Object.freeze({
  maxConnections: [1, 1024],
  maxConnectionsPerWorkspace: [1, 64],
  maxReadOnlyConnectionsPerWorkspace: [1, 64],
  outboundBudgetMiB: [64, 16_384],
  inboundBudgetMiB: [64, 16_384],
} as const);

export const CLOUD_RUNTIME_RELAY_ENVIRONMENT = Object.freeze({
  maxConnections: "CLOUD_WORKSPACE_BRIDGE_MAX_CONNECTIONS",
  maxConnectionsPerWorkspace:
    "CLOUD_WORKSPACE_BRIDGE_MAX_CONNECTIONS_PER_WORKSPACE",
  maxReadOnlyConnectionsPerWorkspace:
    "CLOUD_WORKSPACE_BRIDGE_MAX_READ_ONLY_CONNECTIONS_PER_WORKSPACE",
  outboundBudgetMiB: "CLOUD_WORKSPACE_BRIDGE_OUTBOUND_BUDGET_MIB",
  inboundBudgetMiB: "CLOUD_WORKSPACE_BRIDGE_INBOUND_BUDGET_MIB",
} as const);

function within(
  value: number | undefined,
  [minimum, maximum]: readonly [number, number],
) {
  return (
    value === undefined ||
    (Number.isSafeInteger(value) && value >= minimum && value <= maximum)
  );
}

/** Applies defaults and validates constructor input. An unset per-workspace
 * ceiling follows a smaller instance ceiling; an explicit one may not exceed
 * it. */
export function cloudRuntimeRelayLimits(input: {
  [Key in keyof CloudRuntimeRelayLimits]?: number | undefined;
}): CloudRuntimeRelayLimits {
  const ranges = CLOUD_RUNTIME_RELAY_LIMIT_RANGES;
  if (
    !within(input.maxConnections, ranges.maxConnections) ||
    !within(
      input.maxConnectionsPerWorkspace,
      ranges.maxConnectionsPerWorkspace,
    ) ||
    !within(
      input.maxReadOnlyConnectionsPerWorkspace,
      ranges.maxReadOnlyConnectionsPerWorkspace,
    ) ||
    !within(input.outboundBudgetBytes, [
      ranges.outboundBudgetMiB[0] * MiB,
      ranges.outboundBudgetMiB[1] * MiB,
    ]) ||
    !within(input.inboundBudgetBytes, [
      ranges.inboundBudgetMiB[0] * MiB,
      ranges.inboundBudgetMiB[1] * MiB,
    ])
  )
    throw new RangeError("invalid relay bound");
  const maxConnections =
    input.maxConnections ?? DEFAULT_CLOUD_RUNTIME_RELAY_LIMITS.maxConnections;
  const maxConnectionsPerWorkspace =
    input.maxConnectionsPerWorkspace ??
    Math.min(
      DEFAULT_CLOUD_RUNTIME_RELAY_LIMITS.maxConnectionsPerWorkspace,
      maxConnections,
    );
  const maxReadOnlyConnectionsPerWorkspace =
    input.maxReadOnlyConnectionsPerWorkspace ??
    Math.min(
      DEFAULT_CLOUD_RUNTIME_RELAY_LIMITS.maxReadOnlyConnectionsPerWorkspace,
      maxConnections,
    );
  if (
    maxConnectionsPerWorkspace > maxConnections ||
    maxReadOnlyConnectionsPerWorkspace > maxConnections
  )
    throw new RangeError("invalid relay bound");
  return {
    maxConnections,
    maxConnectionsPerWorkspace,
    maxReadOnlyConnectionsPerWorkspace,
    outboundBudgetBytes:
      input.outboundBudgetBytes ??
      DEFAULT_CLOUD_RUNTIME_RELAY_LIMITS.outboundBudgetBytes,
    inboundBudgetBytes:
      input.inboundBudgetBytes ??
      DEFAULT_CLOUD_RUNTIME_RELAY_LIMITS.inboundBudgetBytes,
  };
}

/** Reads the relay envelope from the environment. Unset or blank variables
 * keep the measured defaults; anything else must be a plain decimal integer. */
export function loadCloudRuntimeRelayLimits(
  env: NodeJS.ProcessEnv,
): CloudRuntimeRelayLimits {
  const names = CLOUD_RUNTIME_RELAY_ENVIRONMENT;
  const ranges = CLOUD_RUNTIME_RELAY_LIMIT_RANGES;
  const read = (
    name: string,
    [minimum, maximum]: readonly [number, number],
  ): number | undefined => {
    const raw = env[name]?.trim();
    if (!raw) return undefined;
    const value = /^[1-9][0-9]{0,5}$/.test(raw) ? Number(raw) : Number.NaN;
    if (!(value >= minimum && value <= maximum))
      throw new Error(
        `Invalid cloud workspace bridge environment: ${name} must be an integer from ${minimum} to ${maximum}`,
      );
    return value;
  };
  const maxConnections = read(names.maxConnections, ranges.maxConnections);
  const maxConnectionsPerWorkspace = read(
    names.maxConnectionsPerWorkspace,
    ranges.maxConnectionsPerWorkspace,
  );
  const maxReadOnlyConnectionsPerWorkspace = read(
    names.maxReadOnlyConnectionsPerWorkspace,
    ranges.maxReadOnlyConnectionsPerWorkspace,
  );
  const outboundBudgetMiB = read(
    names.outboundBudgetMiB,
    ranges.outboundBudgetMiB,
  );
  const inboundBudgetMiB = read(
    names.inboundBudgetMiB,
    ranges.inboundBudgetMiB,
  );
  for (const [name, value] of [
    [names.maxConnectionsPerWorkspace, maxConnectionsPerWorkspace],
    [
      names.maxReadOnlyConnectionsPerWorkspace,
      maxReadOnlyConnectionsPerWorkspace,
    ],
  ] as const)
    if (
      value !== undefined &&
      value >
        (maxConnections ?? DEFAULT_CLOUD_RUNTIME_RELAY_LIMITS.maxConnections)
    )
      throw new Error(
        `Invalid cloud workspace bridge environment: ${name} must not exceed ${names.maxConnections}`,
      );
  return cloudRuntimeRelayLimits({
    ...(maxConnections === undefined ? {} : { maxConnections }),
    ...(maxConnectionsPerWorkspace === undefined
      ? {}
      : { maxConnectionsPerWorkspace }),
    ...(maxReadOnlyConnectionsPerWorkspace === undefined
      ? {}
      : { maxReadOnlyConnectionsPerWorkspace }),
    ...(outboundBudgetMiB === undefined
      ? {}
      : { outboundBudgetBytes: outboundBudgetMiB * MiB }),
    ...(inboundBudgetMiB === undefined
      ? {}
      : { inboundBudgetBytes: inboundBudgetMiB * MiB }),
  });
}
