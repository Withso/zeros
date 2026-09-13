import type { McpServerStatus } from "@anthropic-ai/claude-agent-sdk";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { defaultMacClaudeOAuthAuthority } from "../../containment/claude-oauth-authority";

type Membership = "connected" | "not-connected";
export interface ClaudeConnectorMembership {
  readonly memberships: ReadonlyMap<string, Membership>;
  readonly complete: boolean;
}
export type ClaudeConnectorMembershipReader = (
  servers?: readonly McpServerStatus[],
) => Promise<ClaudeConnectorMembership>;
type Environment = Readonly<Record<string, string | undefined>>;

const CATALOG_URL = "https://api.anthropic.com/v1/mcp_servers?limit=1000";
const MAX_CATALOG_BYTES = 8 * 1024 * 1024;
const MAX_CREDENTIAL_BYTES = 64 * 1024;
const MAX_CONNECTORS = 1_000;
const READ_TIMEOUT_MS = 3_000;

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** The pinned CLI's catalogue includes unconnected directory entries. Its
 * mcp_status control response strips eligible/eligibility_reason, so read the
 * same versioned account endpoint in the trusted engine. Membership is distinct
 * from the MCP transport status, including expired grants and network failures. */
export function parseClaudeConnectorMembership(
  value: unknown,
): ClaudeConnectorMembership {
  if (!record(value) || !Array.isArray(value.data))
    throw new Error("Claude connector membership was unavailable.");
  const memberships = new Map<string, Membership>();
  const seen = new Set<string>();
  let complete =
    value.data.length <= MAX_CONNECTORS && value.next_page === null;
  for (const row of value.data.slice(0, MAX_CONNECTORS)) {
    if (
      !record(row) ||
      typeof row.id !== "string" ||
      !row.id ||
      row.id.length > 256
    ) {
      complete = false;
      continue;
    }
    // This explicit provider reason distinguishes never-connected catalogue
    // entries from an existing connection whose eligibility/grant has failed.
    const membership =
      row.eligibility_reason === "never_connected_no_auto_connect"
        ? "not-connected"
        : row.eligibility_reason === "connected"
          ? "connected"
          : undefined;
    const duplicate = seen.has(row.id);
    seen.add(row.id);
    if (!membership || duplicate) {
      complete = false;
      memberships.delete(row.id);
      continue;
    }
    memberships.set(row.id, membership);
  }
  return { memberships, complete };
}

/** Resolve only the query's own credential namespace. Never fall through from
 * a locked Keychain or a missing selected profile to the device's other login.
 * The existing authority owns rotating-token refresh; no refresh token leaves it. */
export async function readClaudeConnectorCredential(
  env: Environment,
  signal: AbortSignal,
): Promise<string | null> {
  signal.throwIfAborted();
  const configDir = env.CLAUDE_CONFIG_DIR || undefined;
  const accountHome = env.HOME || homedir();
  const authority = defaultMacClaudeOAuthAuthority(accountHome, configDir);
  let raw: string | undefined;
  if (authority) {
    const credential = await authority.readProjectedCredential({ signal });
    if (credential.status === "unavailable") return null;
    if (credential.status === "available") raw = credential.value;
  }
  if (raw === undefined) {
    const file = path.join(
      configDir ?? path.join(accountHome, ".claude"),
      ".credentials.json",
    );
    if ((await stat(file)).size > MAX_CREDENTIAL_BYTES) return null;
    raw = await readFile(file, { encoding: "utf8", signal });
  }
  signal.throwIfAborted();
  if (Buffer.byteLength(raw) > MAX_CREDENTIAL_BYTES) return null;
  const document: unknown = JSON.parse(raw);
  if (!record(document) || !record(document.claudeAiOauth)) return null;
  const oauth = document.claudeAiOauth;
  if (
    !Array.isArray(oauth.scopes) ||
    !oauth.scopes.includes("user:mcp_servers")
  )
    return null;
  if (typeof oauth.expiresAt === "number" && oauth.expiresAt <= Date.now())
    return null;
  return typeof oauth.accessToken === "string" &&
    oauth.accessToken.length > 0 &&
    oauth.accessToken.length <= 32_768 &&
    !/\s/.test(oauth.accessToken)
    ? oauth.accessToken
    : null;
}

async function readCatalog(
  token: string,
  signal: AbortSignal,
  fetcher: typeof fetch,
): Promise<ClaudeConnectorMembership> {
  const response = await fetcher(CATALOG_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "mcp-servers-2025-12-04",
      "anthropic-version": "2023-06-01",
    },
    redirect: "error",
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("Claude connector membership was unavailable.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Claude connector membership was unavailable.");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_CATALOG_BYTES)
        throw new Error("Claude connector membership was incomplete.");
      chunks.push(value);
    }
    return parseClaudeConnectorMembership(
      JSON.parse(Buffer.concat(chunks).toString("utf8")),
    );
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** One reader belongs to one live Query and its captured auth environment.
 * Refresh revalidates; concurrent reads share work. Failures retain that query's
 * last verified membership without reviving the entire unconnected catalogue. */
export function createClaudeConnectorMembershipReader(
  environment: Environment,
  querySignal: AbortSignal,
  dependencies: {
    readCredential?: typeof readClaudeConnectorCredential;
    fetch?: typeof fetch;
  } = {},
): ClaudeConnectorMembershipReader {
  const env = { ...environment };
  let confirmed: ClaudeConnectorMembership = {
    memberships: new Map(),
    complete: false,
  };
  let inFlight: Promise<ClaudeConnectorMembership> | null = null;
  return (servers = []) => {
    // Runtime success can establish membership during a catalogue outage, but
    // must never override an explicit account-side exclusion on later reads.
    const observed = new Map(confirmed.memberships);
    for (const server of servers) {
      const id =
        server.config?.type === "claudeai-proxy" ? server.config.id : undefined;
      if (id && server.status === "connected" && !observed.has(id))
        observed.set(id, "connected");
    }
    confirmed = {
      ...confirmed,
      memberships: new Map([...observed].slice(-MAX_CONNECTORS)),
    };
    if (inFlight) return inFlight;
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (querySignal.aborted) abort();
    else querySignal.addEventListener("abort", abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = async () => {
      controller.signal.throwIfAborted();
      if (
        [
          "ANTHROPIC_API_KEY",
          "ANTHROPIC_AUTH_TOKEN",
          "CLAUDE_CODE_OAUTH_TOKEN",
        ].some((key) => env[key]?.trim()) ||
        (env.ANTHROPIC_BASE_URL &&
          env.ANTHROPIC_BASE_URL !== "https://api.anthropic.com")
      )
        throw new Error("Claude connector account is unavailable.");
      const token = await (
        dependencies.readCredential ?? readClaudeConnectorCredential
      )(env, controller.signal);
      if (!token) throw new Error("Claude connector account is unavailable.");
      controller.signal.throwIfAborted();
      return readCatalog(token, controller.signal, dependencies.fetch ?? fetch);
    };
    inFlight = Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Claude connector membership timed out."));
        }, READ_TIMEOUT_MS);
      }),
    ])
      .then((snapshot) => {
        confirmed = snapshot.complete
          ? snapshot
          : {
              memberships: new Map(
                [
                  ...new Map([
                    ...confirmed.memberships,
                    ...snapshot.memberships,
                  ]),
                ].slice(-MAX_CONNECTORS),
              ),
              complete: false,
            };
        return confirmed;
      })
      .catch(() => ({ ...confirmed, complete: false }))
      .finally(() => {
        if (timer) clearTimeout(timer);
        querySignal.removeEventListener("abort", abort);
        inFlight = null;
      });
    return inFlight;
  };
}

export function isClaudeAccountConnector(server: McpServerStatus): boolean {
  return (
    server.scope === "claudeai" || server.config?.type === "claudeai-proxy"
  );
}

export const CLAUDE_CONNECTOR_MEMBERSHIP_UNAVAILABLE =
  "Some connected services could not be verified with Claude. Refresh to try again.";

export async function selectClaudeSessionConnectors(
  servers: McpServerStatus[],
  readMembership?: ClaudeConnectorMembershipReader,
): Promise<{ servers: McpServerStatus[]; partial: boolean }> {
  if (!servers.some(isClaudeAccountConnector))
    return { servers, partial: false };
  const snapshot = servers.some(
    (server) => server.config?.type === "claudeai-proxy" && server.config.id,
  )
    ? await readMembership?.(servers).catch(() => null)
    : undefined;
  let partial = snapshot ? !snapshot.complete : false;
  const selected = servers.filter((server) => {
    if (!isClaudeAccountConnector(server)) return true;
    const id =
      server.config?.type === "claudeai-proxy" ? server.config.id : undefined;
    const membership = id ? snapshot?.memberships.get(id) : undefined;
    if (membership) return membership === "connected";
    // A successful runtime connection is positive evidence, even on an older
    // CLI. needs-auth/failed alone cannot establish account membership.
    if (server.status === "connected") return true;
    partial = true;
    return false;
  });
  return { servers: selected, partial };
}
