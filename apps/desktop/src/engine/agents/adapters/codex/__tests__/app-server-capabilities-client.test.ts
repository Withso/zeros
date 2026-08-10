import { describe, expect, it, vi } from "vitest";

import { createCodexCapabilitiesClient } from "../app-server-capabilities-client";

describe("Codex app-server capability client", () => {
  it("routes extension, account, review, environment, and remote methods", async () => {
    const request = vi.fn(async (method: string, params?: unknown) => ({
      method,
      params,
    }));
    const client = createCodexCapabilitiesClient(request);

    await client.listSkills({} as never);
    await client.listHooks({} as never);
    await client.loginMcpServer({} as never);
    await client.listMcpServerStatus({} as never);
    await client.listApps({} as never);
    await client.listPlugins({} as never);
    await client.installPlugin({} as never);
    await client.addMarketplace({} as never);
    await client.listPluginShares({} as never);
    await client.readConfig({} as never);
    await client.writeConfigValue({} as never);
    await client.readConfigRequirements();
    await client.startAccountLogin({} as never);
    await client.cancelAccountLogin({} as never);
    await client.logoutAccount();
    await client.detectExternalAgentConfigs({} as never);
    await client.readAccount({} as never);
    await client.readAccountUsage();
    await client.consumeRateLimitResetCredit({} as never);
    await client.sendAddCreditsNudgeEmail({} as never);
    await client.updateThreadMetadata({} as never);
    await client.setThreadMemoryMode({} as never);
    await client.approveGuardianDeniedAction({} as never);
    await client.resetMemory();
    await client.startThreadRealtime({} as never);
    await client.appendThreadRealtimeAudio({} as never);
    await client.appendThreadRealtimeText({} as never);
    await client.appendThreadRealtimeSpeech({} as never);
    await client.stopThreadRealtime({} as never);
    await client.listThreadRealtimeVoices({} as never);
    await client.startWindowsSandboxSetup({} as never);
    await client.readWindowsSandboxReadiness();
    await client.startReview({} as never);
    await client.addEnvironment({} as never);
    await client.readRemoteControlStatus();
    await client.listModels({} as never);

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "skills/list",
      "hooks/list",
      "mcpServer/oauth/login",
      "mcpServerStatus/list",
      "app/list",
      "plugin/list",
      "plugin/install",
      "marketplace/add",
      "plugin/share/list",
      "config/read",
      "config/value/write",
      "configRequirements/read",
      "account/login/start",
      "account/login/cancel",
      "account/logout",
      "externalAgentConfig/detect",
      "account/read",
      "account/usage/read",
      "account/rateLimitResetCredit/consume",
      "account/sendAddCreditsNudgeEmail",
      "thread/metadata/update",
      "thread/memoryMode/set",
      "thread/approveGuardianDeniedAction",
      "memory/reset",
      "thread/realtime/start",
      "thread/realtime/appendAudio",
      "thread/realtime/appendText",
      "thread/realtime/appendSpeech",
      "thread/realtime/stop",
      "thread/realtime/listVoices",
      "windowsSandbox/setupStart",
      "windowsSandbox/readiness",
      "review/start",
      "environment/add",
      "remoteControl/status/read",
      "model/list",
    ]);
    expect(request).toHaveBeenCalledWith("account/usage/read");
    expect(request).toHaveBeenCalledWith("remoteControl/status/read");
  });
});
