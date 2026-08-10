import { describe, expect, it, vi } from "vitest";

import { invokeCodexCapability } from "../codex-capability-dispatch";

describe("invokeCodexCapability", () => {
  it.each([
    ["thread.fork", "forkThread"],
    ["thread.goal.get", "getThreadGoal"],
    ["thread.search", "searchThreads"],
    ["thread.searchOccurrences", "searchThreadOccurrences"],
    ["thread.loaded.list", "listLoadedThreads"],
    ["thread.backgroundTerminals.list", "listBackgroundTerminals"],
    ["thread.backgroundTerminals.clean", "cleanBackgroundTerminals"],
    ["thread.backgroundTerminals.terminate", "terminateBackgroundTerminal"],
    ["skills.list", "listSkills"],
    ["hooks.list", "listHooks"],
    ["mcp.status.list", "listMcpServerStatus"],
    ["apps.list", "listApps"],
    ["plugins.list", "listPlugins"],
    ["marketplaces.add", "addMarketplace"],
    ["pluginShares.list", "listPluginShares"],
    ["config.read", "readConfig"],
    ["config.value.write", "writeConfigValue"],
    ["account.login.start", "startAccountLogin"],
    ["externalAgentConfig.detect", "detectExternalAgentConfigs"],
    ["account.read", "readAccount"],
    ["account.rateLimitResetCredit.consume", "consumeRateLimitResetCredit"],
    ["account.sendAddCreditsNudgeEmail", "sendAddCreditsNudgeEmail"],
    ["thread.metadata.update", "updateThreadMetadata"],
    ["thread.memoryMode.set", "setThreadMemoryMode"],
    ["thread.guardianDeniedAction.approve", "approveGuardianDeniedAction"],
    ["thread.realtime.start", "startThreadRealtime"],
    ["thread.realtime.appendAudio", "appendThreadRealtimeAudio"],
    ["thread.realtime.appendText", "appendThreadRealtimeText"],
    ["thread.realtime.appendSpeech", "appendThreadRealtimeSpeech"],
    ["thread.realtime.stop", "stopThreadRealtime"],
    ["thread.realtime.voices.list", "listThreadRealtimeVoices"],
    ["windowsSandbox.setup.start", "startWindowsSandboxSetup"],
    ["review.start", "startReview"],
    ["environment.status", "readEnvironmentStatus"],
    ["remoteControl.clients.list", "listRemoteControlClients"],
    ["models.list", "listModels"],
    ["experimental.list", "listExperimentalFeatures"],
    ["permissionProfiles.list", "listPermissionProfiles"],
    ["collaborationModes.list", "listCollaborationModes"],
  ] as const)("routes %s through typed handle method %s", async (op, method) => {
    const fn = vi.fn(async () => ({ ok: true }));
    const runtime = { [method]: fn };

    await expect(
      invokeCodexCapability(runtime as never, op, { marker: op }),
    ).resolves.toEqual({ ok: true });
    expect(fn).toHaveBeenCalledWith({ marker: op });
  });

  it.each([
    ["mcp.reload", "reloadMcpServers"],
    ["account.rateLimits.read", "readAccountRateLimits"],
    ["account.usage.read", "readAccountUsage"],
    ["account.workspaceMessages.read", "readWorkspaceMessages"],
    ["remoteControl.status.read", "readRemoteControlStatus"],
    ["account.logout", "logoutAccount"],
    ["config.requirements.read", "readConfigRequirements"],
    ["externalAgentConfig.histories.read", "readExternalAgentConfigHistories"],
    ["memory.reset", "resetMemory"],
    ["windowsSandbox.readiness", "readWindowsSandboxReadiness"],
  ] as const)("routes parameterless %s without an invented params object", async (op, method) => {
    const fn = vi.fn(async () => ({ ok: true }));
    await invokeCodexCapability({ [method]: fn } as never, op, undefined);
    expect(fn).toHaveBeenCalledWith();
  });
});
