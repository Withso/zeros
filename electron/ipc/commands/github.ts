// GitHub authentication commands — Electron main is the sole durable writer.
//
// Renderer responses are secret-free. Candidate credentials are validated
// before their slot and active-method preference are committed, so a failed
// setup never displaces a working method.

import type {
  GithubAuthMethod,
  GithubAuthSnapshot,
  GithubCredential,
  GithubCredentialSummary,
} from "@zeros/core/github-auth";
import {
  GITHUB_GIT_HOST,
  GITHUB_GIT_HTTP_USERNAME,
} from "@zeros/core/github-auth";
import { NativeCommandError } from "@zeros/core/native-error";

import {
  detectGhCli,
  isGitError,
  verifyGithubToken,
} from "../../../src/engine/git";
import { githubCredentialStore } from "../../github-auth-runtime";
import { GithubAppClientError } from "../../github-app-client";
import { GithubAppFlowError } from "../../github-app-controller";
import {
  beginGithubAppConnection,
  cancelGithubAppConnection,
  disconnectGithubApp,
  recheckGithubAppInstallations,
  refreshGithubAppCredential,
} from "../../github-app-flow";
import { GithubPatUndoStore } from "../../github-pat-undo";
import { getSessionUserForMain } from "./auth-session";
import { pushGithubCredentialToEngine } from "../../sidecar";
import type { CommandHandler } from "../router";

const patUndoStore = new GithubPatUndoStore();
let methodSelectionRevision = 0;
let patUndoSelectionRevision: number | null = null;
/** Exact PAT working copy the engine rejected. The durable Keychain value is
 * retained; a later successful health probe clears this marker and re-seeds
 * the engine without asking the user to paste the token again. */
let rejectedPatToken: string | null = null;

function requireString(
  args: Record<string, unknown>,
  key: string,
  context: string,
): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${context}: missing required string '${key}'`);
  }
  return value.trim();
}

function requireMethod(
  args: Record<string, unknown>,
  context: string,
): GithubAuthMethod {
  const value = requireString(args, "method", context);
  if (value !== "gh-cli" && value !== "github-app" && value !== "pat") {
    throw new Error(`${context}: unknown GitHub authentication method`);
  }
  return value;
}

function disconnectedSummary(
  method: GithubAuthMethod,
  extras: Partial<GithubCredentialSummary> = {},
): GithubCredentialSummary {
  return {
    method,
    health: "not-connected",
    configured: false,
    ...extras,
  };
}

function errorSummary(
  method: GithubAuthMethod,
  error: unknown,
  login?: string,
): GithubCredentialSummary {
  if (!isGitError(error)) {
    return {
      method,
      health: "unavailable",
      configured: true,
      ...(login ? { login } : {}),
      detail: error instanceof Error ? error.message : "GitHub is unavailable.",
    };
  }
  const health =
    error.code === "GITHUB_RATE_LIMITED"
      ? "rate-limited"
      : error.code === "GITHUB_SSO_REQUIRED"
        ? "sso-required"
        : error.code === "GITHUB_REPO_NOT_INSTALLED"
          ? "not-installed"
          : error.code === "GITHUB_INSTALLATION_SUSPENDED"
            ? "suspended"
            : error.code === "NOT_AUTHENTICATED"
              ? "invalid"
              : "unavailable";
  return {
    method,
    health,
    configured: true,
    ...(login ? { login } : {}),
    detail: error.message,
  };
}

async function storedMethodSummary(
  method: "pat" | "github-app",
  refreshInstallations = false,
): Promise<GithubCredentialSummary> {
  let credential = await githubCredentialStore.get(method);
  if (!credential) return disconnectedSummary(method);
  if (credential.method === "github-app") {
    const user = getSessionUserForMain();
    if (!user || !credential.ownerSub || credential.ownerSub !== user.sub) {
      return {
        method,
        health: "unavailable",
        configured: true,
        ...(credential.login ? { login: credential.login } : {}),
        detail: user
          ? "This GitHub App connection belongs to another Zeros account."
          : "Sign in to Zeros to use this GitHub App connection.",
      };
    }
    const previousLogin = credential.login;
    try {
      credential = refreshInstallations
        ? await recheckGithubAppInstallations()
        : await refreshGithubAppCredential();
    } catch (error) {
      return errorSummary(method, error, previousLogin);
    }
    if (!credential) return disconnectedSummary(method);
  }
  let verified: { login: string };
  try {
    verified = await verifyGithubToken(credential.accessToken);
  } catch (error) {
    // A user access token can be revoked before its advertised expiry. Give
    // the main-only rotating pair one forced refresh before calling the App
    // invalid; PAT validation remains non-destructive and explicit.
    if (
      credential.method !== "github-app" ||
      !isGitError(error) ||
      error.code !== "NOT_AUTHENTICATED"
    ) {
      return errorSummary(method, error, credential.login);
    }
    try {
      const refreshed = await refreshGithubAppCredential({ force: true });
      if (!refreshed) return disconnectedSummary(method);
      credential = refreshed;
      verified = await verifyGithubToken(refreshed.accessToken);
    } catch (refreshError) {
      return errorSummary(method, refreshError, credential.login);
    }
  }
  {
    const { login } = verified;
    if (credential.method === "github-app") {
      const installationCount = credential.installationCount;
      const activeInstallationCount = credential.activeInstallationCount;
      const health =
        installationCount === 0
          ? "not-installed"
          : installationCount !== undefined && activeInstallationCount === 0
            ? "suspended"
            : "connected";
      return {
        method,
        health,
        configured: true,
        login,
        ...(credential.expiresAtMs
          ? { expiresAtMs: credential.expiresAtMs }
          : {}),
        ...(installationCount !== undefined ? { installationCount } : {}),
        ...(activeInstallationCount !== undefined
          ? { activeInstallationCount }
          : {}),
        ...(credential.repositoryCount !== undefined
          ? { repositoryCount: credential.repositoryCount }
          : {}),
        ...(credential.allRepositories !== undefined
          ? { allRepositories: credential.allRepositories }
          : {}),
        ...(health === "not-installed"
          ? {
              detail:
                "Your account is authorized, but the GitHub App is not installed anywhere.",
            }
          : health === "suspended"
            ? {
                detail:
                  "Every GitHub App installation for this account is suspended.",
              }
            : {}),
      };
    }
    return {
      method,
      health: "connected",
      configured: true,
      login,
    };
  }
}

export async function getGithubAuthSnapshot(
  refreshAppInstallations = false,
): Promise<GithubAuthSnapshot> {
  const selectedMethod = await githubCredentialStore.getSelectedMethod();
  const [cli, app, pat] = await Promise.all([
    detectGhCli().catch(() => ({
      available: false,
      authenticated: false,
      configured: false,
      health: "unavailable" as const,
      login: undefined,
      detail: "GitHub CLI authentication could not be checked.",
    })),
    storedMethodSummary("github-app", refreshAppInstallations),
    storedMethodSummary("pat"),
  ]);

  const cliSummary: GithubCredentialSummary =
    githubCredentialStore.isExplicitlyDisconnected()
      ? disconnectedSummary("gh-cli", {
          available: cli.available,
          detail: cli.available
            ? "GitHub CLI is disconnected from Zeros."
            : "GitHub CLI is not installed.",
        })
      : cli.health === "connected"
        ? {
            method: "gh-cli",
            health: "connected",
            configured: true,
            available: true,
            ...(cli.login ? { login: cli.login } : {}),
          }
        : cli.configured
          ? {
              method: "gh-cli",
              health: cli.health,
              configured: true,
              available: cli.available,
              ...(cli.login ? { login: cli.login } : {}),
              ...(cli.detail ? { detail: cli.detail } : {}),
            }
          : cli.health === "unavailable"
            ? {
                method: "gh-cli",
                health: "unavailable",
                configured: false,
                available: cli.available,
                detail:
                  cli.detail ??
                  "GitHub CLI authentication could not be checked.",
              }
            : disconnectedSummary("gh-cli", {
                available: cli.available,
                detail: cli.available
                  ? "GitHub CLI is installed but not signed in."
                  : "GitHub CLI is not installed.",
              });

  const snapshot: GithubAuthSnapshot = {
    selectedMethod,
    methods: {
      "gh-cli": cliSummary,
      "github-app": app,
      pat,
    },
  };
  if (rejectedPatToken) {
    const current = await githubCredentialStore.get("pat");
    if (
      current?.method !== "pat" ||
      current.accessToken !== rejectedPatToken
    ) {
      // A remove/replace won the race; this rejection describes an older copy.
      rejectedPatToken = null;
    } else if (selectedMethod === "pat" && pat.health === "connected") {
      // The same token GitHub rejected now passes a fresh identity probe. The
      // engine deliberately kept it out of memory until this evidence arrived.
      rejectedPatToken = null;
      await pushGithubCredentialToEngine();
    }
  }
  return snapshot;
}

export const ghAuthSnapshot: CommandHandler = async (args) =>
  getGithubAuthSnapshot(args.refreshApp === true);

/** Switch to an already-configured method. Validation happens before commit. */
export const ghMethodSelect: CommandHandler = async (args) => {
  const method = requireMethod(args, "gh_method_select");
  let credential =
    method === "gh-cli"
      ? await githubCredentialStore.get("gh-cli")
      : method === "github-app"
        ? await refreshGithubAppCredential().catch((error: unknown) =>
            throwGithubAppCommandError(error, "gh_method_select"),
          )
        : await githubCredentialStore.get(method);
  if (!credential) {
    const label =
      method === "gh-cli"
        ? "GitHub CLI is not signed in"
        : method === "pat"
          ? "Add a personal access token first"
          : "Connect the GitHub App first";
    throw new Error(label);
  }
  try {
    await verifyGithubToken(credential.accessToken);
  } catch (error) {
    if (
      method !== "github-app" ||
      !isGitError(error) ||
      error.code !== "NOT_AUTHENTICATED"
    ) {
      throw error;
    }
    credential = await refreshGithubAppCredential({ force: true }).catch(
      (refreshError: unknown) =>
        throwGithubAppCommandError(refreshError, "gh_method_select"),
    );
    if (!credential) throw error;
    await verifyGithubToken(credential.accessToken);
  }
  await githubCredentialStore.setSelectedMethod(method);
  methodSelectionRevision += 1;
  if (method === "pat") rejectedPatToken = null;
  await pushGithubCredentialToEngine();
  return getGithubAuthSnapshot();
};

/** Validate and atomically replace the PAT slot, then select it. */
export const ghPatConnect: CommandHandler = async (args) => {
  const token = requireString(args, "token", "gh_pat_connect");
  const previous = await githubCredentialStore.get("pat");
  const { login } = await verifyGithubToken(token);
  const next: GithubCredential = {
    method: "pat",
    accessToken: token,
    login,
    gitHost: GITHUB_GIT_HOST,
    gitHttpUsername: GITHUB_GIT_HTTP_USERNAME,
  };
  await githubCredentialStore.set("pat", next);
  try {
    await githubCredentialStore.setSelectedMethod("pat");
  } catch (error) {
    if (previous) await githubCredentialStore.set("pat", previous);
    else await githubCredentialStore.clear("pat");
    throw error;
  }
  methodSelectionRevision += 1;
  patUndoStore.clear();
  patUndoSelectionRevision = null;
  rejectedPatToken = null;
  await pushGithubCredentialToEngine();
  // Return the post-write snapshot so Settings never has to re-probe to learn
  // about a write it just made — a failed follow-up probe used to leave the row
  // reading "not connected" underneath a success toast.
  return { login, snapshot: await getGithubAuthSnapshot() };
};

/** Compact, secret-free account of what the control plane actually answered,
 * plus the remediation that differs between two states the user-facing copy
 * deliberately merges. Renders only our own error envelope — the bounded
 * operator `message`, `code`, and `status` — never headers, tokens, or nonces. */
function describeFlowCause(cause: unknown): string {
  if (!(cause instanceof GithubAppClientError)) {
    return cause instanceof Error ? `(${cause.name}: ${cause.message})` : "";
  }
  const remedy =
    cause.status === 404 && cause.code === "not_found"
      ? " — this control plane serves no /v1/github/* routes at all; the " +
        "backend is behind main, redeploy it"
      : cause.code === "github_not_configured"
        ? " — the control plane is current but no GitHub App is registered " +
          "for it; set GITHUB_APP_ID / _CLIENT_ID / _CLIENT_SECRET / _SLUG " +
          "and GITHUB_OAUTH_CALLBACK_URL"
        : cause.status === 404
          ? " — a 404 that did not come from our router; check the " +
            "control-plane origin and any proxy in front of it"
          : "";
  return `(control plane: HTTP ${cause.status} ${cause.code}${remedy})`;
}

/** Electron drops custom error properties and prefixes the renderer's rejection
 * with `Error invoking remote method …`, so a GitHub App failure is re-thrown as
 * a `NativeCommandError`: its reason travels in the error name (the one field
 * that survives) and its message is already a sentence Settings can show. */
function throwGithubAppCommandError(
  error: unknown,
  context: string,
  fallback?: string,
): never {
  if (error instanceof GithubAppFlowError) {
    // The user-facing sentence is deliberately vague about the control plane;
    // the log must not be. Without this the ONLY record of a failed connect was
    // Electron's own "Error occurred in handler for 'zeros:invoke'" line, which
    // repeats the already-mapped message — so "isn't available yet" read
    // identically whether the backend was undeployed (404), deployed without a
    // registration (503), or behind a proxy answering someone else's 404.
    console.error(
      `[Zeros] ${context} failed: ${error.reason}`,
      describeFlowCause(error.cause),
    );
    throw new NativeCommandError(error.message, error.reason);
  }
  // Not a flow failure. Handlers that own their whole error surface pass a
  // fallback sentence; the rest re-throw so a GitError's own remediation still
  // reaches the UI unchanged.
  if (!fallback) throw error;
  console.error(`[Zeros] ${context} failed:`, error);
  throw new NativeCommandError(fallback, "oauth_failed");
}

/** Wrap a GitHub-auth handler so its failures survive Electron IPC.
 *
 * Electron keeps only `name` and `message` when a handler rejects, so a
 * `GitError`'s `code` and `remediation` were silently dropped: Settings showed a
 * bare message with no next step, and the analytics funnel recorded every PAT /
 * CLI failure as "unknown". `NativeCommandError` puts the code in the one field
 * that survives (see packages/core/src/native-error.ts). */
export function withNativeErrors(handler: CommandHandler): CommandHandler {
  return async (args, event) => {
    try {
      return await handler(args, event);
    } catch (error) {
      if (error instanceof GithubAppFlowError) {
        throw new NativeCommandError(error.message, error.reason);
      }
      if (isGitError(error)) {
        throw new NativeCommandError(
          error.remediation
            ? `${error.message} ${error.remediation}`
            : error.message,
          error.code,
        );
      }
      throw error;
    }
  };
}

/** Begin the backend-bound browser authorization. New connections use the App
 * install URL; reconnects use direct OAuth + S256 PKCE to avoid creating a
 * duplicate installation. */
export const ghAppConnect: CommandHandler = async (args) => {
  try {
    await beginGithubAppConnection(args.installFlow !== false);
  } catch (error) {
    throwGithubAppCommandError(
      error,
      "gh_app_connect",
      "The GitHub App connection could not be started. Try again.",
    );
  }
  return null;
};

export const ghAppCancel: CommandHandler = () => {
  cancelGithubAppConnection();
  return null;
};

/** Remove only the addressed method. Active App/PAT falls back to gh CLI. */
export const ghMethodDisconnect: CommandHandler = async (args) => {
  const method = requireMethod(args, "gh_method_disconnect");
  const selected = await githubCredentialStore.getSelectedMethod();
  let undo: { id: string; expiresAtMs: number } | undefined;
  let fallbackSelectionRevision: number | null = null;
  if (method === "gh-cli") {
    await githubCredentialStore.markExplicitlyDisconnected();
  } else {
    const changesSelection = selected === method;
    if (changesSelection) {
      // Commit the non-secret fallback before deleting/revoking a credential.
      // If the settings write fails, the selected credential remains intact.
      await githubCredentialStore.setFallbackMethod("gh-cli");
      methodSelectionRevision += 1;
      fallbackSelectionRevision = methodSelectionRevision;
    }
    try {
      if (method === "github-app") {
        const removed = await disconnectGithubApp().catch((error: unknown) =>
          throwGithubAppCommandError(error, "gh_method_disconnect"),
        );
        if (!removed) {
          throw new Error(
            "The GitHub App connection changed while it was disconnecting. Try again.",
          );
        }
      } else {
        const previous = await githubCredentialStore.get("pat");
        await githubCredentialStore.clear(method);
        rejectedPatToken = null;
        if (previous?.method === "pat") {
          undo = patUndoStore.stash(previous, changesSelection);
        }
      }
    } catch (error) {
      if (changesSelection) {
        // Restore only if our fallback is still active and the credential
        // survived. A concurrent selection/credential update wins.
        try {
          const [currentSelection, credential] = await Promise.all([
            githubCredentialStore.getSelectedMethod(),
            githubCredentialStore.get(method),
          ]);
          if (
            currentSelection === "gh-cli" &&
            credential &&
            fallbackSelectionRevision === methodSelectionRevision
          ) {
            await githubCredentialStore.setSelectedMethod(method);
            methodSelectionRevision += 1;
          }
        } catch {
          // Preserve the destructive operation's original failure. Any
          // surviving credential remains available for an explicit reselect.
        }
      }
      throw error;
    }
  }
  patUndoSelectionRevision = undo ? methodSelectionRevision : null;
  await pushGithubCredentialToEngine();
  return {
    snapshot: await getGithubAuthSnapshot(),
    ...(undo ? { undoId: undo.id, undoExpiresAtMs: undo.expiresAtMs } : {}),
  };
};

/** Restore a just-removed PAT by opaque, single-use handle. The credential
 * never crosses IPC; this writes the main-process copy back to safeStorage. */
export const ghPatRestore: CommandHandler = async (args) => {
  const undoId = requireString(args, "undoId", "gh_pat_restore");
  if (await githubCredentialStore.get("pat")) {
    patUndoStore.clear();
    patUndoSelectionRevision = null;
    throw new Error(
      "A Personal Access Token is already configured. It was not replaced.",
    );
  }
  const pending = patUndoStore.take(undoId);
  if (!pending) {
    throw new Error("This Personal Access Token undo has expired.");
  }
  try {
    await githubCredentialStore.set("pat", pending.credential);
  } catch (error) {
    // `take` is single-use so concurrent clicks cannot both commit. If the
    // secure write fails, put that exact handle back with its original expiry
    // instead of discarding the only recoverable copy of the removed PAT.
    patUndoStore.restore(pending);
    throw error;
  }
  const selected = await githubCredentialStore.getSelectedMethod();
  if (
    pending.wasSelected &&
    selected === "gh-cli" &&
    patUndoSelectionRevision === methodSelectionRevision
  ) {
    await githubCredentialStore.setSelectedMethod("pat");
    methodSelectionRevision += 1;
  }
  patUndoSelectionRevision = null;
  rejectedPatToken = null;
  await pushGithubCredentialToEngine();
  return getGithubAuthSnapshot();
};

/** Engine-originated invalidation. Clear only the reported slot and keep the
 *  selected row visible so Settings can offer the right reconnect action. */
export const ghCredentialClear: CommandHandler = async (args) => {
  const method = requireMethod(args, "gh_credential_clear");
  if (method === "github-app") {
    try {
      const refreshed = await refreshGithubAppCredential({ force: true });
      if (refreshed) await pushGithubCredentialToEngine();
    } catch {
      // The engine already discarded the rejected working copy. A transient
      // backend outage keeps the durable rotating pair for the quiet scheduler
      // to retry; it must not re-seed the known-rejected access token.
    }
    return null;
  }
  if (method === "pat") {
    // The engine already discarded this rejected working copy. Keep the
    // hand-entered durable PAT so Settings can re-verify it and the user can
    // reselect it after a transient GitHub incident; pushing here would only
    // feed the known-rejected token straight back into the engine.
    const current = await githubCredentialStore.get("pat");
    rejectedPatToken =
      current?.method === "pat" ? current.accessToken : null;
    return null;
  }
  if (method === "gh-cli") {
    await githubCredentialStore.markExplicitlyDisconnected();
  }
  await pushGithubCredentialToEngine();
  return null;
};
