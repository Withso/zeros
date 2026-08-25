import type {
  AgentCapabilityDescriptor,
  AgentCapabilityRequirement,
  AgentDomainCapabilities,
  InitializeResponse,
} from "@zeros/protocol/agent-events";

import type { AgentAdapter, AgentCapabilityPorts } from "./types";

const resolvedPorts = new WeakMap<
  AgentAdapter,
  { declared: AgentCapabilityPorts | undefined; value: AgentCapabilityPorts }
>();

/** Resolve explicit domain ports plus the temporary flat-method compatibility
 * surface. This is intentionally the sole place where engine code adapts the
 * broad legacy interface; product call sites consume the returned narrow
 * domains and never provider RPC names. */
export function resolveAgentCapabilityPorts(
  adapter: AgentAdapter,
): AgentCapabilityPorts {
  const cached = resolvedPorts.get(adapter);
  if (cached && cached.declared === adapter.capabilityPorts)
    return cached.value;

  const declared = adapter.capabilityPorts;
  const forkProviderBinding =
    declared?.conversation?.forkProviderBinding ??
    (adapter.forkProviderBinding
      ? (
          opts: Parameters<NonNullable<AgentAdapter["forkProviderBinding"]>>[0],
        ) => adapter.forkProviderBinding!(opts)
      : undefined);
  const conversation = forkProviderBinding
    ? { forkProviderBinding }
    : undefined;

  const updateUse =
    declared?.browser?.updateUse ??
    (adapter.updateBrowserUse
      ? (opts: Parameters<NonNullable<AgentAdapter["updateBrowserUse"]>>[0]) =>
          adapter.updateBrowserUse!(opts)
      : undefined);
  const browser = declared?.browser
    ? { ...declared.browser, ...(updateUse ? { updateUse } : {}) }
    : updateUse
      ? { nativeSession: true as const, updateUse }
      : undefined;

  const stopTask =
    declared?.backgroundWork?.stopTask ??
    (adapter.stopBackgroundTask
      ? (
          opts: Parameters<NonNullable<AgentAdapter["stopBackgroundTask"]>>[0],
        ) => adapter.stopBackgroundTask!(opts)
      : undefined);
  const backgroundWork = stopTask ? { stopTask } : undefined;

  const steer =
    declared?.turnControl?.steer ??
    (adapter.steer
      ? (opts: Parameters<NonNullable<AgentAdapter["steer"]>>[0]) =>
          adapter.steer!(opts)
      : undefined);
  const setMode =
    declared?.turnControl?.setMode ??
    (adapter.setMode
      ? (opts: Parameters<NonNullable<AgentAdapter["setMode"]>>[0]) =>
          adapter.setMode!(opts)
      : undefined);
  const compactContext =
    declared?.turnControl?.compactContext ??
    (adapter.compactContext
      ? (opts: Parameters<NonNullable<AgentAdapter["compactContext"]>>[0]) =>
          adapter.compactContext!(opts)
      : undefined);
  const turnControl =
    steer || setMode || compactContext
      ? {
          ...(steer ? { steer } : {}),
          ...(setMode ? { setMode } : {}),
          ...(compactContext ? { compactContext } : {}),
        }
      : undefined;

  const setModel =
    declared?.runtimeConfiguration?.setModel ??
    (adapter.setModel
      ? (opts: Parameters<NonNullable<AgentAdapter["setModel"]>>[0]) =>
          adapter.setModel!(opts)
      : undefined);
  const updateConfig =
    declared?.runtimeConfiguration?.updateConfig ??
    (adapter.updateConfig
      ? (opts: Parameters<NonNullable<AgentAdapter["updateConfig"]>>[0]) =>
          adapter.updateConfig!(opts)
      : undefined);
  const runtimeConfiguration =
    setModel || updateConfig
      ? {
          ...(setModel ? { setModel } : {}),
          ...(updateConfig ? { updateConfig } : {}),
        }
      : undefined;

  const respondToPermission =
    declared?.interaction?.respondToPermission ??
    (adapter.respondToPermission
      ? (
          opts: Parameters<NonNullable<AgentAdapter["respondToPermission"]>>[0],
        ) => adapter.respondToPermission!(opts)
      : undefined);
  const respondToQuestion =
    declared?.interaction?.respondToQuestion ??
    (adapter.respondToQuestion
      ? (opts: Parameters<NonNullable<AgentAdapter["respondToQuestion"]>>[0]) =>
          adapter.respondToQuestion!(opts)
      : undefined);
  const interaction =
    respondToPermission || respondToQuestion
      ? {
          ...(respondToPermission ? { respondToPermission } : {}),
          ...(respondToQuestion ? { respondToQuestion } : {}),
        }
      : undefined;

  const validateApiKey =
    declared?.account?.validateApiKey ??
    (adapter.validateApiKey
      ? (
          apiKey: string,
          opts?: Parameters<NonNullable<AgentAdapter["validateApiKey"]>>[1],
        ) => adapter.validateApiKey!(apiKey, opts)
      : undefined);
  const getAccountInfo =
    declared?.account?.getAccountInfo ??
    (adapter.getAccountInfo
      ? (opts?: Parameters<NonNullable<AgentAdapter["getAccountInfo"]>>[0]) =>
          adapter.getAccountInfo!(opts)
      : undefined);
  const readQuota = declared?.account?.readQuota;
  const account =
    validateApiKey || getAccountInfo || readQuota
      ? {
          ...(validateApiKey ? { validateApiKey } : {}),
          ...(getAccountInfo ? { getAccountInfo } : {}),
          ...(readQuota ? { readQuota } : {}),
        }
      : undefined;

  const generateText =
    declared?.textGeneration?.generateText ??
    (adapter.generateText
      ? (opts: Parameters<NonNullable<AgentAdapter["generateText"]>>[0]) =>
          adapter.generateText!(opts)
      : undefined);
  const textGeneration = generateText ? { generateText } : undefined;
  const memory = declared?.memory;
  const goal = declared?.goal;
  const safety = declared?.safety;
  const configuration = declared?.configuration;

  const value: AgentCapabilityPorts = {
    ...(conversation ? { conversation } : {}),
    ...(browser ? { browser } : {}),
    ...(backgroundWork ? { backgroundWork } : {}),
    ...(turnControl ? { turnControl } : {}),
    ...(runtimeConfiguration ? { runtimeConfiguration } : {}),
    ...(interaction ? { interaction } : {}),
    ...(account ? { account } : {}),
    ...(textGeneration ? { textGeneration } : {}),
    ...(memory ? { memory } : {}),
    ...(goal ? { goal } : {}),
    ...(safety ? { safety } : {}),
    ...(configuration ? { configuration } : {}),
  };
  resolvedPorts.set(adapter, { declared, value });
  return value;
}

function harnessNative(
  requirements?: AgentCapabilityRequirement[],
): AgentCapabilityDescriptor {
  return {
    implementation: "harness-native",
    availability: "available",
    ...(requirements?.length ? { requirements } : {}),
  };
}

function runtimeDependent(
  requirements: AgentCapabilityRequirement[],
): AgentCapabilityDescriptor {
  return {
    implementation: "harness-native",
    availability: "runtime-dependent",
    requirements,
  };
}

function unavailable(reason: string): AgentCapabilityDescriptor {
  return { implementation: "unavailable", availability: "unavailable", reason };
}

function implemented(
  implementation: unknown,
  requirements: AgentCapabilityRequirement[],
  reason: string,
): AgentCapabilityDescriptor {
  return implementation ? harnessNative(requirements) : unavailable(reason);
}

function domainCapabilities(
  adapter: AgentAdapter,
  initialize: InitializeResponse,
): AgentDomainCapabilities {
  const ports = resolveAgentCapabilityPorts(adapter);
  const meta = initialize._meta;
  const hasModels = Array.isArray(meta?.models) && meta.models.length > 0;
  const catalog = hasModels
    ? harnessNative()
    : meta?.modelsDynamic === true
      ? runtimeDependent(["live-runtime"])
      : unavailable("This harness does not advertise a model catalog.");

  return {
    conversation: {
      resume: harnessNative(["provider-binding"]),
      fork: implemented(
        ports.conversation?.forkProviderBinding,
        ["provider-binding"],
        "This harness does not expose conversation fork.",
      ),
    },
    turn: {
      steering: implemented(
        ports.turnControl?.steer,
        ["live-session", "active-turn"],
        "This harness does not expose mid-turn steering.",
      ),
      modeSwitch: implemented(
        ports.turnControl?.setMode,
        ["live-session"],
        "This harness does not expose live mode switching.",
      ),
      contextCompaction: implemented(
        ports.turnControl?.compactContext,
        ["live-session"],
        "This harness does not expose context compaction.",
      ),
    },
    backgroundWork: {
      stopTask: implemented(
        ports.backgroundWork?.stopTask,
        ["live-session"],
        "This harness does not expose targeted background-task stop.",
      ),
    },
    interaction: {
      permissionResponse: implemented(
        ports.interaction?.respondToPermission,
        [],
        "This harness has no host-answerable permission channel.",
      ),
      questionResponse: implemented(
        ports.interaction?.respondToQuestion,
        [],
        "This harness has no host-answerable question channel.",
      ),
    },
    models: {
      catalog,
      liveSwitch: implemented(
        ports.runtimeConfiguration?.setModel,
        ["live-session"],
        "This harness does not expose live model switching.",
      ),
      liveConfiguration: implemented(
        ports.runtimeConfiguration?.updateConfig,
        ["live-session"],
        "This harness does not expose live runtime configuration.",
      ),
    },
    account: {
      read: implemented(
        ports.account?.getAccountInfo,
        ["authentication"],
        "This harness does not expose account details.",
      ),
      validateApiKey: implemented(
        ports.account?.validateApiKey,
        [],
        "This harness does not expose API-key validation.",
      ),
      quota: implemented(
        ports.account?.readQuota,
        ["authentication"],
        "This harness does not expose account usage limits.",
      ),
    },
    generation: {
      oneShotText: implemented(
        ports.textGeneration?.generateText,
        ["authentication"],
        "This harness does not expose isolated text generation.",
      ),
    },
    browser: {
      nativeSession: implemented(
        ports.browser?.nativeSession,
        ["authentication", "live-session"],
        "This harness has no official native browser session channel.",
      ),
    },
    goal: {
      lifecycle: implemented(
        ports.goal,
        ["live-session"],
        "This harness does not expose goals.",
      ),
    },
    memory: {
      settings: implemented(
        ports.memory?.readSettings && ports.memory?.updateSettings,
        ["authentication"],
        "This harness does not expose local-memory settings.",
      ),
      reset: implemented(
        ports.memory?.reset,
        ["authentication"],
        "This harness does not expose local-memory reset.",
      ),
    },
    configuration: {
      provenance: implemented(
        ports.configuration?.readProvenance,
        ["authentication"],
        "This harness does not expose configuration provenance.",
      ),
    },
    safety: {
      retryDeniedAction: implemented(
        ports.safety?.retryDeniedAction,
        ["live-session"],
        "This harness does not expose denied-action retry.",
      ),
    },
  };
}

/** Attach an engine-derived, provider-neutral capability snapshot. Legacy
 * booleans are also derived from the same ports so old renderers remain wire
 * compatible without preserving contradictory adapter declarations. */
export function advertiseAgentCapabilities(
  adapter: AgentAdapter,
  initialize: InitializeResponse,
): InitializeResponse {
  const domains = domainCapabilities(adapter, initialize);
  return {
    ...initialize,
    agentCapabilities: {
      ...initialize.agentCapabilities,
      loadSession: true,
      steering: domains.turn.steering.implementation !== "unavailable",
      domains,
    },
  };
}
