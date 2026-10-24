import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { oauthClientMode, type McpConfig } from "./model.js";
import { mcpPublicUrl } from "./safe-fetch.js";

export const MCP_CLIENT_PATH = "/.well-known/mcp-client.json";
export const MCP_CALLBACK_PATH = "/mcp/oauth/callback";
export interface OAuthMaterial { client?: OAuthClientInformationMixed; clientMode?: ReturnType<typeof oauthClientMode>; tokens?: OAuthTokens; discovery?: OAuthDiscoveryState; verifier?: string; expiresAt?: number }
export function clientMetadataDocument(origin: string, desktopRedirect?: string): OAuthClientMetadata & { client_id: string } {
  const base = new URL(origin), metadata = new URL(MCP_CLIENT_PATH, base);
  let redirect = new URL(MCP_CALLBACK_PATH, base).href;
  if (desktopRedirect !== undefined) {
    const url = new URL(desktopRedirect);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || Number(url.port) < 1 ||
      url.pathname !== "/callback" || url.search || url.hash || url.username || url.password) throw new Error("Invalid MCP desktop redirect");
    redirect = url.href;
    metadata.searchParams.set("redirect_uri", redirect);
  }
  return { client_id: metadata.href, client_name: "Zeros", redirect_uris: [redirect], grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"], token_endpoint_auth_method: "none" };
}

interface Options { config: McpConfig; callback: string; identity: string; state: string; clientSecret?: string; material?: OAuthMaterial }
export class McpOAuthProvider implements OAuthClientProvider {
  readonly material: OAuthMaterial;
  authorizationUrl?: string;
  readonly clientMetadataUrl?: string;
  private readonly mode: "auto" | "metadata" | "dynamic" | "custom";
  constructor(private readonly options: Options) {
    if (options.config.transport === "stdio") throw new Error("OAuth requires an HTTP MCP server");
    this.material = structuredClone(options.material ?? {});
    this.mode = oauthClientMode(options.config);
    if (this.mode === "metadata") this.clientMetadataUrl = mcpPublicUrl(options.config.oauth_client_id ?? "").href;
    else if (this.mode === "auto" && options.identity.startsWith("https://")) this.clientMetadataUrl = options.identity;
    const cached = this.material.client;
    if ((this.material.clientMode && this.material.clientMode !== this.mode) || (cached && (
      (this.mode === "custom" && cached.client_id !== options.config.oauth_client_id) ||
      (this.mode === "metadata" && cached.client_id !== this.clientMetadataUrl) ||
      (this.mode === "dynamic" && !this.material.clientMode && /^https:\/\//.test(cached.client_id))
    ))) this.invalidateCredentials("all");
    if (this.material.discovery) this.saveDiscoveryState(this.material.discovery);
  }
  get redirectUrl(): string { return this.options.callback; }
  get clientMetadata(): OAuthClientMetadata {
    const config = this.options.config;
    return { client_name: "Zeros", redirect_uris: [this.redirectUrl], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
      token_endpoint_auth_method: this.mode === "custom" && this.options.clientSecret ? "client_secret_basic" : "none",
      ...(config.transport !== "stdio" && config.oauth_scopes?.length ? { scope: config.oauth_scopes.join(" ") } : {}) };
  }
  state(): string { return this.options.state; }
  clientInformation(): OAuthClientInformationMixed | undefined {
    const config = this.options.config;
    return this.mode === "custom" && config.transport !== "stdio" && config.oauth_client_id ? {
      ...this.material.client,
      client_id: config.oauth_client_id, ...(this.options.clientSecret ? { client_secret: this.options.clientSecret } : {}),
    } : this.material.client;
  }
  saveClientInformation(client: OAuthClientInformationMixed): void {
    if (this.mode === "custom" && this.options.config.transport !== "stdio" && client.client_id !== this.options.config.oauth_client_id)
      throw new Error("Use the configured OAuth client identity");
    this.material.client = client; this.material.clientMode = this.mode;
  }
  tokens(): OAuthTokens | undefined { return this.material.tokens; }
  saveTokens(tokens: OAuthTokens): void {
    this.material.tokens = { ...tokens, ...(tokens.refresh_token ? {} : this.material.tokens?.refresh_token ? { refresh_token: this.material.tokens.refresh_token } : {}) };
    if (tokens.expires_in !== undefined) this.material.expiresAt = Date.now() + Math.max(0, tokens.expires_in) * 1000;
    else delete this.material.expiresAt;
  }
  redirectToAuthorization(url: URL): void { this.authorizationUrl = mcpPublicUrl(url).href; }
  saveCodeVerifier(verifier: string): void { this.material.verifier = verifier; }
  codeVerifier(): string { if (!this.material.verifier) throw new Error("MCP sign-in has expired"); return this.material.verifier; }
  discoveryState(): OAuthDiscoveryState | undefined { return this.material.discovery; }
  saveDiscoveryState(state: OAuthDiscoveryState): void {
    const metadata = state.authorizationServerMetadata;
    const issuer = mcpPublicUrl(state.authorizationServerUrl);
    if (metadata) {
      if (!metadata.issuer || mcpPublicUrl(metadata.issuer).href !== issuer.href) throw new Error("MCP OAuth issuer does not match discovery");
      if (!metadata.code_challenge_methods_supported?.includes("S256")) throw new Error("MCP OAuth requires PKCE S256");
      if (this.mode === "metadata" && metadata.client_id_metadata_document_supported !== true) throw new Error("This service does not support published OAuth client identities");
      for (const endpoint of [metadata.authorization_endpoint, metadata.token_endpoint, metadata.registration_endpoint]) if (endpoint) mcpPublicUrl(endpoint);
    }
    this.material.discovery = state;
  }
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all" || scope === "client") { delete this.material.client; delete this.material.clientMode; }
    if (scope === "all" || scope === "tokens") { delete this.material.tokens; delete this.material.expiresAt; }
    if (scope === "all" || scope === "verifier") delete this.material.verifier;
    if (scope === "all" || scope === "discovery") delete this.material.discovery;
  }
}
