import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { providerUsageIdentity } from "@zeros/protocol/provider-auth";
import {
  claudeCredentialKeychainService,
  defaultMacClaudeOAuthAuthority,
} from "../src/engine/agents/containment/claude-oauth-authority";
import {
  normalizeClaudeUsage,
  normalizeCursorUsage,
  usageText,
  type ProviderUsageData,
} from "./provider-usage";

const MAX_USAGE_BYTES = 256 * 1024;
const MAX_CREDENTIAL_BYTES = 64 * 1024;

/** Read-only requests to fixed provider origins. No redirects, arbitrary URLs,
 * provider bodies, or credentials can be supplied to or returned over IPC. */
export async function readUsageJson(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await fetch(url, { ...init, redirect: "error", signal });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Usage request failed (${response.status}).`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Usage response was empty.");
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_USAGE_BYTES)
        throw new Error("Usage response was too large.");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function readClaudeUsageToken(
  configDir: string | undefined,
  signal: AbortSignal,
): Promise<string | null> {
  signal.throwIfAborted();
  let raw: string | undefined;
  if (process.platform === "darwin") {
    try {
      const result = await promisify(execFile)(
        "/usr/bin/security",
        [
          "find-generic-password",
          "-a",
          userInfo().username,
          "-w",
          "-s",
          claudeCredentialKeychainService(configDir),
        ],
        {
          encoding: "utf8",
          timeout: 5000,
          maxBuffer: MAX_CREDENTIAL_BYTES,
          signal,
        },
      );
      raw = result.stdout;
      // Reuse the provider's CAS + cross-process refresh lock for this exact
      // keychain namespace. A missing/locked item never falls back to another
      // saved account or the device default.
      if (raw)
        return await defaultMacClaudeOAuthAuthority(
          homedir(),
          configDir,
        )!.getAccessToken({ signal });
    } catch (error) {
      // Only a missing item allows the CLI's file fallback. Locked/unreadable
      // keychains must not silently select another credential.
      if (String((error as NodeJS.ErrnoException).code) !== "44")
        throw new Error("Credential unavailable.");
    }
  }
  if (!raw) {
    const file = path.join(
      configDir ?? path.join(homedir(), ".claude"),
      ".credentials.json",
    );
    try {
      if ((await stat(file)).size > MAX_CREDENTIAL_BYTES) return null;
      raw = await readFile(file, { encoding: "utf8", signal });
      if (Buffer.byteLength(raw) > MAX_CREDENTIAL_BYTES) return null;
    } catch {
      return null;
    }
  }
  signal.throwIfAborted();
  try {
    const credential = JSON.parse(raw).claudeAiOauth;
    return typeof credential?.accessToken === "string" &&
      credential.accessToken.length <= 32768 &&
      (!credential.expiresAt || credential.expiresAt > Date.now())
      ? credential.accessToken
      : null;
  } catch {
    return null;
  }
}

export async function readClaudeUsage(
  configDir: string | undefined,
  signal: AbortSignal,
  readToken = readClaudeUsageToken,
): Promise<ProviderUsageData> {
  const token = await readToken(configDir, signal);
  if (!token) throw new Error("Usage credential unavailable.");
  // Pin the same token for identity and quota. CLI status may still describe a
  // previous login, and the on-disk token can change while either read awaits.
  const headers = {
    Authorization: `Bearer ${token}`,
    "anthropic-beta": "oauth-2025-04-20",
  };
  const [profile, rawUsage] = await Promise.all([
    readUsageJson(
      "https://api.anthropic.com/api/oauth/profile",
      { headers },
      signal,
    ),
    readUsageJson(
      "https://api.anthropic.com/api/oauth/usage",
      { headers },
      signal,
    ),
  ]);
  const account = profile as {
    account?: { email?: unknown };
    organization?: { name?: unknown };
  } | null;
  const identity = providerUsageIdentity({
    email: usageText(account?.account?.email, 320),
    organization: usageText(account?.organization?.name, 320),
  });
  if (!identity) throw new Error("Usage identity unavailable.");
  return { ...normalizeClaudeUsage(rawUsage), identity };
}

/** DashboardService's pinned SDK protocol exposes both pools. These are
 * account reads, independent of per-turn token usage or model execution. */
export async function readCursorUsage(
  apiKey: string,
  signal: AbortSignal,
): Promise<ProviderUsageData> {
  // The SDK exchanges its browser-minted API key for a short-lived access
  // token before calling native RPCs. DashboardService rejects the API key
  // itself. Keep this token only inside this native read, never in IPC/cache.
  const exchanged = (await readUsageJson(
    "https://api2.cursor.sh/auth/exchange_user_api_key",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    },
    signal,
  )) as { accessToken?: unknown } | null;
  const accessToken = exchanged?.accessToken;
  if (
    typeof accessToken !== "string" ||
    !accessToken ||
    accessToken.length > 32768
  )
    throw new Error("Usage credential unavailable.");
  const rpc = (
    method: "GetCurrentPeriodUsage" | "GetMe" | "GetTeams",
    body = {},
  ) =>
    readUsageJson(
      `https://api2.cursor.sh/aiserver.v1.DashboardService/${method}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "Connect-Protocol-Version": "1",
          "x-cursor-client-type": "sdk",
        },
        body: JSON.stringify(body),
      },
      signal,
    );
  const [meResult, profileResult] = await Promise.allSettled([
    rpc("GetMe"),
    readUsageJson(
      "https://api2.cursor.sh/auth/full_stripe_profile",
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "x-cursor-client-type": "sdk",
        },
      },
      signal,
    ),
  ]);
  const me = (meResult.status === "fulfilled" ? meResult.value : null) as {
    teamId?: number;
    teamName?: string;
  } | null;
  const profile = (
    profileResult.status === "fulfilled" ? profileResult.value : null
  ) as { membershipType?: string } | null;
  const teamId =
    typeof me?.teamId === "number" && me.teamId > 0 ? me.teamId : undefined;
  const usage = normalizeCursorUsage(
    await rpc(
      "GetCurrentPeriodUsage",
      teamId ? { teamId, includePooledUsage: true } : {},
    ),
  );
  const personalPlan = usageText(profile?.membershipType);
  if (personalPlan) usage.plan = personalPlan;
  if (teamId && !usage.plan) {
    const teams = (await rpc("GetTeams").catch(() => null)) as {
      teams?: { id?: number; membershipType?: string }[];
    } | null;
    const plan = usageText(
      Array.isArray(teams?.teams)
        ? teams.teams.find((team) => team?.id === teamId)?.membershipType
        : undefined,
    );
    if (plan) usage.plan = plan;
  }
  const organization = usageText(me?.teamName, 320);
  if (organization) usage.organization = organization;
  return usage;
}
