// ──────────────────────────────────────────────────────────
// MCP gateway — OAuth token vault + the SDK OAuthClientProvider
// ──────────────────────────────────────────────────────────
//
// The credential layer for the gateway's per-backend OAuth. The MCP SDK drives
// the OAuth 2.1 flow (discovery, PKCE, exchange, refresh) through an
// `OAuthClientProvider` we implement; this is that implementation, backed by a
// vault keyed by CANONICAL RESOURCE URI (RFC 8707) so a token issued for backend
// A can never be handed to backend B.
//
// Interactive gating: `redirectToAuthorization` only opens the system browser
// when the provider is in INTERACTIVE mode (set during a user-triggered Sign-in).
// On a passive connect (engine boot / reload) it's a no-op — the SDK then throws
// UnauthorizedError, which the gateway turns into a "needs-auth" status WITHOUT
// spawning a browser. PKCE verifier + CSRF state live on the provider instance
// (one in-flight authorization per backend).
//
// Persistence is the vault's owner's job (the engine, via the safeStorage
// bridge) — the vault just exposes a snapshot/restore + an onChange hook. Tokens
// are NEVER written to disk in plaintext or logged.
// ──────────────────────────────────────────────────────────

import { randomBytes } from "node:crypto";
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { issuerMismatchReason } from "./oauth-url";
import type {
  OAuthClientInformationFull,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

/** Per-backend stored credentials, keyed by canonical resource URI. */
export interface BackendCredentials {
  oauthConfig?: string;
  oauthSecret?: { clientId: string; value: string };
  tokens?: OAuthTokens;
  /** A dynamically-registered client (RFC 7591), to reuse across reconnects. */
  client?: OAuthClientInformationFull;
  /** For an auth:"header" backend: a static auth header the gateway adds when it
   *  proxies (name + secret value). Held here (engine-only) so the value never
   *  touches settings.toml, the renderer, or any agent's command line. */
  header?: { name: string; value: string };
}

/** In-memory credential store keyed by canonical resource URI. The engine owns
 *  durable persistence (safeStorage) via the onChange hook + snapshot/restore;
 *  this never touches disk itself. */
export class OAuthVault {
  private readonly creds = new Map<string, BackendCredentials>();
  private readonly revisions = new Map<string, number>();
  constructor(private readonly onChange?: () => void) {}

  private entry(resourceUri: string): BackendCredentials {
    let e = this.creds.get(resourceUri);
    if (!e) {
      e = {};
      this.creds.set(resourceUri, e);
    }
    return e;
  }

  getTokens(resourceUri: string): OAuthTokens | undefined {
    return this.creds.get(resourceUri)?.tokens;
  }
  revision(resourceUri: string): number { return this.revisions.get(resourceUri) ?? 0; }
  private advance(resourceUri: string): void { this.revisions.set(resourceUri, this.revision(resourceUri) + 1); }
  bindOAuth(resourceUri: string, clientId?: string, scope?: string): number {
    const entry = this.entry(resourceUri);
    const config = JSON.stringify([clientId ?? "", [...new Set((scope ?? "").split(/\s+/).filter(Boolean))].sort()]);
    // Legacy default registrations remain usable. Explicit new configuration
    // must never reuse another client's tokens or broader authorization.
    if (entry.oauthConfig !== config) {
      if (entry.oauthConfig !== undefined || clientId || scope) {
        delete entry.tokens;
        delete entry.client;
        this.advance(resourceUri);
      }
      entry.oauthConfig = config;
      this.onChange?.();
    }
    return this.revision(resourceUri);
  }
  getOAuthSecret(resourceUri: string, clientId: string): string | undefined {
    const saved = this.creds.get(resourceUri)?.oauthSecret;
    return saved?.clientId === clientId ? saved.value : undefined;
  }
  setOAuthSecret(resourceUri: string, clientId: string, value: string): void {
    const entry = this.entry(resourceUri);
    if (value) entry.oauthSecret = { clientId, value };
    else delete entry.oauthSecret;
    delete entry.tokens;
    delete entry.client;
    this.advance(resourceUri);
    this.onChange?.();
  }
  invalidateOAuth(resourceUri: string, scope: "all" | "client" | "tokens" | "verifier"): void {
    const entry = this.creds.get(resourceUri);
    if (!entry) return;
    if (scope === "all" || scope === "tokens") delete entry.tokens;
    if (scope === "all" || scope === "client") delete entry.client;
    this.onChange?.();
  }
  setTokens(resourceUri: string, tokens: OAuthTokens): void {
    this.entry(resourceUri).tokens = tokens;
    this.onChange?.();
  }
  getClient(resourceUri: string): OAuthClientInformationFull | undefined {
    return this.creds.get(resourceUri)?.client;
  }
  setClient(resourceUri: string, client: OAuthClientInformationFull): void {
    this.entry(resourceUri).client = client;
    this.onChange?.();
  }
  /** Drop only a dynamic client registration, preserving tokens/header state.
   *  Used when this app's loopback callback changes (for example, a release
   *  channel moves to its own port footprint) and the old registration can no
   *  longer authorize the current redirect URI. */
  clearClient(resourceUri: string): void {
    const entry = this.creds.get(resourceUri);
    if (!entry?.client) return;
    delete entry.client;
    if (!entry.tokens && !entry.header && !entry.oauthConfig && !entry.oauthSecret) this.creds.delete(resourceUri);
    this.onChange?.();
  }
  hasTokens(resourceUri: string): boolean {
    return !!this.getTokens(resourceUri);
  }
  getHeader(resourceUri: string): { name: string; value: string } | undefined {
    return this.creds.get(resourceUri)?.header;
  }
  setHeader(
    resourceUri: string,
    header: { name: string; value: string },
  ): void {
    this.entry(resourceUri).header = header;
    this.onChange?.();
  }
  clear(resourceUri: string): void {
    this.advance(resourceUri);
    if (this.creds.delete(resourceUri)) this.onChange?.();
  }

  /** A serializable copy for the durable store. Contains SECRETS — the caller
   *  MUST encrypt at rest (safeStorage) + never log it. */
  snapshot(): Record<string, BackendCredentials> {
    return structuredClone(Object.fromEntries(this.creds));
  }
  /** Re-seed from the durable store at boot (no onChange — this isn't a write). */
  restore(data: Record<string, BackendCredentials> | null | undefined): void {
    for (const key of this.creds.keys()) this.advance(key);
    this.creds.clear();
    if (!data) return;
    for (const [k, v] of Object.entries(data)) if (v) this.creds.set(k, structuredClone(v));
  }
}

export interface ZerosOAuthProviderDeps {
  vault: OAuthVault;
  /** Canonical resource URI (RFC 8707) — the vault key + the audience. */
  resourceUri: string;
  /** The loopback callback URL (fixed, registered as the redirect_uri). */
  redirectUrl: string;
  /** Shown on the AS consent screen. */
  clientName: string;
  /** Open a URL in the user's system browser (engine → renderer → shell). */
  openBrowser: (url: string) => void;
  /** Optional pre-registered client id (no-DCR providers). */
  staticClientId?: string;
  /** Optional space-delimited scopes to request. */
  scope?: string;
}

/** Implements the SDK's OAuthClientProvider against the vault. One instance per
 *  backend (its `resourceUri` is the vault key). */
export class ZerosOAuthProvider implements OAuthClientProvider {
  private readonly revision: number;
  private cancelled = false;
  private interactive = false;
  private verifier: string | null = null;
  private currentState: string | null = null;
  private lastAuthorizationUrl: string | null = null;

  constructor(private readonly deps: ZerosOAuthProviderDeps) {
    this.revision = deps.vault.bindOAuth(deps.resourceUri, deps.staticClientId, deps.scope);
  }
  cancel(): void { this.cancelled = true; this.interactive = false; this.verifier = null; }
  private assertCurrent(): void {
    if (this.cancelled || this.deps.vault.revision(this.deps.resourceUri) !== this.revision) throw new Error("MCP authorization changed or was cancelled. Start sign-in again.");
  }
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier"): void {
    this.assertCurrent();
    this.deps.vault.invalidateOAuth(this.deps.resourceUri, scope);
    if (scope === "all" || scope === "verifier") this.verifier = null;
  }

  /** Allow `redirectToAuthorization` to open the browser. Set true only for a
   *  user-triggered Sign-in; false on passive connect so boot never opens one. */
  setInteractive(on: boolean): void {
    this.interactive = on;
  }
  /** The CSRF state of the in-flight authorization, for the loopback to validate. */
  get expectedState(): string | null {
    return this.currentState;
  }
  /** The most recent authorization URL the SDK asked us to open — captured for
   *  the headless paste-code flow (the gateway returns it to the UI). */
  get authorizationUrl(): string | null {
    return this.lastAuthorizationUrl;
  }

  get redirectUrl(): string {
    return this.deps.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.deps.clientName,
      redirect_uris: [this.deps.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none", // public client — PKCE, no secret
      ...(this.deps.scope ? { scope: this.deps.scope } : {}),
    };
  }

  async state(): Promise<string> {
    this.currentState = randomBytes(32).toString("base64url");
    return this.currentState;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    this.assertCurrent();
    if (this.deps.staticClientId) {
      const secret = this.deps.vault.getOAuthSecret(this.deps.resourceUri, this.deps.staticClientId);
      return { client_id: this.deps.staticClientId, ...(secret ? { client_secret: secret } : {}) };
    }
    const stored = this.deps.vault.getClient(this.deps.resourceUri);
    if (stored) {
      // A DCR client is bound to the redirect URI registered with the
      // authorization server. Reusing it after a channel's callback port moves
      // makes the next sign-in fail with redirect_uri mismatch. Invalidate only
      // the registration (tokens remain usable) so the SDK can register a
      // compatible client when authorization is next required.
      if (
        Array.isArray(stored.redirect_uris) &&
        stored.redirect_uris.includes(this.deps.redirectUrl)
      ) {
        return stored;
      }
      this.deps.vault.clearClient(this.deps.resourceUri);
    }
    return undefined;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.assertCurrent();
    // Only a full registration (with client_id) is worth persisting for reuse.
    if ("client_id" in info && info.client_id) {
      this.deps.vault.setClient(
        this.deps.resourceUri,
        info as OAuthClientInformationFull,
      );
    }
  }

  /** Mix-up and issuer binding. The SDK calls this after discovery but never
   *  validates the issuer itself, so we assert the discovered AS metadata's
   *  `issuer` matches the AS URL it came from (RFC 8414 §3.3) and THROW to abort
   *  the flow on a mismatch — a malicious resource server can't redirect the
   *  gateway's code/token to a different issuer. We don't persist the state (a
   *  re-discovery per connect is acceptable + keeps this purely a guard). */
  saveDiscoveryState(state: OAuthDiscoveryState): void {
    const meta = state.authorizationServerMetadata as
      | { issuer?: string; code_challenge_methods_supported?: unknown }
      | undefined;
    const issuer = meta?.issuer;
    if (issuer) {
      const reason = issuerMismatchReason(issuer, state.authorizationServerUrl);
      if (reason)
        throw new Error(`MCP gateway refused OAuth metadata: ${reason}`);
    }
    // PKCE downgrade refusal under MCP 2025-11-25: the authorization server
    // MUST advertise S256. If discovery returned metadata that omits
    // `code_challenge_methods_supported` or lacks "S256", refuse rather than
    // proceed without the PKCE protection the spec mandates.
    if (meta) {
      const methods = meta.code_challenge_methods_supported;
      if (!Array.isArray(methods) || !methods.includes("S256")) {
        throw new Error(
          "MCP gateway refused OAuth metadata: the authorization server does not advertise PKCE S256 " +
            "(code_challenge_methods_supported) — refusing a PKCE downgrade",
        );
      }
    }
  }

  tokens(): OAuthTokens | undefined {
    this.assertCurrent();
    return this.deps.vault.getTokens(this.deps.resourceUri);
  }

  saveTokens(tokens: OAuthTokens): void {
    this.assertCurrent();
    // The SDK calls this after the code exchange and every refresh, persisting
    // a rotated refresh_token atomically here.
    this.deps.vault.setTokens(this.deps.resourceUri, tokens);
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.assertCurrent();
    if (this.deps.scope) authorizationUrl.searchParams.set("scope", this.deps.scope);
    // Always capture the URL — the headless paste-code flow returns it to the UI.
    this.lastAuthorizationUrl = authorizationUrl.toString();
    if (this.interactive) {
      this.deps.openBrowser(authorizationUrl.toString());
    }
    // else: passive/headless connect — do NOT open a browser. The SDK throws
    // UnauthorizedError, which the gateway maps to a "needs-auth" status (or, for
    // beginAuthorize, reads the captured URL above).
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.verifier) {
      throw new Error("no PKCE code verifier — authorization was not started");
    }
    return this.verifier;
  }
}
