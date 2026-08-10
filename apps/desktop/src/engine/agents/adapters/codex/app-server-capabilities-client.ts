import type { AppsInstalledParams } from "./generated/v2/AppsInstalledParams";
import type { AppsInstalledResponse } from "./generated/v2/AppsInstalledResponse";
import type { AppsListParams } from "./generated/v2/AppsListParams";
import type { AppsListResponse } from "./generated/v2/AppsListResponse";
import type { AppsReadParams } from "./generated/v2/AppsReadParams";
import type { AppsReadResponse } from "./generated/v2/AppsReadResponse";
import type { CollaborationModeListParams } from "./generated/v2/CollaborationModeListParams";
import type { CollaborationModeListResponse } from "./generated/v2/CollaborationModeListResponse";
import type { ConfigBatchWriteParams } from "./generated/v2/ConfigBatchWriteParams";
import type { ConfigReadParams } from "./generated/v2/ConfigReadParams";
import type { ConfigReadResponse } from "./generated/v2/ConfigReadResponse";
import type { ConfigRequirementsReadResponse } from "./generated/v2/ConfigRequirementsReadResponse";
import type { ConfigValueWriteParams } from "./generated/v2/ConfigValueWriteParams";
import type { ConfigWriteResponse } from "./generated/v2/ConfigWriteResponse";
import type { ConsumeAccountRateLimitResetCreditParams } from "./generated/v2/ConsumeAccountRateLimitResetCreditParams";
import type { ConsumeAccountRateLimitResetCreditResponse } from "./generated/v2/ConsumeAccountRateLimitResetCreditResponse";
import type { CancelLoginAccountParams } from "./generated/v2/CancelLoginAccountParams";
import type { CancelLoginAccountResponse } from "./generated/v2/CancelLoginAccountResponse";
import type { LoginAccountParams } from "./generated/v2/LoginAccountParams";
import type { LoginAccountResponse } from "./generated/v2/LoginAccountResponse";
import type { LogoutAccountResponse } from "./generated/v2/LogoutAccountResponse";
import type { MemoryResetResponse } from "./generated/v2/MemoryResetResponse";
import type { EnvironmentAddParams } from "./generated/v2/EnvironmentAddParams";
import type { EnvironmentAddResponse } from "./generated/v2/EnvironmentAddResponse";
import type { EnvironmentInfoParams } from "./generated/v2/EnvironmentInfoParams";
import type { EnvironmentInfoResponse } from "./generated/v2/EnvironmentInfoResponse";
import type { EnvironmentStatusParams } from "./generated/v2/EnvironmentStatusParams";
import type { EnvironmentStatusResponse } from "./generated/v2/EnvironmentStatusResponse";
import type { ExperimentalFeatureEnablementSetParams } from "./generated/v2/ExperimentalFeatureEnablementSetParams";
import type { ExperimentalFeatureEnablementSetResponse } from "./generated/v2/ExperimentalFeatureEnablementSetResponse";
import type { ExperimentalFeatureListParams } from "./generated/v2/ExperimentalFeatureListParams";
import type { ExperimentalFeatureListResponse } from "./generated/v2/ExperimentalFeatureListResponse";
import type { GetAccountParams } from "./generated/v2/GetAccountParams";
import type { GetAccountRateLimitsResponse } from "./generated/v2/GetAccountRateLimitsResponse";
import type { GetAccountResponse } from "./generated/v2/GetAccountResponse";
import type { GetAccountTokenUsageResponse } from "./generated/v2/GetAccountTokenUsageResponse";
import type { GetWorkspaceMessagesResponse } from "./generated/v2/GetWorkspaceMessagesResponse";
import type { HooksListParams } from "./generated/v2/HooksListParams";
import type { HooksListResponse } from "./generated/v2/HooksListResponse";
import type { ListMcpServerStatusParams } from "./generated/v2/ListMcpServerStatusParams";
import type { ListMcpServerStatusResponse } from "./generated/v2/ListMcpServerStatusResponse";
import type { McpResourceReadParams } from "./generated/v2/McpResourceReadParams";
import type { McpResourceReadResponse } from "./generated/v2/McpResourceReadResponse";
import type { McpServerOauthLoginParams } from "./generated/v2/McpServerOauthLoginParams";
import type { McpServerOauthLoginResponse } from "./generated/v2/McpServerOauthLoginResponse";
import type { McpServerRefreshResponse } from "./generated/v2/McpServerRefreshResponse";
import type { McpServerToolCallParams } from "./generated/v2/McpServerToolCallParams";
import type { McpServerToolCallResponse } from "./generated/v2/McpServerToolCallResponse";
import type { MarketplaceAddParams } from "./generated/v2/MarketplaceAddParams";
import type { MarketplaceAddResponse } from "./generated/v2/MarketplaceAddResponse";
import type { MarketplaceRemoveParams } from "./generated/v2/MarketplaceRemoveParams";
import type { MarketplaceRemoveResponse } from "./generated/v2/MarketplaceRemoveResponse";
import type { MarketplaceUpgradeParams } from "./generated/v2/MarketplaceUpgradeParams";
import type { MarketplaceUpgradeResponse } from "./generated/v2/MarketplaceUpgradeResponse";
import type { ModelListParams } from "./generated/v2/ModelListParams";
import type { ModelListResponse } from "./generated/v2/ModelListResponse";
import type { ModelProviderCapabilitiesReadParams } from "./generated/v2/ModelProviderCapabilitiesReadParams";
import type { ModelProviderCapabilitiesReadResponse } from "./generated/v2/ModelProviderCapabilitiesReadResponse";
import type { PermissionProfileListParams } from "./generated/v2/PermissionProfileListParams";
import type { PermissionProfileListResponse } from "./generated/v2/PermissionProfileListResponse";
import type { PluginInstallParams } from "./generated/v2/PluginInstallParams";
import type { PluginInstallResponse } from "./generated/v2/PluginInstallResponse";
import type { PluginInstalledParams } from "./generated/v2/PluginInstalledParams";
import type { PluginInstalledResponse } from "./generated/v2/PluginInstalledResponse";
import type { PluginListParams } from "./generated/v2/PluginListParams";
import type { PluginListResponse } from "./generated/v2/PluginListResponse";
import type { PluginReadParams } from "./generated/v2/PluginReadParams";
import type { PluginReadResponse } from "./generated/v2/PluginReadResponse";
import type { PluginSkillReadParams } from "./generated/v2/PluginSkillReadParams";
import type { PluginSkillReadResponse } from "./generated/v2/PluginSkillReadResponse";
import type { PluginUninstallParams } from "./generated/v2/PluginUninstallParams";
import type { PluginUninstallResponse } from "./generated/v2/PluginUninstallResponse";
import type { PluginShareCheckoutParams } from "./generated/v2/PluginShareCheckoutParams";
import type { PluginShareCheckoutResponse } from "./generated/v2/PluginShareCheckoutResponse";
import type { PluginShareDeleteParams } from "./generated/v2/PluginShareDeleteParams";
import type { PluginShareDeleteResponse } from "./generated/v2/PluginShareDeleteResponse";
import type { PluginShareListParams } from "./generated/v2/PluginShareListParams";
import type { PluginShareListResponse } from "./generated/v2/PluginShareListResponse";
import type { PluginShareSaveParams } from "./generated/v2/PluginShareSaveParams";
import type { PluginShareSaveResponse } from "./generated/v2/PluginShareSaveResponse";
import type { PluginShareUpdateTargetsParams } from "./generated/v2/PluginShareUpdateTargetsParams";
import type { PluginShareUpdateTargetsResponse } from "./generated/v2/PluginShareUpdateTargetsResponse";
import type { ExternalAgentConfigDetectParams } from "./generated/v2/ExternalAgentConfigDetectParams";
import type { ExternalAgentConfigDetectResponse } from "./generated/v2/ExternalAgentConfigDetectResponse";
import type { ExternalAgentConfigImportHistoriesReadResponse } from "./generated/v2/ExternalAgentConfigImportHistoriesReadResponse";
import type { ExternalAgentConfigImportHistoryRecordParams } from "./generated/v2/ExternalAgentConfigImportHistoryRecordParams";
import type { ExternalAgentConfigImportHistoryRecordResponse } from "./generated/v2/ExternalAgentConfigImportHistoryRecordResponse";
import type { ExternalAgentConfigImportParams } from "./generated/v2/ExternalAgentConfigImportParams";
import type { ExternalAgentConfigImportResponse } from "./generated/v2/ExternalAgentConfigImportResponse";
import type { RemoteControlClientsListParams } from "./generated/v2/RemoteControlClientsListParams";
import type { RemoteControlClientsListResponse } from "./generated/v2/RemoteControlClientsListResponse";
import type { RemoteControlClientsRevokeParams } from "./generated/v2/RemoteControlClientsRevokeParams";
import type { RemoteControlClientsRevokeResponse } from "./generated/v2/RemoteControlClientsRevokeResponse";
import type { RemoteControlDisableParams } from "./generated/v2/RemoteControlDisableParams";
import type { RemoteControlDisableResponse } from "./generated/v2/RemoteControlDisableResponse";
import type { RemoteControlEnableParams } from "./generated/v2/RemoteControlEnableParams";
import type { RemoteControlEnableResponse } from "./generated/v2/RemoteControlEnableResponse";
import type { RemoteControlStatusReadResponse } from "./generated/v2/RemoteControlStatusReadResponse";
import type { ReviewStartParams } from "./generated/v2/ReviewStartParams";
import type { ReviewStartResponse } from "./generated/v2/ReviewStartResponse";
import type { SendAddCreditsNudgeEmailParams } from "./generated/v2/SendAddCreditsNudgeEmailParams";
import type { SendAddCreditsNudgeEmailResponse } from "./generated/v2/SendAddCreditsNudgeEmailResponse";
import type { SkillsConfigWriteParams } from "./generated/v2/SkillsConfigWriteParams";
import type { SkillsConfigWriteResponse } from "./generated/v2/SkillsConfigWriteResponse";
import type { SkillsExtraRootsSetParams } from "./generated/v2/SkillsExtraRootsSetParams";
import type { SkillsExtraRootsSetResponse } from "./generated/v2/SkillsExtraRootsSetResponse";
import type { SkillsListParams } from "./generated/v2/SkillsListParams";
import type { SkillsListResponse } from "./generated/v2/SkillsListResponse";
import type { ThreadMemoryModeSetParams } from "./generated/v2/ThreadMemoryModeSetParams";
import type { ThreadMemoryModeSetResponse } from "./generated/v2/ThreadMemoryModeSetResponse";
import type { ThreadApproveGuardianDeniedActionParams } from "./generated/v2/ThreadApproveGuardianDeniedActionParams";
import type { ThreadApproveGuardianDeniedActionResponse } from "./generated/v2/ThreadApproveGuardianDeniedActionResponse";
import type { ThreadMetadataUpdateParams } from "./generated/v2/ThreadMetadataUpdateParams";
import type { ThreadMetadataUpdateResponse } from "./generated/v2/ThreadMetadataUpdateResponse";
import type { ThreadRealtimeAppendAudioParams } from "./generated/v2/ThreadRealtimeAppendAudioParams";
import type { ThreadRealtimeAppendAudioResponse } from "./generated/v2/ThreadRealtimeAppendAudioResponse";
import type { ThreadRealtimeAppendSpeechParams } from "./generated/v2/ThreadRealtimeAppendSpeechParams";
import type { ThreadRealtimeAppendSpeechResponse } from "./generated/v2/ThreadRealtimeAppendSpeechResponse";
import type { ThreadRealtimeAppendTextParams } from "./generated/v2/ThreadRealtimeAppendTextParams";
import type { ThreadRealtimeAppendTextResponse } from "./generated/v2/ThreadRealtimeAppendTextResponse";
import type { ThreadRealtimeListVoicesParams } from "./generated/v2/ThreadRealtimeListVoicesParams";
import type { ThreadRealtimeListVoicesResponse } from "./generated/v2/ThreadRealtimeListVoicesResponse";
import type { ThreadRealtimeStartParams } from "./generated/v2/ThreadRealtimeStartParams";
import type { ThreadRealtimeStartResponse } from "./generated/v2/ThreadRealtimeStartResponse";
import type { ThreadRealtimeStopParams } from "./generated/v2/ThreadRealtimeStopParams";
import type { ThreadRealtimeStopResponse } from "./generated/v2/ThreadRealtimeStopResponse";
import type { WindowsSandboxReadinessResponse } from "./generated/v2/WindowsSandboxReadinessResponse";
import type { WindowsSandboxSetupStartParams } from "./generated/v2/WindowsSandboxSetupStartParams";
import type { WindowsSandboxSetupStartResponse } from "./generated/v2/WindowsSandboxSetupStartResponse";

type Request = (method: string, params?: unknown) => Promise<unknown>;

/** Typed access to Codex surfaces that sit outside the turn loop. Product UI
 * can adopt these incrementally without falling back to stringly JSON-RPC. */
export function createCodexCapabilitiesClient(request: Request) {
  const call = <T>(method: string, params?: unknown): Promise<T> =>
    request(method, params) as Promise<T>;
  const read = <T>(method: string): Promise<T> => request(method) as Promise<T>;

  return {
    listSkills: (params: SkillsListParams) =>
      call<SkillsListResponse>("skills/list", params),
    setSkillExtraRoots: (params: SkillsExtraRootsSetParams) =>
      call<SkillsExtraRootsSetResponse>("skills/extraRoots/set", params),
    writeSkillsConfig: (params: SkillsConfigWriteParams) =>
      call<SkillsConfigWriteResponse>("skills/config/write", params),
    listHooks: (params: HooksListParams) =>
      call<HooksListResponse>("hooks/list", params),

    loginMcpServer: (params: McpServerOauthLoginParams) =>
      call<McpServerOauthLoginResponse>("mcpServer/oauth/login", params),
    reloadMcpServers: () =>
      read<McpServerRefreshResponse>("config/mcpServer/reload"),
    listMcpServerStatus: (params: ListMcpServerStatusParams) =>
      call<ListMcpServerStatusResponse>("mcpServerStatus/list", params),
    readMcpResource: (params: McpResourceReadParams) =>
      call<McpResourceReadResponse>("mcpServer/resource/read", params),
    callMcpTool: (params: McpServerToolCallParams) =>
      call<McpServerToolCallResponse>("mcpServer/tool/call", params),

    listApps: (params: AppsListParams) =>
      call<AppsListResponse>("app/list", params),
    readApp: (params: AppsReadParams) =>
      call<AppsReadResponse>("app/read", params),
    installedApps: (params: AppsInstalledParams) =>
      call<AppsInstalledResponse>("app/installed", params),

    listPlugins: (params: PluginListParams) =>
      call<PluginListResponse>("plugin/list", params),
    installedPlugins: (params: PluginInstalledParams) =>
      call<PluginInstalledResponse>("plugin/installed", params),
    readPlugin: (params: PluginReadParams) =>
      call<PluginReadResponse>("plugin/read", params),
    readPluginSkill: (params: PluginSkillReadParams) =>
      call<PluginSkillReadResponse>("plugin/skill/read", params),
    installPlugin: (params: PluginInstallParams) =>
      call<PluginInstallResponse>("plugin/install", params),
    uninstallPlugin: (params: PluginUninstallParams) =>
      call<PluginUninstallResponse>("plugin/uninstall", params),
    addMarketplace: (params: MarketplaceAddParams) =>
      call<MarketplaceAddResponse>("marketplace/add", params),
    removeMarketplace: (params: MarketplaceRemoveParams) =>
      call<MarketplaceRemoveResponse>("marketplace/remove", params),
    upgradeMarketplace: (params: MarketplaceUpgradeParams) =>
      call<MarketplaceUpgradeResponse>("marketplace/upgrade", params),
    savePluginShare: (params: PluginShareSaveParams) =>
      call<PluginShareSaveResponse>("plugin/share/save", params),
    updatePluginShareTargets: (params: PluginShareUpdateTargetsParams) =>
      call<PluginShareUpdateTargetsResponse>("plugin/share/updateTargets", params),
    listPluginShares: (params: PluginShareListParams) =>
      call<PluginShareListResponse>("plugin/share/list", params),
    checkoutPluginShare: (params: PluginShareCheckoutParams) =>
      call<PluginShareCheckoutResponse>("plugin/share/checkout", params),
    deletePluginShare: (params: PluginShareDeleteParams) =>
      call<PluginShareDeleteResponse>("plugin/share/delete", params),

    readAccount: (params: GetAccountParams) =>
      call<GetAccountResponse>("account/read", params),
    readAccountRateLimits: () =>
      read<GetAccountRateLimitsResponse>("account/rateLimits/read"),
    readAccountUsage: () =>
      read<GetAccountTokenUsageResponse>("account/usage/read"),
    readWorkspaceMessages: () =>
      read<GetWorkspaceMessagesResponse>("account/workspaceMessages/read"),
    startAccountLogin: (params: LoginAccountParams) =>
      call<LoginAccountResponse>("account/login/start", params),
    cancelAccountLogin: (params: CancelLoginAccountParams) =>
      call<CancelLoginAccountResponse>("account/login/cancel", params),
    logoutAccount: () => read<LogoutAccountResponse>("account/logout"),
    consumeRateLimitResetCredit: (
      params: ConsumeAccountRateLimitResetCreditParams,
    ) =>
      call<ConsumeAccountRateLimitResetCreditResponse>(
        "account/rateLimitResetCredit/consume",
        params,
      ),
    sendAddCreditsNudgeEmail: (params: SendAddCreditsNudgeEmailParams) =>
      call<SendAddCreditsNudgeEmailResponse>(
        "account/sendAddCreditsNudgeEmail",
        params,
      ),

    updateThreadMetadata: (params: ThreadMetadataUpdateParams) =>
      call<ThreadMetadataUpdateResponse>("thread/metadata/update", params),
    setThreadMemoryMode: (params: ThreadMemoryModeSetParams) =>
      call<ThreadMemoryModeSetResponse>("thread/memoryMode/set", params),
    approveGuardianDeniedAction: (
      params: ThreadApproveGuardianDeniedActionParams,
    ) =>
      call<ThreadApproveGuardianDeniedActionResponse>(
        "thread/approveGuardianDeniedAction",
        params,
      ),
    resetMemory: () => read<MemoryResetResponse>("memory/reset"),

    startThreadRealtime: (params: ThreadRealtimeStartParams) =>
      call<ThreadRealtimeStartResponse>("thread/realtime/start", params),
    appendThreadRealtimeAudio: (params: ThreadRealtimeAppendAudioParams) =>
      call<ThreadRealtimeAppendAudioResponse>(
        "thread/realtime/appendAudio",
        params,
      ),
    appendThreadRealtimeText: (params: ThreadRealtimeAppendTextParams) =>
      call<ThreadRealtimeAppendTextResponse>(
        "thread/realtime/appendText",
        params,
      ),
    appendThreadRealtimeSpeech: (params: ThreadRealtimeAppendSpeechParams) =>
      call<ThreadRealtimeAppendSpeechResponse>(
        "thread/realtime/appendSpeech",
        params,
      ),
    stopThreadRealtime: (params: ThreadRealtimeStopParams) =>
      call<ThreadRealtimeStopResponse>("thread/realtime/stop", params),
    listThreadRealtimeVoices: (params: ThreadRealtimeListVoicesParams) =>
      call<ThreadRealtimeListVoicesResponse>(
        "thread/realtime/listVoices",
        params,
      ),

    startWindowsSandboxSetup: (params: WindowsSandboxSetupStartParams) =>
      call<WindowsSandboxSetupStartResponse>(
        "windowsSandbox/setupStart",
        params,
      ),
    readWindowsSandboxReadiness: () =>
      read<WindowsSandboxReadinessResponse>("windowsSandbox/readiness"),

    readConfig: (params: ConfigReadParams) =>
      call<ConfigReadResponse>("config/read", params),
    writeConfigValue: (params: ConfigValueWriteParams) =>
      call<ConfigWriteResponse>("config/value/write", params),
    writeConfigBatch: (params: ConfigBatchWriteParams) =>
      call<ConfigWriteResponse>("config/batchWrite", params),
    readConfigRequirements: () =>
      read<ConfigRequirementsReadResponse>("configRequirements/read"),
    detectExternalAgentConfigs: (params: ExternalAgentConfigDetectParams) =>
      call<ExternalAgentConfigDetectResponse>("externalAgentConfig/detect", params),
    importExternalAgentConfig: (params: ExternalAgentConfigImportParams) =>
      call<ExternalAgentConfigImportResponse>("externalAgentConfig/import", params),
    recordExternalAgentConfigHistory: (params: ExternalAgentConfigImportHistoryRecordParams) =>
      call<ExternalAgentConfigImportHistoryRecordResponse>("externalAgentConfig/import/recordHistory", params),
    readExternalAgentConfigHistories: () =>
      read<ExternalAgentConfigImportHistoriesReadResponse>("externalAgentConfig/import/readHistories"),

    startReview: (params: ReviewStartParams) =>
      call<ReviewStartResponse>("review/start", params),
    addEnvironment: (params: EnvironmentAddParams) =>
      call<EnvironmentAddResponse>("environment/add", params),
    readEnvironmentInfo: (params: EnvironmentInfoParams) =>
      call<EnvironmentInfoResponse>("environment/info", params),
    readEnvironmentStatus: (params: EnvironmentStatusParams) =>
      call<EnvironmentStatusResponse>("environment/status", params),

    enableRemoteControl: (params: RemoteControlEnableParams | null) =>
      call<RemoteControlEnableResponse>("remoteControl/enable", params),
    disableRemoteControl: (params: RemoteControlDisableParams | null) =>
      call<RemoteControlDisableResponse>("remoteControl/disable", params),
    readRemoteControlStatus: () =>
      read<RemoteControlStatusReadResponse>("remoteControl/status/read"),
    listRemoteControlClients: (params: RemoteControlClientsListParams) =>
      call<RemoteControlClientsListResponse>(
        "remoteControl/client/list",
        params,
      ),
    revokeRemoteControlClients: (params: RemoteControlClientsRevokeParams) =>
      call<RemoteControlClientsRevokeResponse>(
        "remoteControl/client/revoke",
        params,
      ),

    listModels: (params: ModelListParams) =>
      call<ModelListResponse>("model/list", params),
    readModelProviderCapabilities: (
      params: ModelProviderCapabilitiesReadParams,
    ) =>
      call<ModelProviderCapabilitiesReadResponse>(
        "modelProvider/capabilities/read",
        params,
      ),
    listExperimentalFeatures: (params: ExperimentalFeatureListParams) =>
      call<ExperimentalFeatureListResponse>("experimentalFeature/list", params),
    setExperimentalFeature: (params: ExperimentalFeatureEnablementSetParams) =>
      call<ExperimentalFeatureEnablementSetResponse>(
        "experimentalFeature/enablement/set",
        params,
      ),
    listPermissionProfiles: (params: PermissionProfileListParams) =>
      call<PermissionProfileListResponse>("permissionProfile/list", params),
    listCollaborationModes: (params: CollaborationModeListParams) =>
      call<CollaborationModeListResponse>("collaborationMode/list", params),
  };
}

export type CodexCapabilitiesClient = ReturnType<
  typeof createCodexCapabilitiesClient
>;
