import type pg from "pg";
import type { Config } from "../config.js";
import { cloudAgentCredentialKeys } from "../agent-credentials/agent-credentials.js";
import { McpStore, type CloudMcpRepositoryAdmission } from "./store.js";
import { McpOAuth } from "./oauth.js";
import { mcpRepositoryCatalog } from "./repositories.js";

export function createMcpServices(pool: pg.Pool, config: Config, cloudRepositoryAdmission?: CloudMcpRepositoryAdmission): { store: McpStore; oauth: McpOAuth } | null {
  const keys = cloudAgentCredentialKeys(config.cloudAgentCredentials ?? null);
  if (!keys) return null;
  let origin: URL;
  try { origin = new URL(config.cloudV2?.apiUrl ?? config.auth.audience); } catch { return null; }
  if (origin.protocol !== "https:" && !(origin.protocol === "http:" && origin.hostname === "127.0.0.1")) return null;
  if (origin.username || origin.password || origin.search || origin.hash) return null;
  const store = new McpStore(pool, keys, mcpRepositoryCatalog(pool, config.github?.variantKey), cloudRepositoryAdmission);
  return { store, oauth: new McpOAuth(store, origin.origin) };
}
