import { useMemo, useState } from "react";
import { AlertTriangle, Check, LoaderCircle, RefreshCw } from "lucide-react";

import type { CodexCapabilityOperation } from "@zeros/protocol/messages";
import type { ChatThread } from "../../state/store";
import { Button, Input } from "../../shared/ui";
import { Switch } from "../../shared/ui/primitives";
import { useOpenBrowserInWorkbench } from "../../shell/workbench/use-open-browser";
import { cn } from "../../shared/ui/cn";
import { useWorkspaceStore } from "../../state/store";
import { useProjects } from "../../state/use-projects";
import { callCodexCapability } from "../agent/codex-capabilities-client";
import { SettingsEmpty, SettingsList, SettingsRow, SettingsSection } from "./settings-ui";

type CapabilityGroup = "Account" | "Extensions" | "Connections" | "Runtime";

export interface CodexPlatformCapability {
  operation: CodexCapabilityOperation;
  group: CapabilityGroup;
  label: string;
  description: string;
  params: (cwd: string, nativeThreadId?: string) => unknown;
}

export type CodexPluginRow = {
  id: string;
  name: string;
  label: string;
  installed: boolean;
  enabled: boolean;
  marketplaceName: string;
  marketplacePath: string | null;
};

export type CodexAppRow = { id: string; name: string; enabled: boolean; accessible: boolean };
export type CodexMcpRow = {
  name: string;
  authStatus: string;
  startupStatus: string;
  error: string | null;
  failureReason: string | null;
  toolCount: number;
  resourceCount: number;
  toolNames: string[];
  resourceUris: string[];
};
export type CodexAccount = {
  type: string | null;
  email: string | null;
  planType: string | null;
  credentialSource: string | null;
  requiresOpenaiAuth: boolean;
};
export type CodexAccountLogin = { loginId: string; authUrl: string };
export type CodexRemoteControlStatus = {
  status: string;
  serverName: string;
  installationId: string;
  environmentId: string | null;
};
export type CodexRemoteControlClient = {
  clientId: string;
  displayName: string | null;
  deviceType: string | null;
  platform: string | null;
  osVersion: string | null;
  deviceModel: string | null;
  appVersion: string | null;
  lastSeenAt: number | null;
};
export type CodexConfigLayerRow = { name: string; version: string; disabledReason: string | null };
export type CodexConfigSnapshot = {
  config: Record<string, unknown>;
  originCount: number;
  layers: CodexConfigLayerRow[];
};
export type CodexExternalMigrationRow = {
  id: string;
  itemType: string;
  description: string;
  cwd: string | null;
  detailCount: number;
  raw: Record<string, unknown>;
};
export type CodexExternalImportHistoryRow = {
  importId: string;
  providerId: string | null;
  completedAtMs: number | null;
  successCount: number;
  failureCount: number;
};
export type CodexExternalImportHistories = {
  histories: CodexExternalImportHistoryRow[];
  connectors: Array<{ name: string; sessionCount: number; source: string }>;
};
export type CodexRateLimitRow = {
  id: string;
  label: string;
  primaryUsedPercent: number | null;
  primaryWindowMinutes: number | null;
  primaryResetsAt: number | null;
  secondaryUsedPercent: number | null;
  secondaryWindowMinutes: number | null;
  secondaryResetsAt: number | null;
  reachedType: string | null;
};
export type CodexRateLimits = {
  buckets: CodexRateLimitRow[];
  availableResetCredits: number;
  resetCreditId: string | null;
};
export type CodexUsage = {
  lifetimeTokens: number | null;
  peakDailyTokens: number | null;
  longestRunningTurnSec: number | null;
  currentStreakDays: number | null;
  longestStreakDays: number | null;
  latestDate: string | null;
  latestTokens: number | null;
};
export type CodexWorkspaceMessage = {
  id: string;
  type: string;
  body: string;
  createdAt: number | null;
};
export type CodexExperimentRow = {
  name: string;
  label: string;
  description: string;
  stage: string;
  enabled: boolean;
  defaultEnabled: boolean;
};
export type CodexThreadSearchRow = {
  id: string;
  title: string;
  preview: string;
  cwd: string;
  snippet: string;
};
export type CodexThreadInspection = {
  threadId: string;
  title: string;
  preview: string;
  pinned: boolean;
  status: string;
  branch: string | null;
  turnCount: number;
  itemCount: number;
};
export type CodexThreadOccurrence = {
  turnId: string;
  itemId: string;
  snippet: string;
  matchStart: number;
  matchEnd: number;
  turnCursor: string;
};
export type CodexBackgroundTerminalRow = {
  processId: string;
  command: string;
  cwd: string;
  osPid: number | null;
};
export type CodexGoal = {
  objective: string;
  status: "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";
  tokenBudget: number | null;
  tokensUsed: number;
};

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export function collectCodexPlugins(result: unknown): CodexPluginRow[] {
  const marketplaces = record(result)?.marketplaces;
  if (!Array.isArray(marketplaces)) return [];
  const rows: CodexPluginRow[] = [];
  for (const rawMarketplace of marketplaces) {
    const marketplace = record(rawMarketplace);
    if (!marketplace || typeof marketplace.name !== "string" || !Array.isArray(marketplace.plugins)) continue;
    for (const rawPlugin of marketplace.plugins) {
      const plugin = record(rawPlugin);
      if (!plugin || typeof plugin.id !== "string" || typeof plugin.name !== "string") continue;
      const pluginInterface = record(plugin.interface);
      rows.push({
        id: plugin.id,
        name: plugin.name,
        label:
          typeof pluginInterface?.displayName === "string"
            ? pluginInterface.displayName
            : plugin.name,
        installed: plugin.installed === true,
        enabled: plugin.enabled !== false,
        marketplaceName: marketplace.name,
        marketplacePath: typeof marketplace.path === "string" ? marketplace.path : null,
      });
    }
  }
  return rows;
}

export function collectCodexApps(result: unknown): CodexAppRow[] {
  const data = record(result)?.data;
  if (!Array.isArray(data)) return [];
  return data.flatMap((raw) => {
    const app = record(raw);
    return app && typeof app.id === "string" && typeof app.name === "string"
      ? [{ id: app.id, name: app.name, enabled: app.isEnabled !== false, accessible: app.isAccessible === true }]
      : [];
  });
}

export function collectCodexMcpServers(result: unknown): CodexMcpRow[] {
  const data = record(result)?.data;
  if (!Array.isArray(data)) return [];
  return data.flatMap((raw) => {
    const server = record(raw);
    if (!server || typeof server.name !== "string") return [];
    const tools = record(server.tools);
    const resources = Array.isArray(server.resources) ? server.resources : [];
    return [{
      name: server.name,
      authStatus: typeof server.authStatus === "string" ? server.authStatus : "unknown",
      startupStatus: typeof server.status === "string" ? server.status : "unknown",
      error: typeof server.error === "string" ? server.error : null,
      failureReason: typeof server.failureReason === "string" ? server.failureReason : null,
      toolCount: tools ? Object.keys(tools).length : 0,
      resourceCount: resources.length,
      toolNames: tools ? Object.keys(tools).sort((a, b) => a.localeCompare(b)) : [],
      resourceUris: resources.flatMap((rawResource) => {
        const uri = record(rawResource)?.uri;
        return typeof uri === "string" ? [uri] : [];
      }),
    }];
  });
}

const boundedPreview = (value: string): string =>
  value.length > 8_000 ? `${value.slice(0, 8_000)}\n…` : value;

export function parseCodexMcpToolArguments(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value || "{}");
  } catch {
    throw new Error("MCP tool arguments must be valid JSON.");
  }
  const object = record(parsed);
  if (!object) throw new Error("MCP tool arguments must be a JSON object.");
  return object;
}

export function collectCodexMcpResourcePreview(result: unknown): string {
  const contents = record(result)?.contents;
  if (!Array.isArray(contents)) return "No resource content returned.";
  return boundedPreview(contents.flatMap((raw) => {
    const content = record(raw);
    if (!content) return [];
    if (typeof content.text === "string") return [content.text];
    if (typeof content.blob === "string") {
      return [`[Binary resource: ${typeof content.uri === "string" ? content.uri : "unknown URI"}]`];
    }
    return [];
  }).join("\n"));
}

export function collectCodexMcpToolPreview(result: unknown): string {
  const root = record(result);
  if (!root) return "No tool result returned.";
  const content = Array.isArray(root.content) ? root.content.flatMap((raw) => {
    const item = record(raw);
    return typeof item?.text === "string" ? [item.text] : [];
  }) : [];
  if (root.structuredContent !== undefined) {
    content.push(JSON.stringify(root.structuredContent));
  }
  if (root.isError === true) content.unshift("[MCP tool reported an error]");
  return boundedPreview(content.join("\n") || "Tool completed without displayable content.");
}

export function collectCodexAccount(result: unknown): CodexAccount | null {
  const root = record(result);
  if (!root || typeof root.requiresOpenaiAuth !== "boolean") return null;
  const account = record(root.account);
  return {
    type: typeof account?.type === "string" ? account.type : null,
    email: typeof account?.email === "string" ? account.email : null,
    planType: typeof account?.planType === "string" ? account.planType : null,
    credentialSource:
      typeof account?.credentialSource === "string" ? account.credentialSource : null,
    requiresOpenaiAuth: root.requiresOpenaiAuth,
  };
}

export function collectCodexAccountLogin(result: unknown): CodexAccountLogin | null {
  const login = record(result);
  return login?.type === "chatgpt" &&
    typeof login.loginId === "string" &&
    typeof login.authUrl === "string"
    ? { loginId: login.loginId, authUrl: login.authUrl }
    : null;
}

export function collectCodexRemoteControlStatus(result: unknown): CodexRemoteControlStatus | null {
  const status = record(result);
  if (
    !status ||
    typeof status.status !== "string" ||
    typeof status.serverName !== "string" ||
    typeof status.installationId !== "string"
  ) return null;
  return {
    status: status.status,
    serverName: status.serverName,
    installationId: status.installationId,
    environmentId: typeof status.environmentId === "string" ? status.environmentId : null,
  };
}

export function collectCodexRemoteControlClients(result: unknown): CodexRemoteControlClient[] {
  const data = record(result)?.data;
  if (!Array.isArray(data)) return [];
  return data.flatMap((raw) => {
    const client = record(raw);
    if (!client || typeof client.clientId !== "string") return [];
    const lastSeen = typeof client.lastSeenAt === "string"
      ? Number(client.lastSeenAt)
      : finite(client.lastSeenAt);
    const optionalString = (value: unknown) => typeof value === "string" ? value : null;
    return [{
      clientId: client.clientId,
      displayName: optionalString(client.displayName),
      deviceType: optionalString(client.deviceType),
      platform: optionalString(client.platform),
      osVersion: optionalString(client.osVersion),
      deviceModel: optionalString(client.deviceModel),
      appVersion: optionalString(client.appVersion),
      lastSeenAt: typeof lastSeen === "number" && Number.isFinite(lastSeen) ? lastSeen : null,
    }];
  });
}

export function parseCodexConfigValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("Codex config value must be valid JSON.");
  }
}

export function parseCodexConfigEdits(value: string): Array<{
  keyPath: string;
  value: unknown;
  mergeStrategy: "replace" | "upsert";
}> {
  const parsed = parseCodexConfigValue(value);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("Codex batch edits must be a non-empty JSON array.");
  }
  return parsed.map((raw, index) => {
    const edit = record(raw);
    if (!edit || typeof edit.keyPath !== "string" || !edit.keyPath.trim()) {
      throw new Error(`Codex batch edit ${index + 1} needs a keyPath.`);
    }
    if (edit.mergeStrategy !== "replace" && edit.mergeStrategy !== "upsert") {
      throw new Error(`Codex batch edit ${index + 1} mergeStrategy must be replace or upsert.`);
    }
    if (!("value" in edit)) {
      throw new Error(`Codex batch edit ${index + 1} needs a value.`);
    }
    return { keyPath: edit.keyPath, value: edit.value, mergeStrategy: edit.mergeStrategy };
  });
}

export function collectCodexConfigSnapshot(result: unknown): CodexConfigSnapshot | null {
  const root = record(result);
  const config = record(root?.config);
  if (!root || !config) return null;
  const origins = record(root.origins);
  const layers = Array.isArray(root.layers) ? root.layers : [];
  return {
    config,
    originCount: origins ? Object.keys(origins).length : 0,
    layers: layers.flatMap((raw) => {
      const layer = record(raw);
      if (!layer || typeof layer.version !== "string") return [];
      const name = typeof layer.name === "string"
        ? layer.name
        : JSON.stringify(layer.name ?? "unknown");
      return [{
        name,
        version: layer.version,
        disabledReason: typeof layer.disabledReason === "string" ? layer.disabledReason : null,
      }];
    }),
  };
}

const MIGRATION_TYPES = new Set([
  "AGENTS_MD", "CONFIG", "SKILLS", "PLUGINS", "MCP_SERVER_CONFIG",
  "SUBAGENTS", "HOOKS", "COMMANDS", "MEMORY", "SESSIONS",
]);

export function collectCodexExternalMigrationItems(result: unknown): CodexExternalMigrationRow[] {
  const items = record(result)?.items;
  if (!Array.isArray(items)) return [];
  return items.flatMap((raw, index) => {
    const item = record(raw);
    if (
      !item ||
      typeof item.itemType !== "string" ||
      !MIGRATION_TYPES.has(item.itemType) ||
      typeof item.description !== "string"
    ) return [];
    const details = record(item.details);
    const detailCount = details
      ? Object.values(details).reduce<number>(
          (total, value) => total + (Array.isArray(value) ? value.length : 0),
          0,
        )
      : 0;
    const cwd = typeof item.cwd === "string" ? item.cwd : null;
    return [{
      id: `${item.itemType}:${cwd ?? "home"}:${index}`,
      itemType: item.itemType,
      description: item.description,
      cwd,
      detailCount,
      raw: item,
    }];
  });
}

export function collectCodexExternalImportHistories(result: unknown): CodexExternalImportHistories {
  const root = record(result);
  const data = Array.isArray(root?.data) ? root.data : [];
  const connectors = Array.isArray(root?.connectors) ? root.connectors : [];
  return {
    histories: data.flatMap((raw) => {
      const history = record(raw);
      if (!history || typeof history.importId !== "string") return [];
      const completed = typeof history.completedAtMs === "string"
        ? Number(history.completedAtMs)
        : finite(history.completedAtMs);
      return [{
        importId: history.importId,
        providerId: typeof history.providerId === "string" ? history.providerId : null,
        completedAtMs: typeof completed === "number" && Number.isFinite(completed) ? completed : null,
        successCount: Array.isArray(history.successes) ? history.successes.length : 0,
        failureCount: Array.isArray(history.failures) ? history.failures.length : 0,
      }];
    }),
    connectors: connectors.flatMap((raw) => {
      const connector = record(raw);
      if (
        !connector ||
        typeof connector.name !== "string" ||
        typeof connector.sessionCount !== "number" ||
        typeof connector.source !== "string"
      ) return [];
      return [{ name: connector.name, sessionCount: connector.sessionCount, source: connector.source }];
    }),
  };
}

const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

function rateLimitRow(raw: unknown, fallbackId: string): CodexRateLimitRow | null {
  const limit = record(raw);
  if (!limit) return null;
  const primary = record(limit.primary);
  const secondary = record(limit.secondary);
  const id = typeof limit.limitId === "string" && limit.limitId ? limit.limitId : fallbackId;
  return {
    id,
    label:
      typeof limit.limitName === "string" && limit.limitName
        ? limit.limitName
        : id,
    primaryUsedPercent: finite(primary?.usedPercent),
    primaryWindowMinutes: finite(primary?.windowDurationMins),
    primaryResetsAt: finite(primary?.resetsAt),
    secondaryUsedPercent: finite(secondary?.usedPercent),
    secondaryWindowMinutes: finite(secondary?.windowDurationMins),
    secondaryResetsAt: finite(secondary?.resetsAt),
    reachedType:
      typeof limit.rateLimitReachedType === "string"
        ? limit.rateLimitReachedType
        : null,
  };
}

export function collectCodexRateLimits(result: unknown): CodexRateLimits {
  const root = record(result);
  const byId = record(root?.rateLimitsByLimitId);
  const buckets = byId
    ? Object.entries(byId).flatMap(([id, raw]) => {
        const row = rateLimitRow(raw, id);
        return row ? [row] : [];
      })
    : (() => {
        const row = rateLimitRow(root?.rateLimits, "codex");
        return row ? [row] : [];
      })();
  const credits = record(root?.rateLimitResetCredits);
  const creditRows = Array.isArray(credits?.credits) ? credits.credits : [];
  const firstCredit = creditRows.map(record).find((credit) => typeof credit?.id === "string");
  return {
    buckets,
    availableResetCredits: finite(credits?.availableCount) ?? 0,
    resetCreditId: typeof firstCredit?.id === "string" ? firstCredit.id : null,
  };
}

export function collectCodexUsage(result: unknown): CodexUsage | null {
  const root = record(result);
  const summary = record(root?.summary);
  if (!root || !summary) return null;
  const daily = Array.isArray(root.dailyUsageBuckets) ? root.dailyUsageBuckets : [];
  const latest = record(daily.at(-1));
  return {
    lifetimeTokens: finite(summary.lifetimeTokens),
    peakDailyTokens: finite(summary.peakDailyTokens),
    longestRunningTurnSec: finite(summary.longestRunningTurnSec),
    currentStreakDays: finite(summary.currentStreakDays),
    longestStreakDays: finite(summary.longestStreakDays),
    latestDate: typeof latest?.startDate === "string" ? latest.startDate : null,
    latestTokens: finite(latest?.tokens),
  };
}

export function collectCodexWorkspaceMessages(result: unknown): CodexWorkspaceMessage[] {
  const root = record(result);
  if (!root || root.featureEnabled !== true || !Array.isArray(root.messages)) return [];
  return root.messages.flatMap((raw) => {
    const message = record(raw);
    if (
      !message ||
      typeof message.messageId !== "string" ||
      typeof message.messageBody !== "string"
    ) return [];
    return [{
      id: message.messageId,
      type: typeof message.messageType === "string" ? message.messageType : "message",
      body: message.messageBody,
      createdAt: finite(message.createdAt),
    }];
  });
}

export function collectCodexExperiments(result: unknown): CodexExperimentRow[] {
  const data = record(result)?.data;
  if (!Array.isArray(data)) return [];
  return data.flatMap((raw) => {
    const feature = record(raw);
    if (!feature || typeof feature.name !== "string" || typeof feature.enabled !== "boolean") return [];
    return [{
      name: feature.name,
      label: typeof feature.displayName === "string" ? feature.displayName : feature.name,
      description: typeof feature.description === "string" ? feature.description : "Native Codex runtime feature.",
      stage: typeof feature.stage === "string" ? feature.stage : "unknown",
      enabled: feature.enabled,
      defaultEnabled: feature.defaultEnabled === true,
    }];
  });
}

export function collectCodexThreadSearchResults(result: unknown): CodexThreadSearchRow[] {
  const data = record(result)?.data;
  if (!Array.isArray(data)) return [];
  return data.flatMap((raw) => {
    const entry = record(raw);
    const thread = record(entry?.thread);
    if (!thread || typeof thread.id !== "string") return [];
    return [{
      id: thread.id,
      title:
        typeof thread.name === "string" && thread.name.trim()
          ? thread.name
          : typeof thread.preview === "string" && thread.preview.trim()
            ? thread.preview.slice(0, 80)
            : "Untitled Codex thread",
      preview: typeof thread.preview === "string" ? thread.preview : "",
      cwd: typeof thread.cwd === "string" ? thread.cwd : "",
      snippet: typeof entry?.snippet === "string" ? entry.snippet : "",
    }];
  });
}

export function collectCodexThreadInspection(
  readResult: unknown,
  turns: unknown[],
  items: unknown[],
): CodexThreadInspection | null {
  const thread = record(record(readResult)?.thread);
  if (!thread || typeof thread.id !== "string") return null;
  const status = record(thread.status);
  const gitInfo = record(thread.gitInfo);
  return {
    threadId: thread.id,
    title:
      typeof thread.name === "string" && thread.name.trim()
        ? thread.name
        : typeof thread.preview === "string" && thread.preview.trim()
          ? thread.preview.slice(0, 80)
          : "Untitled Codex thread",
    preview: typeof thread.preview === "string" ? thread.preview : "",
    pinned: thread.isPinned === true,
    status: typeof status?.type === "string" ? status.type : "unknown",
    branch: typeof gitInfo?.branch === "string" ? gitInfo.branch : null,
    turnCount: turns.length,
    itemCount: items.length,
  };
}

export function collectCodexLoadedThreadIds(result: unknown): string[] {
  const data = record(result)?.data;
  if (!Array.isArray(data)) return [];
  return [...new Set(data.filter((id): id is string => typeof id === "string" && !!id))];
}

export function collectCodexThreadOccurrences(result: unknown): CodexThreadOccurrence[] {
  const data = record(result)?.data;
  if (!Array.isArray(data)) return [];
  return data.flatMap((raw) => {
    const occurrence = record(raw);
    const range = record(occurrence?.snippetMatchRange);
    if (
      !occurrence ||
      typeof occurrence.turnId !== "string" ||
      typeof occurrence.itemId !== "string" ||
      typeof occurrence.snippet !== "string" ||
      typeof occurrence.turnCursor !== "string" ||
      typeof range?.start !== "number" ||
      typeof range?.end !== "number"
    ) return [];
    return [{
      turnId: occurrence.turnId,
      itemId: occurrence.itemId,
      snippet: occurrence.snippet,
      matchStart: range.start,
      matchEnd: range.end,
      turnCursor: occurrence.turnCursor,
    }];
  });
}

export function collectCodexBackgroundTerminals(result: unknown): CodexBackgroundTerminalRow[] {
  const data = record(result)?.data;
  if (!Array.isArray(data)) return [];
  return data.flatMap((raw) => {
    const terminal = record(raw);
    if (!terminal || typeof terminal.processId !== "string" || typeof terminal.command !== "string") return [];
    return [{
      processId: terminal.processId,
      command: terminal.command,
      cwd: typeof terminal.cwd === "string" ? terminal.cwd : "",
      osPid: typeof terminal.osPid === "number" ? terminal.osPid : null,
    }];
  });
}

export function collectCodexMarketplaceNames(result: unknown): string[] {
  const marketplaces = record(result)?.marketplaces;
  if (!Array.isArray(marketplaces)) return [];
  return [...new Set(marketplaces.flatMap((raw) => {
    const name = record(raw)?.name;
    return typeof name === "string" && name.trim() ? [name.trim()] : [];
  }))].sort((a, b) => a.localeCompare(b));
}

export function collectCodexGoal(result: unknown): CodexGoal | null {
  const goal = record(record(result)?.goal);
  const statuses = new Set<CodexGoal["status"]>([
    "active", "paused", "blocked", "usageLimited", "budgetLimited", "complete",
  ]);
  if (
    !goal ||
    typeof goal.objective !== "string" ||
    !statuses.has(goal.status as CodexGoal["status"])
  ) return null;
  return {
    objective: goal.objective,
    status: goal.status as CodexGoal["status"],
    tokenBudget: typeof goal.tokenBudget === "number" ? goal.tokenBudget : null,
    tokensUsed: typeof goal.tokensUsed === "number" ? goal.tokensUsed : 0,
  };
}

export function collectCodexForkedChat(
  result: unknown,
  source: ChatThread,
): ChatThread | null {
  const chat = record(record(result)?.zerosChat);
  if (
    !chat ||
    typeof chat.id !== "string" ||
    typeof chat.sessionId !== "string" ||
    typeof chat.nativeSessionId !== "string" ||
    typeof chat.title !== "string" ||
    typeof chat.createdAt !== "number" ||
    typeof chat.updatedAt !== "number"
  ) {
    return null;
  }
  return {
    ...source,
    id: chat.id,
    title: chat.title,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    sessionId: chat.sessionId,
    nativeSessionId: chat.nativeSessionId,
    pinned: false,
    archived: false,
    sourceChatId: undefined,
  };
}

export function getPluginMutation(plugin: CodexPluginRow): {
  operation: "plugins.install" | "plugins.uninstall";
  params: Record<string, unknown>;
} {
  return plugin.installed
    ? { operation: "plugins.uninstall", params: { pluginId: plugin.id } }
    : {
        operation: "plugins.install",
        params: {
          pluginName: plugin.name,
          marketplacePath: plugin.marketplacePath,
          remoteMarketplaceName: plugin.marketplacePath ? null : plugin.marketplaceName,
        },
      };
}

export const CODEX_PLATFORM_CAPABILITIES: CodexPlatformCapability[] = [
  {
    operation: "account.read",
    group: "Account",
    label: "Signed-in account",
    description: "Read the account and plan Codex is currently using.",
    params: () => ({ refreshToken: false }),
  },
  {
    operation: "account.usage.read",
    group: "Account",
    label: "Usage",
    description: "Read current Codex usage and plan allowances.",
    params: () => undefined,
  },
  {
    operation: "account.rateLimits.read",
    group: "Account",
    label: "Rate limits",
    description: "Read active request windows and reset times.",
    params: () => undefined,
  },
  {
    operation: "account.workspaceMessages.read",
    group: "Account",
    label: "Workspace messages",
    description: "Read active notices from the signed-in ChatGPT workspace.",
    params: () => undefined,
  },
  {
    operation: "plugins.list",
    group: "Extensions",
    label: "Plugins",
    description: "Discover official, personal, and repository plugins.",
    params: (cwd) => ({ cwds: [cwd], forceRefetch: false }),
  },
  {
    operation: "apps.list",
    group: "Extensions",
    label: "Apps and connectors",
    description: "Read the apps available to the active Codex thread.",
    params: (_cwd, threadId) => ({ threadId: threadId ?? null, limit: 100 }),
  },
  {
    operation: "skills.list",
    group: "Extensions",
    label: "Skills",
    description: "Scan enabled user, repository, plugin, and bundled skills.",
    params: (cwd) => ({ cwds: [cwd], forceReload: true }),
  },
  {
    operation: "mcp.status.list",
    group: "Connections",
    label: "MCP servers",
    description: "Inspect startup, OAuth, tools, resources, and failure state.",
    params: (_cwd, threadId) => ({ threadId: threadId ?? null, limit: 100 }),
  },
  {
    operation: "remoteControl.status.read",
    group: "Connections",
    label: "Codex remote control",
    description: "Read Codex-native remote-control availability and status.",
    params: () => undefined,
  },
  {
    operation: "models.list",
    group: "Runtime",
    label: "Models",
    description: "Read the live Codex model catalog, including hidden entries.",
    params: () => ({ includeHidden: true, limit: 100 }),
  },
  {
    operation: "collaborationModes.list",
    group: "Runtime",
    label: "Collaboration modes",
    description: "Read native multi-agent collaboration presets.",
    params: () => ({}),
  },
  {
    operation: "permissionProfiles.list",
    group: "Runtime",
    label: "Permission profiles",
    description: "Read project-aware native permission profiles.",
    params: (cwd) => ({ cwd, limit: 100 }),
  },
  {
    operation: "experimental.list",
    group: "Runtime",
    label: "Experimental features",
    description: "Read Codex feature flags effective for this thread.",
    params: (_cwd, threadId) => ({ threadId: threadId ?? null, limit: 100 }),
  },
  {
    operation: "hooks.list",
    group: "Runtime",
    label: "Hooks",
    description: "Read hooks loaded from user and repository configuration.",
    params: (cwd) => ({ cwds: [cwd] }),
  },
];

export function summarizeCapabilityResult(result: unknown): string {
  if (result == null) return "No data returned";
  if (typeof result === "boolean") return result ? "Enabled" : "Disabled";
  if (Array.isArray(result)) return `${result.length} ${result.length === 1 ? "item" : "items"}`;
  if (typeof result !== "object") return String(result);
  const value = result as Record<string, unknown>;
  if (value.account && typeof value.account === "object") return "Account available";
  if (typeof value.enabled === "boolean") return value.enabled ? "Enabled" : "Disabled";
  for (const key of ["data", "items", "plugins", "apps", "skills", "models", "profiles", "modes", "servers"]) {
    const collection = value[key];
    if (Array.isArray(collection)) {
      return `${collection.length} ${collection.length === 1 ? "item" : "items"}`;
    }
  }
  const scalar = Object.values(value).find(
    (entry) => typeof entry === "string" || typeof entry === "number",
  );
  return scalar == null ? "Available" : String(scalar);
}

type LoadState = {
  status: "idle" | "loading" | "ready" | "error";
  summary?: string;
  error?: string;
  result?: unknown;
};

export function CodexPlatformPanel({ surfaceActive = true }: { surfaceActive?: boolean }) {
  const openBrowser = useOpenBrowserInWorkbench();
  const { projects } = useProjects();
  const activeChatId = useWorkspaceStore((state) => state.activeChatId);
  const chats = useWorkspaceStore((state) => state.chats);
  const dispatch = useWorkspaceStore((state) => state.dispatch);
  const activeChat = chats.find((chat) => chat.id === activeChatId);
  const codexChat =
    activeChat?.agentId === "codex"
      ? activeChat
      : chats.find((chat) => chat.agentId === "codex" && !!chat.folder);
  const cwd = codexChat?.folder || projects[0]?.repoRoot || "";
  const [states, setStates] = useState<Partial<Record<CodexCapabilityOperation, LoadState>>>({});
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [threadSearch, setThreadSearch] = useState("");
  const [threadResults, setThreadResults] = useState<CodexThreadSearchRow[]>([]);
  const [threadInspection, setThreadInspection] = useState<CodexThreadInspection | null>(null);
  const [loadedThreadIds, setLoadedThreadIds] = useState<string[]>([]);
  const [threadOccurrences, setThreadOccurrences] = useState<CodexThreadOccurrence[]>([]);
  const [backgroundTerminals, setBackgroundTerminals] = useState<CodexBackgroundTerminalRow[]>([]);
  const [workflowMessage, setWorkflowMessage] = useState<string | null>(null);
  const [memoryMode, setMemoryMode] = useState<"enabled" | "disabled" | null>(null);
  const [confirmMemoryReset, setConfirmMemoryReset] = useState(false);
  const [goalObjective, setGoalObjective] = useState("");
  const [goalStatus, setGoalStatus] = useState<CodexGoal["status"]>("active");
  const [goalBudget, setGoalBudget] = useState("");
  const [marketplaceSource, setMarketplaceSource] = useState("");
  const [confirmMarketplaceRemoval, setConfirmMarketplaceRemoval] = useState<string | null>(null);
  const [confirmAccountLogout, setConfirmAccountLogout] = useState(false);
  const [confirmRateLimitReset, setConfirmRateLimitReset] = useState(false);
  const [confirmCreditsNudge, setConfirmCreditsNudge] = useState(false);
  const [mcpServerName, setMcpServerName] = useState("");
  const [mcpResourceUri, setMcpResourceUri] = useState("");
  const [mcpToolName, setMcpToolName] = useState("");
  const [mcpToolArguments, setMcpToolArguments] = useState("{}");
  const [mcpResult, setMcpResult] = useState<string | null>(null);
  const [confirmMcpToolCall, setConfirmMcpToolCall] = useState(false);
  const [accountLoginId, setAccountLoginId] = useState<string | null>(null);
  const [remoteClients, setRemoteClients] = useState<CodexRemoteControlClient[]>([]);
  const [confirmRemoteRevoke, setConfirmRemoteRevoke] = useState<string | null>(null);

  const groups = useMemo(
    () =>
      (["Account", "Extensions", "Connections", "Runtime"] as const).map((group) => ({
        group,
        capabilities: CODEX_PLATFORM_CAPABILITIES.filter((item) => item.group === group),
      })),
    [],
  );

  const call = async (operation: CodexCapabilityOperation, params: unknown) =>
    callCodexCapability({
      operation,
      cwd,
      sessionId: codexChat?.sessionId,
      params,
    });

  const load = async (capability: CodexPlatformCapability) => {
    if (!cwd || !surfaceActive) return;
    setStates((current) => ({
      ...current,
      [capability.operation]: { status: "loading" },
    }));
    try {
      const result = await call(
        capability.operation,
        capability.params(cwd, codexChat?.nativeSessionId),
      );
      if (capability.operation === "account.read" && collectCodexAccount(result)?.type) {
        setAccountLoginId(null);
      }
      setStates((current) => ({
        ...current,
        [capability.operation]: {
          status: "ready",
          summary: summarizeCapabilityResult(result),
          result,
        },
      }));
    } catch (error) {
      setStates((current) => ({
        ...current,
        [capability.operation]: {
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        },
      }));
    }
  };

  const refresh = async (operation: CodexCapabilityOperation) => {
    const capability = CODEX_PLATFORM_CAPABILITIES.find((item) => item.operation === operation);
    if (capability) await load(capability);
  };

  const mutate = async (
    actionKey: string,
    operation: CodexCapabilityOperation,
    params: unknown,
    refreshOperations: CodexCapabilityOperation[],
  ) => {
    if (!surfaceActive || busyAction) return;
    setBusyAction(actionKey);
    try {
      await call(operation, params);
      for (const refreshOperation of refreshOperations) await refresh(refreshOperation);
    } catch (error) {
      setStates((current) => ({
        ...current,
        [operation]: {
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        },
      }));
    } finally {
      setBusyAction(null);
    }
  };

  const plugins = collectCodexPlugins(states["plugins.list"]?.result);
  const apps = collectCodexApps(states["apps.list"]?.result);
  const mcpServers = collectCodexMcpServers(states["mcp.status.list"]?.result);
  const account = collectCodexAccount(states["account.read"]?.result);
  const rateLimits = collectCodexRateLimits(states["account.rateLimits.read"]?.result);
  const usage = collectCodexUsage(states["account.usage.read"]?.result);
  const workspaceMessages = collectCodexWorkspaceMessages(
    states["account.workspaceMessages.read"]?.result,
  );
  const experiments = collectCodexExperiments(states["experimental.list"]?.result);
  const remoteStatus = collectCodexRemoteControlStatus(states["remoteControl.status.read"]?.result);
  const remoteEnabled = remoteStatus?.status !== "disabled" && typeof remoteStatus?.status === "string";
  const nativeThreadId = codexChat?.nativeSessionId;
  const marketplaceNames = collectCodexMarketplaceNames(states["plugins.list"]?.result);
  const isWindows = typeof navigator !== "undefined" && /Win/i.test(navigator.platform);

  const runWorkflow = async (
    actionKey: string,
    operation: CodexCapabilityOperation,
    params: unknown,
    success: string,
    after?: (result: unknown) => void,
  ) => {
    if (busyAction || !surfaceActive) return;
    setBusyAction(actionKey);
    setWorkflowMessage(null);
    try {
      const result = await call(operation, params);
      after?.(result);
      setWorkflowMessage(success);
    } catch (error) {
      setWorkflowMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction(null);
    }
  };

  const refreshAccount = async () => {
    for (const operation of [
      "account.read",
      "account.rateLimits.read",
      "account.usage.read",
      "account.workspaceMessages.read",
    ] as const) {
      await refresh(operation);
    }
  };

  const startAccountLogin = async () => {
    if (busyAction || !surfaceActive) return;
    setBusyAction("account:login");
    setWorkflowMessage(null);
    try {
      const login = collectCodexAccountLogin(await call("account.login.start", {
        type: "chatgpt",
        useHostedLoginSuccessPage: true,
        appBrand: "codex",
      }));
      if (!login) {
        throw new Error("Codex did not return a sign-in URL.");
      }
      setAccountLoginId(login.loginId);
      openBrowser({ url: login.authUrl, title: "Sign in to Codex" });
      setWorkflowMessage("Complete sign-in in the Browser, then refresh the account status.");
    } catch (error) {
      setWorkflowMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction(null);
    }
  };

  const cancelAccountLogin = async () => {
    if (!accountLoginId) return;
    await runWorkflow(
      "account:login-cancel",
      "account.login.cancel",
      { loginId: accountLoginId },
      "Cancelled the pending Codex sign-in.",
      () => setAccountLoginId(null),
    );
  };

  const searchNativeThreads = async () => {
    const searchTerm = threadSearch.trim();
    if (!searchTerm || busyAction) return;
    setBusyAction("thread:search");
    setWorkflowMessage(null);
    try {
      const result = await call("thread.search", { searchTerm, limit: 25 });
      setThreadResults(collectCodexThreadSearchResults(result));
    } catch (error) {
      setWorkflowMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction(null);
    }
  };

  const loadAllNativeHistory = async (
    operation: "thread.turns.list" | "thread.items.list",
    threadId: string,
  ): Promise<unknown[]> => {
    const rows: unknown[] = [];
    let cursor: string | null = null;
    // The protocol cursor is opaque. Bound page count protects the settings
    // surface from a corrupt server that repeats a cursor forever.
    for (let page = 0; page < 100; page += 1) {
      const result = record(await call(operation, {
        threadId,
        cursor,
        limit: 100,
        sortDirection: operation === "thread.turns.list" ? "desc" : "asc",
        ...(operation === "thread.turns.list" ? { itemsView: "summary" } : {}),
      }));
      if (Array.isArray(result?.data)) rows.push(...result.data);
      const next = typeof result?.nextCursor === "string" ? result.nextCursor : null;
      if (!next || next === cursor) break;
      cursor = next;
    }
    return rows;
  };

  const inspectNativeThread = async (threadId: string) => {
    if (!threadId || busyAction) return;
    setBusyAction(`thread:inspect:${threadId}`);
    setWorkflowMessage(null);
    try {
      const read = await call("thread.read", { threadId, includeTurns: false });
      const [turns, items] = await Promise.all([
        loadAllNativeHistory("thread.turns.list", threadId),
        loadAllNativeHistory("thread.items.list", threadId),
      ]);
      const inspection = collectCodexThreadInspection(read, turns, items);
      if (!inspection) throw new Error("Codex returned an invalid thread history.");
      setThreadInspection(inspection);
      setThreadOccurrences([]);
      setWorkflowMessage(`Loaded complete native history for ${inspection.title}.`);
    } catch (error) {
      setWorkflowMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction(null);
    }
  };

  const loadLoadedNativeThreads = async () => {
    if (busyAction) return;
    setBusyAction("thread:loaded");
    setWorkflowMessage(null);
    try {
      const ids: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 100; page += 1) {
        const result = record(await call("thread.loaded.list", { cursor, limit: 100 }));
        ids.push(...collectCodexLoadedThreadIds(result));
        const next = typeof result?.nextCursor === "string" ? result.nextCursor : null;
        if (!next || next === cursor) break;
        cursor = next;
      }
      setLoadedThreadIds([...new Set(ids)]);
      setWorkflowMessage(`Found ${new Set(ids).size} loaded native Codex task${new Set(ids).size === 1 ? "" : "s"}.`);
    } catch (error) {
      setWorkflowMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction(null);
    }
  };

  const searchNativeThreadOccurrences = async (threadId: string) => {
    const searchTerm = threadSearch.trim();
    if (!threadId || !searchTerm || busyAction) return;
    setBusyAction(`thread:occurrences:${threadId}`);
    setWorkflowMessage(null);
    try {
      const rows: CodexThreadOccurrence[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 100; page += 1) {
        const result = record(await call("thread.searchOccurrences", {
          threadId,
          searchTerm,
          cursor,
          limit: 100,
        }));
        rows.push(...collectCodexThreadOccurrences(result));
        const next = typeof result?.nextCursor === "string" ? result.nextCursor : null;
        if (!next || next === cursor) break;
        cursor = next;
      }
      setThreadOccurrences(rows);
      setWorkflowMessage(`Found ${rows.length} occurrence${rows.length === 1 ? "" : "s"} in ${threadInspection?.title ?? threadId}.`);
    } catch (error) {
      setWorkflowMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction(null);
    }
  };

  const loadBackgroundTerminals = async () => {
    if (!nativeThreadId || busyAction) return;
    setBusyAction("terminal:list");
    setWorkflowMessage(null);
    try {
      const result = await call("thread.backgroundTerminals.list", {
        threadId: nativeThreadId,
        limit: 100,
      });
      setBackgroundTerminals(collectCodexBackgroundTerminals(result));
    } catch (error) {
      setWorkflowMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction(null);
    }
  };

  const startNativeReview = async () => {
    if (!nativeThreadId || busyAction) return;
    setBusyAction("review:start");
    setWorkflowMessage(null);
    try {
      await call("review.start", {
        threadId: nativeThreadId,
        delivery: "inline",
        target: { type: "uncommittedChanges" },
      });
      setWorkflowMessage("Review started in the active Codex task.");
    } catch (error) {
      setWorkflowMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction(null);
    }
  };

  const selectMcpServer = (server: CodexMcpRow) => {
    setMcpServerName(server.name);
    setMcpResourceUri(server.resourceUris[0] ?? "");
    setMcpToolName(server.toolNames[0] ?? "");
    setMcpToolArguments("{}");
    setMcpResult(null);
    setConfirmMcpToolCall(false);
  };

  const readMcpResource = async () => {
    const server = mcpServerName.trim();
    const uri = mcpResourceUri.trim();
    if (!server || !uri) return;
    await runWorkflow(
      `mcp:resource:${server}`,
      "mcp.resource.read",
      { threadId: nativeThreadId ?? null, server, uri },
      `Read ${uri} from ${server}.`,
      (result) => setMcpResult(collectCodexMcpResourcePreview(result)),
    );
  };

  const callMcpTool = async () => {
    const server = mcpServerName.trim();
    const tool = mcpToolName.trim();
    if (!server || !tool || !nativeThreadId) return;
    let args: Record<string, unknown>;
    try {
      args = parseCodexMcpToolArguments(mcpToolArguments);
    } catch (error) {
      setWorkflowMessage(error instanceof Error ? error.message : String(error));
      return;
    }
    await runWorkflow(
      `mcp:tool:${server}:${tool}`,
      "mcp.tool.call",
      { threadId: nativeThreadId, server, tool, arguments: args },
      `Called ${server}.${tool}.`,
      (result) => {
        setMcpResult(collectCodexMcpToolPreview(result));
        setConfirmMcpToolCall(false);
      },
    );
  };

  const loadRemoteClients = async () => {
    const environmentId = remoteStatus?.environmentId;
    if (!environmentId || busyAction) return;
    setBusyAction("remote:clients");
    setWorkflowMessage(null);
    try {
      const rows: CodexRemoteControlClient[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 100; page += 1) {
        const result = record(await call("remoteControl.clients.list", {
          environmentId,
          cursor,
          limit: 100,
          order: "desc",
        }));
        rows.push(...collectCodexRemoteControlClients(result));
        const next = typeof result?.nextCursor === "string" ? result.nextCursor : null;
        if (!next || next === cursor) break;
        cursor = next;
      }
      setRemoteClients(rows);
      setWorkflowMessage(`Found ${rows.length} remote-control client${rows.length === 1 ? "" : "s"}.`);
    } catch (error) {
      setWorkflowMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction(null);
    }
  };

  const forkNativeThread = async () => {
    if (!codexChat?.sessionId || !nativeThreadId || busyAction) return;
    setBusyAction("thread:fork");
    setWorkflowMessage(null);
    try {
      const result = await call("thread.fork", {
        threadId: nativeThreadId,
        excludeTurns: false,
        deferGoalContinuation: true,
      });
      const forked = collectCodexForkedChat(result, codexChat);
      if (!forked) throw new Error("Codex returned an invalid forked chat binding.");
      // DB_CHANGED may merge the engine-created row before this response lands.
      // MERGE_CHATS is idempotent, unlike ADD_CHAT, so the fork can never appear
      // twice in the tab strip under either message ordering.
      dispatch({ type: "MERGE_CHATS", chats: [forked] });
      dispatch({ type: "SET_ACTIVE_CHAT", id: forked.id });
      setWorkflowMessage("Forked the active Codex task into a new Zeros chat.");
    } catch (error) {
      setWorkflowMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction(null);
    }
  };

  if (!cwd) {
    return (
      <SettingsEmpty
        title="Open or add a project first"
        hint="Codex resolves skills, plugins, permissions, and experiments against a project directory."
      />
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="bg-bg1-highlight grid grid-cols-4 overflow-hidden rounded-lg">
        {groups.map(({ group, capabilities }) => (
          <div key={group} className="border-border1 border-r px-3 py-2.5 last:border-r-0">
            <div className="text-fg1 text-[13px] font-medium">{group}</div>
            <div className="text-fg2 mt-0.5 text-xs">{capabilities.length} surfaces</div>
          </div>
        ))}
      </div>

      <SettingsSection
        title="Threads and review"
        description="Search native Codex history and manage the active task without importing an unrelated thread into this workspace."
      >
        <SettingsList>
          <SettingsRow
            label="Loaded native tasks"
            hint="Lists Codex tasks currently resident in the native app-server runtime."
          >
            <Button
              variant="ghost"
              size="sm"
              disabled={!surfaceActive || busyAction !== null}
              onClick={() => void loadLoadedNativeThreads()}
            >
              {busyAction === "thread:loaded" ? "Loading…" : "Check"}
            </Button>
          </SettingsRow>
          {loadedThreadIds.map((threadId) => (
            <SettingsRow key={`loaded:${threadId}`} label={threadId} hint="Loaded in the native Codex runtime">
              <Button variant="ghost" size="sm" disabled={busyAction !== null} onClick={() => void inspectNativeThread(threadId)}>
                {busyAction === `thread:inspect:${threadId}` ? "Loading…" : "Inspect"}
              </Button>
            </SettingsRow>
          ))}
          <SettingsRow
            label="Search Codex history"
            hint="Searches visible user and assistant text in native Codex threads."
          >
            <div className="flex min-w-80 items-center gap-2">
              <Input
                value={threadSearch}
                onChange={(event) => setThreadSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void searchNativeThreads();
                }}
                placeholder="Search threads"
                aria-label="Search native Codex threads"
              />
              <Button
                variant="ghost"
                size="sm"
                disabled={!surfaceActive || !threadSearch.trim() || busyAction !== null}
                onClick={() => void searchNativeThreads()}
              >
                {busyAction === "thread:search" ? "Searching…" : "Search"}
              </Button>
            </div>
          </SettingsRow>
          {threadResults.map((thread) => (
            <SettingsRow
              key={thread.id}
              label={thread.title}
              hint={`${thread.snippet || thread.preview || "No preview"}${thread.cwd ? ` · ${thread.cwd}` : ""}`}
            >
              <div className="flex items-center gap-2">
                <span className="text-fg2 max-w-32 truncate font-mono text-[11px]">{thread.id}</span>
                <Button variant="ghost" size="sm" disabled={busyAction !== null} onClick={() => void inspectNativeThread(thread.id)}>
                  {busyAction === `thread:inspect:${thread.id}` ? "Loading…" : "Inspect"}
                </Button>
              </div>
            </SettingsRow>
          ))}
          {threadInspection && (
            <SettingsRow
              label={threadInspection.title}
              hint={`${threadInspection.status} · ${threadInspection.turnCount} turns · ${threadInspection.itemCount} items${threadInspection.branch ? ` · ${threadInspection.branch}` : ""}`}
            >
              <div className="flex items-center gap-2">
                <span className="text-fg2 text-xs">{threadInspection.pinned ? "Pinned" : "Not pinned"}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!threadSearch.trim() || busyAction !== null}
                  onClick={() => void searchNativeThreadOccurrences(threadInspection.threadId)}
                >
                  {busyAction === `thread:occurrences:${threadInspection.threadId}` ? "Searching…" : "Find matches"}
                </Button>
              </div>
            </SettingsRow>
          )}
          {threadOccurrences.map((occurrence) => (
            <SettingsRow
              key={`${occurrence.turnId}:${occurrence.itemId}:${occurrence.matchStart}`}
              label={occurrence.snippet}
              hint={`Turn ${occurrence.turnId} · item ${occurrence.itemId}`}
            >
              <span className="text-fg2 font-mono text-[11px]">{occurrence.matchStart}–{occurrence.matchEnd}</span>
            </SettingsRow>
          ))}
          <SettingsRow
            label="Fork active task"
            hint={nativeThreadId ? "Creates a native Codex fork and its matching Zeros chat as one workflow." : "Open a resumed Codex task to fork it."}
          >
            <Button
              variant="ghost"
              size="sm"
              disabled={!surfaceActive || !codexChat?.sessionId || !nativeThreadId || busyAction !== null}
              onClick={() => void forkNativeThread()}
            >
              {busyAction === "thread:fork" ? "Forking…" : "Fork"}
            </Button>
          </SettingsRow>
          <SettingsRow
            label="Review uncommitted changes"
            hint={nativeThreadId ? "Starts Codex's native inline review in the active task." : "Open a resumed Codex task to start a native review."}
          >
            <Button
              variant="ghost"
              size="sm"
              disabled={!surfaceActive || !nativeThreadId || busyAction !== null}
              onClick={() => void startNativeReview()}
            >
              {busyAction === "review:start" ? "Starting…" : "Start review"}
            </Button>
          </SettingsRow>
          <SettingsRow
            label="Background terminals"
            hint={nativeThreadId ? "Reads processes owned by the active native Codex task." : "Open a Codex task to inspect its processes."}
          >
            <Button
              variant="ghost"
              size="sm"
              disabled={!surfaceActive || !nativeThreadId || busyAction !== null}
              onClick={() => void loadBackgroundTerminals()}
            >
              {busyAction === "terminal:list" ? "Loading…" : "Check"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!surfaceActive || !nativeThreadId || busyAction !== null}
              onClick={() => void runWorkflow(
                "terminal:clean",
                "thread.backgroundTerminals.clean",
                { threadId: nativeThreadId },
                "Cleaned completed background terminals.",
                () => void loadBackgroundTerminals(),
              )}
            >
              {busyAction === "terminal:clean" ? "Cleaning…" : "Clean finished"}
            </Button>
          </SettingsRow>
          {backgroundTerminals.map((terminal) => {
            const actionKey = `terminal:${terminal.processId}`;
            return (
              <SettingsRow
                key={terminal.processId}
                label={terminal.command}
                hint={`${terminal.cwd || "Unknown directory"}${terminal.osPid ? ` · PID ${terminal.osPid}` : ""}`}
              >
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!surfaceActive || busyAction !== null || !nativeThreadId}
                  onClick={() =>
                    void mutate(
                      actionKey,
                      "thread.backgroundTerminals.terminate",
                      { threadId: nativeThreadId, processId: terminal.processId },
                      [],
                    ).then(() => loadBackgroundTerminals())
                  }
                >
                  {busyAction === actionKey ? "Stopping…" : "Stop"}
                </Button>
              </SettingsRow>
            );
          })}
        </SettingsList>
        {workflowMessage && <p className="text-fg2 text-xs">{workflowMessage}</p>}
      </SettingsSection>

      <SettingsSection
        title="Task memory and goal"
        description="Control Codex memory and the durable goal attached to the active native task."
      >
        <SettingsList>
          <SettingsRow
            label="Task memory"
            hint={nativeThreadId ? `Native task memory${memoryMode ? ` is ${memoryMode}` : " has not been changed in this session"}.` : "Open a resumed Codex task first."}
          >
            <Button
              variant="ghost"
              size="sm"
              disabled={!surfaceActive || !nativeThreadId || busyAction !== null}
              onClick={() => {
                if (!nativeThreadId) return;
                const mode = memoryMode === "enabled" ? "disabled" : "enabled";
                void runWorkflow(
                  "memory:mode",
                  "thread.memoryMode.set",
                  { threadId: nativeThreadId, mode },
                  `Task memory ${mode}.`,
                  () => setMemoryMode(mode),
                );
              }}
            >
              {busyAction === "memory:mode" ? "Updating…" : memoryMode === "enabled" ? "Disable" : "Enable"}
            </Button>
          </SettingsRow>
          <SettingsRow
            label="Reset all Codex memory"
            hint="Deletes Codex memory globally. This does not delete task transcripts."
          >
            {confirmMemoryReset ? (
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => setConfirmMemoryReset(false)}>Cancel</Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!surfaceActive || busyAction !== null}
                  className="text-red-primary"
                  onClick={() => void runWorkflow(
                    "memory:reset",
                    "memory.reset",
                    undefined,
                    "All Codex memory was reset.",
                    () => setConfirmMemoryReset(false),
                  )}
                >
                  {busyAction === "memory:reset" ? "Resetting…" : "Confirm reset"}
                </Button>
              </div>
            ) : (
              <Button variant="ghost" size="sm" disabled={!surfaceActive || busyAction !== null} onClick={() => setConfirmMemoryReset(true)}>Reset…</Button>
            )}
          </SettingsRow>
          <SettingsRow label="Task goal" hint="Objective, lifecycle status, and optional token budget are stored by Codex.">
            <div className="flex min-w-96 flex-wrap items-center justify-end gap-2">
              <Input value={goalObjective} onChange={(event) => setGoalObjective(event.target.value)} placeholder="Objective" aria-label="Codex task goal objective" />
              <select className="border-border1 bg-bg1 text-fg1 h-8 rounded-md border px-2 text-xs" value={goalStatus} onChange={(event) => setGoalStatus(event.target.value as CodexGoal["status"])} aria-label="Codex task goal status">
                {(["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"] as const).map((status) => <option key={status} value={status}>{status}</option>)}
              </select>
              <Input value={goalBudget} onChange={(event) => setGoalBudget(event.target.value.replace(/\D/g, ""))} placeholder="Token budget" aria-label="Codex task goal token budget" />
              <Button
                variant="ghost"
                size="sm"
                disabled={!surfaceActive || !nativeThreadId || !goalObjective.trim() || busyAction !== null}
                onClick={() => {
                  if (!nativeThreadId) return;
                  void runWorkflow("goal:set", "thread.goal.set", {
                    threadId: nativeThreadId,
                    objective: goalObjective.trim(),
                    status: goalStatus,
                    tokenBudget: goalBudget ? Number(goalBudget) : null,
                  }, "Task goal saved.");
                }}
              >{busyAction === "goal:set" ? "Saving…" : "Save"}</Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={!surfaceActive || !nativeThreadId || busyAction !== null}
                onClick={() => {
                  if (!nativeThreadId) return;
                  void runWorkflow("goal:get", "thread.goal.get", { threadId: nativeThreadId }, "Task goal loaded.", (result) => {
                    const goal = collectCodexGoal(result);
                    setGoalObjective(goal?.objective ?? "");
                    setGoalStatus(goal?.status ?? "active");
                    setGoalBudget(goal?.tokenBudget == null ? "" : String(goal.tokenBudget));
                  });
                }}
              >{busyAction === "goal:get" ? "Loading…" : "Load"}</Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={!surfaceActive || !nativeThreadId || busyAction !== null}
                onClick={() => {
                  if (!nativeThreadId) return;
                  void runWorkflow("goal:clear", "thread.goal.clear", { threadId: nativeThreadId }, "Task goal cleared.", () => {
                    setGoalObjective(""); setGoalStatus("active"); setGoalBudget("");
                  });
                }}
              >{busyAction === "goal:clear" ? "Clearing…" : "Clear"}</Button>
            </div>
          </SettingsRow>
        </SettingsList>
      </SettingsSection>

      <SettingsSection title="Plugin marketplaces" description="Add, refresh, or remove native Codex plugin catalogs.">
        <SettingsList>
          <SettingsRow label="Add marketplace" hint="Use a Git URL or local marketplace source supported by Codex.">
            <div className="flex min-w-80 items-center gap-2">
              <Input value={marketplaceSource} onChange={(event) => setMarketplaceSource(event.target.value)} placeholder="Marketplace source" aria-label="Codex marketplace source" />
              <Button variant="ghost" size="sm" disabled={!surfaceActive || !marketplaceSource.trim() || busyAction !== null} onClick={() => void runWorkflow("marketplace:add", "marketplaces.add", { source: marketplaceSource.trim() }, "Marketplace added.", () => { setMarketplaceSource(""); void refresh("plugins.list"); })}>{busyAction === "marketplace:add" ? "Adding…" : "Add"}</Button>
              <Button variant="ghost" size="sm" disabled={!surfaceActive || busyAction !== null} onClick={() => void runWorkflow("marketplace:upgrade", "marketplaces.upgrade", {}, "Marketplaces upgraded.", () => void refresh("plugins.list"))}>{busyAction === "marketplace:upgrade" ? "Updating…" : "Upgrade all"}</Button>
            </div>
          </SettingsRow>
          {marketplaceNames.map((name) => (
            <SettingsRow key={name} label={name} hint="Native Codex plugin marketplace.">
              {confirmMarketplaceRemoval === name ? (
                <div className="flex items-center gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setConfirmMarketplaceRemoval(null)}>Cancel</Button>
                  <Button variant="ghost" size="sm" className="text-red-primary" disabled={busyAction !== null} onClick={() => void runWorkflow(`marketplace:remove:${name}`, "marketplaces.remove", { marketplaceName: name }, `Removed ${name}.`, () => { setConfirmMarketplaceRemoval(null); void refresh("plugins.list"); })}>{busyAction === `marketplace:remove:${name}` ? "Removing…" : "Confirm remove"}</Button>
                </div>
              ) : <Button variant="ghost" size="sm" disabled={!surfaceActive || busyAction !== null} onClick={() => setConfirmMarketplaceRemoval(name)}>Remove…</Button>}
            </SettingsRow>
          ))}
        </SettingsList>
      </SettingsSection>

      <SettingsSection
        title="Codex account"
        description="Manage the native Codex sign-in and inspect live workspace allowances without exposing credentials to the renderer."
      >
        <SettingsList>
          <SettingsRow
            label={account?.email ?? (account?.type ? `${account.type} account` : "Not signed in")}
            hint={account
              ? `${account.planType ?? "Unknown plan"}${account.credentialSource ? ` · ${account.credentialSource}` : ""}`
              : "Check the account to load current authentication state."}
          >
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" disabled={!surfaceActive || busyAction !== null} onClick={() => void refreshAccount()}>
                Refresh
              </Button>
              {account?.type ? (
                confirmAccountLogout ? (
                  <>
                    <Button variant="ghost" size="sm" onClick={() => setConfirmAccountLogout(false)}>Cancel</Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-red-primary"
                      disabled={busyAction !== null}
                      onClick={() => void runWorkflow("account:logout", "account.logout", undefined, "Signed out of Codex.", () => {
                        setConfirmAccountLogout(false);
                        void refreshAccount();
                      })}
                    >
                      {busyAction === "account:logout" ? "Signing out…" : "Confirm sign out"}
                    </Button>
                  </>
                ) : (
                  <Button variant="ghost" size="sm" disabled={busyAction !== null} onClick={() => setConfirmAccountLogout(true)}>Sign out…</Button>
                )
              ) : (
                accountLoginId ? (
                  <Button variant="ghost" size="sm" disabled={busyAction !== null} onClick={() => void cancelAccountLogin()}>
                    {busyAction === "account:login-cancel" ? "Cancelling…" : "Cancel sign-in"}
                  </Button>
                ) : (
                  <Button variant="ghost" size="sm" disabled={busyAction !== null} onClick={() => void startAccountLogin()}>
                    {busyAction === "account:login" ? "Opening…" : "Sign in"}
                  </Button>
                )
              )}
            </div>
          </SettingsRow>
          {usage && (
            <SettingsRow
              label="Token activity"
              hint={`${usage.lifetimeTokens?.toLocaleString() ?? "Unknown"} lifetime tokens · ${usage.currentStreakDays ?? 0} day streak${usage.latestDate ? ` · ${usage.latestTokens?.toLocaleString() ?? 0} on ${usage.latestDate}` : ""}`}
            >
              <span className="text-fg2 text-xs">Peak {usage.peakDailyTokens?.toLocaleString() ?? "—"}/day</span>
            </SettingsRow>
          )}
          {rateLimits.buckets.map((limit) => (
            <SettingsRow
              key={limit.id}
              label={limit.label}
              hint={`${limit.primaryUsedPercent ?? 0}% used${limit.primaryWindowMinutes ? ` in ${limit.primaryWindowMinutes} min` : ""}${limit.reachedType ? ` · ${limit.reachedType}` : ""}`}
            >
              <span className="text-fg2 text-xs">
                {limit.primaryResetsAt ? `Resets ${new Date(limit.primaryResetsAt * 1_000).toLocaleString()}` : "No reset time"}
              </span>
            </SettingsRow>
          ))}
          {rateLimits.availableResetCredits > 0 && (
            <SettingsRow label="Rate-limit reset" hint={`${rateLimits.availableResetCredits} earned reset credit${rateLimits.availableResetCredits === 1 ? "" : "s"} available.`}>
              {confirmRateLimitReset ? (
                <div className="flex items-center gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setConfirmRateLimitReset(false)}>Cancel</Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busyAction !== null}
                    onClick={() => void runWorkflow("account:reset-limit", "account.rateLimitResetCredit.consume", {
                      idempotencyKey: crypto.randomUUID(),
                      ...(rateLimits.resetCreditId ? { creditId: rateLimits.resetCreditId } : {}),
                    }, "Rate-limit reset requested.", () => {
                      setConfirmRateLimitReset(false);
                      void refresh("account.rateLimits.read");
                    })}
                  >
                    {busyAction === "account:reset-limit" ? "Resetting…" : "Confirm reset"}
                  </Button>
                </div>
              ) : (
                <Button variant="ghost" size="sm" disabled={busyAction !== null} onClick={() => setConfirmRateLimitReset(true)}>Use reset…</Button>
              )}
            </SettingsRow>
          )}
          <SettingsRow label="Notify workspace owner" hint="Ask ChatGPT to email the workspace owner about depleted credits.">
            {confirmCreditsNudge ? (
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => setConfirmCreditsNudge(false)}>Cancel</Button>
                <Button variant="ghost" size="sm" disabled={busyAction !== null} onClick={() => void runWorkflow("account:nudge", "account.sendAddCreditsNudgeEmail", { creditType: "credits" }, "Workspace owner notification requested.", () => setConfirmCreditsNudge(false))}>
                  {busyAction === "account:nudge" ? "Sending…" : "Confirm email"}
                </Button>
              </div>
            ) : (
              <Button variant="ghost" size="sm" disabled={!account?.type || busyAction !== null} onClick={() => setConfirmCreditsNudge(true)}>Notify…</Button>
            )}
          </SettingsRow>
          {workspaceMessages.map((message) => (
            <SettingsRow key={message.id} label={message.type} hint={message.body}>
              <span className="text-fg2 text-xs">{message.createdAt ? new Date(message.createdAt * 1_000).toLocaleDateString() : "Active"}</span>
            </SettingsRow>
          ))}
        </SettingsList>
      </SettingsSection>

      <SettingsSection title="Windows sandbox" description="Codex native Windows sandbox readiness and setup.">
        <SettingsList>
          <SettingsRow label="Sandbox readiness" hint={isWindows ? "Checks the native Windows sandbox used by Codex command execution." : "Available when Zeros is running on Windows."}>
            <Button variant="ghost" size="sm" disabled={!surfaceActive || !isWindows || busyAction !== null} onClick={() => void runWorkflow("windows:readiness", "windowsSandbox.readiness", undefined, "Windows sandbox readiness checked.", (result) => setWorkflowMessage(`Windows sandbox: ${String(record(result)?.status ?? "unknown")}.`))}>{busyAction === "windows:readiness" ? "Checking…" : "Check"}</Button>
          </SettingsRow>
          <SettingsRow label="Set up sandbox" hint="Starts Codex's native unelevated setup workflow for the active project.">
            <Button variant="ghost" size="sm" disabled={!surfaceActive || !isWindows || busyAction !== null} onClick={() => void runWorkflow("windows:setup", "windowsSandbox.setup.start", { mode: "unelevated", cwd }, "Windows sandbox setup started.")}>{busyAction === "windows:setup" ? "Starting…" : "Set up"}</Button>
          </SettingsRow>
        </SettingsList>
      </SettingsSection>

      {groups.map(({ group, capabilities }) => (
        <SettingsSection
          key={group}
          title={group}
          description={`Native Codex ${group.toLowerCase()} capabilities for ${cwd}.`}
        >
          <SettingsList>
            {capabilities.map((capability) => {
              const state = states[capability.operation] ?? { status: "idle" as const };
              return (
                <SettingsRow
                  key={capability.operation}
                  label={capability.label}
                  hint={state.status === "error" ? state.error : capability.description}
                >
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!surfaceActive || state.status === "loading"}
                    onClick={() => void load(capability)}
                    className={cn(
                      "min-w-24 justify-start gap-1.5",
                      state.status === "error" && "text-red-primary",
                    )}
                  >
                    {state.status === "loading" ? (
                      <LoaderCircle size={13} className="animate-spin" />
                    ) : state.status === "ready" ? (
                      <Check size={13} />
                    ) : state.status === "error" ? (
                      <AlertTriangle size={13} />
                    ) : (
                      <RefreshCw size={13} />
                    )}
                    <span className="truncate">
                      {state.status === "ready" ? state.summary : state.status === "error" ? "Retry" : state.status === "loading" ? "Loading" : "Check"}
                    </span>
                  </Button>
                </SettingsRow>
              );
            })}
          </SettingsList>

          {group === "Extensions" && (plugins.length > 0 || apps.length > 0) && (
            <SettingsList className="bg-bg1-highlight rounded-lg px-3">
              {plugins.map((plugin) => {
                const mutation = getPluginMutation(plugin);
                const key = `plugin:${plugin.id}`;
                return (
                  <SettingsRow
                    key={plugin.id}
                    label={plugin.label}
                    hint={`${plugin.marketplaceName} · ${plugin.enabled ? "enabled" : "disabled"}`}
                  >
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!surfaceActive || busyAction !== null}
                      onClick={() => void mutate(key, mutation.operation, mutation.params, ["plugins.list"])}
                    >
                      {busyAction === key ? "Working…" : plugin.installed ? "Uninstall" : "Install"}
                    </Button>
                  </SettingsRow>
                );
              })}
              {apps.map((app) => (
                <SettingsRow
                  key={`app:${app.id}`}
                  label={app.name}
                  hint={`Connector · ${app.accessible ? "linked" : "not linked"}`}
                >
                  <span className={cn("text-xs", app.enabled ? "text-green-primary" : "text-fg2")}>
                    {app.enabled ? "Enabled" : "Disabled"}
                  </span>
                </SettingsRow>
              ))}
            </SettingsList>
          )}

          {group === "Connections" && mcpServers.length > 0 && (
            <SettingsList className="bg-bg1-highlight rounded-lg px-3">
              {mcpServers.map((server) => {
                const key = `mcp:${server.name}`;
                return (
                  <SettingsRow
                    key={server.name}
                    label={server.name}
                    hint={`${server.toolCount} tools · ${server.resourceCount} resources · ${server.startupStatus} · ${server.authStatus}${server.error ? ` · ${server.error}` : ""}`}
                  >
                    <div className="flex items-center gap-2">
                      <Button variant="ghost" size="sm" disabled={!surfaceActive || busyAction !== null} onClick={() => selectMcpServer(server)}>
                        Inspect
                      </Button>
                      {server.authStatus === "notLoggedIn" || server.failureReason === "reauthenticationRequired" ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={!surfaceActive || busyAction !== null}
                          onClick={() => {
                            void (async () => {
                              setBusyAction(key);
                              try {
                                const result = record(await call("mcp.oauth.login", {
                                  name: server.name,
                                  threadId: codexChat?.nativeSessionId ?? null,
                                }));
                                const authorizationUrl = result?.authorizationUrl;
                                if (typeof authorizationUrl === "string") {
                                  openBrowser({ url: authorizationUrl, title: `${server.name} sign in` });
                                  setWorkflowMessage(`Complete ${server.name} sign-in in the Browser, then refresh MCP servers.`);
                                }
                              } catch (error) {
                                setWorkflowMessage(error instanceof Error ? error.message : String(error));
                              } finally {
                                setBusyAction(null);
                              }
                            })();
                          }}
                        >
                          {busyAction === key ? "Opening…" : "Sign in"}
                        </Button>
                      ) : (
                        <Check size={14} className="text-green-primary" />
                      )}
                    </div>
                  </SettingsRow>
                );
              })}
              {mcpServerName && (
                <>
                  <SettingsRow label={`${mcpServerName} resource`} hint="Read an advertised MCP resource without invoking a tool.">
                    <div className="flex min-w-96 items-center gap-2">
                      <Input value={mcpResourceUri} onChange={(event) => setMcpResourceUri(event.target.value)} placeholder="resource://uri" aria-label="MCP resource URI" />
                      <Button variant="ghost" size="sm" disabled={!mcpResourceUri.trim() || busyAction !== null} onClick={() => void readMcpResource()}>
                        {busyAction === `mcp:resource:${mcpServerName}` ? "Reading…" : "Read"}
                      </Button>
                    </div>
                  </SettingsRow>
                  <SettingsRow label={`${mcpServerName} tool`} hint="Tool calls may change external systems and always require confirmation.">
                    <div className="flex min-w-96 flex-col items-end gap-2">
                      <div className="flex w-full items-center gap-2">
                        <Input value={mcpToolName} onChange={(event) => setMcpToolName(event.target.value)} placeholder="tool_name" aria-label="MCP tool name" />
                        <Input value={mcpToolArguments} onChange={(event) => setMcpToolArguments(event.target.value)} placeholder="{}" aria-label="MCP tool JSON arguments" />
                      </div>
                      {confirmMcpToolCall ? (
                        <div className="flex items-center gap-2">
                          <Button variant="ghost" size="sm" onClick={() => setConfirmMcpToolCall(false)}>Cancel</Button>
                          <Button variant="ghost" size="sm" disabled={!nativeThreadId || !mcpToolName.trim() || busyAction !== null} onClick={() => void callMcpTool()}>
                            {busyAction === `mcp:tool:${mcpServerName}:${mcpToolName.trim()}` ? "Calling…" : "Confirm call"}
                          </Button>
                        </div>
                      ) : (
                        <Button variant="ghost" size="sm" disabled={!nativeThreadId || !mcpToolName.trim() || busyAction !== null} onClick={() => setConfirmMcpToolCall(true)}>Call tool…</Button>
                      )}
                    </div>
                  </SettingsRow>
                  {mcpResult && (
                    <SettingsRow label="MCP result" hint="Result is bounded to 8,000 characters and is not written to the task transcript.">
                      <pre className="text-fg2 max-h-48 max-w-xl overflow-auto whitespace-pre-wrap text-[11px]">{mcpResult}</pre>
                    </SettingsRow>
                  )}
                </>
              )}
              <SettingsRow label="Reload MCP configuration" hint="Restart discovery after editing Codex MCP settings.">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!surfaceActive || busyAction !== null}
                  onClick={() => void mutate("mcp:reload", "mcp.reload", undefined, ["mcp.status.list"])}
                >
                  {busyAction === "mcp:reload" ? "Reloading…" : "Reload"}
                </Button>
              </SettingsRow>
            </SettingsList>
          )}

          {group === "Connections" && remoteStatus && (
            <SettingsList className="bg-bg1-highlight rounded-lg px-3">
              <SettingsRow
                label="Remote control"
                hint={`${String(remoteStatus.serverName ?? "Codex")} · ${String(remoteStatus.status ?? "unknown")}`}
              >
                <Switch
                  checked={remoteEnabled}
                  disabled={!surfaceActive || busyAction !== null}
                  onCheckedChange={(enabled) =>
                    void mutate(
                      "remote:toggle",
                      enabled ? "remoteControl.enable" : "remoteControl.disable",
                      { ephemeral: false },
                      ["remoteControl.status.read"],
                    )
                  }
                />
              </SettingsRow>
              <SettingsRow label="Connected clients" hint={remoteStatus.environmentId ? "Inspect clients attached to this Codex remote-control environment." : "Enable remote control to create an environment first."}>
                <Button variant="ghost" size="sm" disabled={!remoteStatus.environmentId || busyAction !== null} onClick={() => void loadRemoteClients()}>
                  {busyAction === "remote:clients" ? "Loading…" : "Check"}
                </Button>
              </SettingsRow>
              {remoteClients.map((client) => (
                <SettingsRow
                  key={client.clientId}
                  label={client.displayName ?? client.deviceModel ?? client.clientId}
                  hint={`${client.platform ?? client.deviceType ?? "Unknown device"}${client.osVersion ? ` ${client.osVersion}` : ""}${client.appVersion ? ` · app ${client.appVersion}` : ""}${client.lastSeenAt ? ` · last seen ${new Date(client.lastSeenAt * 1_000).toLocaleString()}` : ""}`}
                >
                  {confirmRemoteRevoke === client.clientId ? (
                    <div className="flex items-center gap-2">
                      <Button variant="ghost" size="sm" onClick={() => setConfirmRemoteRevoke(null)}>Cancel</Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-red-primary"
                        disabled={busyAction !== null || !remoteStatus.environmentId}
                        onClick={() => {
                          if (!remoteStatus.environmentId) return;
                          void mutate(
                            `remote:revoke:${client.clientId}`,
                            "remoteControl.clients.revoke",
                            { environmentId: remoteStatus.environmentId, clientId: client.clientId },
                            [],
                          ).then(() => {
                            setConfirmRemoteRevoke(null);
                            void loadRemoteClients();
                          });
                        }}
                      >
                        {busyAction === `remote:revoke:${client.clientId}` ? "Revoking…" : "Confirm revoke"}
                      </Button>
                    </div>
                  ) : (
                    <Button variant="ghost" size="sm" disabled={busyAction !== null} onClick={() => setConfirmRemoteRevoke(client.clientId)}>Revoke…</Button>
                  )}
                </SettingsRow>
              ))}
            </SettingsList>
          )}

          {group === "Runtime" && experiments.length > 0 && (
            <SettingsList className="bg-bg1-highlight rounded-lg px-3">
              {experiments.map((feature) => {
                const key = `experiment:${feature.name}`;
                return (
                  <SettingsRow
                    key={feature.name}
                    label={feature.label}
                    hint={`${feature.description} · ${feature.stage}${feature.defaultEnabled ? " · default" : ""}`}
                  >
                    <Switch
                      checked={feature.enabled}
                      disabled={!surfaceActive || busyAction !== null}
                      onCheckedChange={(enabled) =>
                        void mutate(
                          key,
                          "experimental.set",
                          { enablement: { [feature.name]: enabled } },
                          ["experimental.list"],
                        )
                      }
                    />
                  </SettingsRow>
                );
              })}
            </SettingsList>
          )}
        </SettingsSection>
      ))}
    </div>
  );
}
