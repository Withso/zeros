// Unpackaged electron:cloud only. Main consumes a private, one-use launcher
// handoff before the first window loads. Normal Local and release auth never
// enter this path; the existing encrypted session store survives restarts.
import fs from "node:fs";
import path from "node:path";
import type { webcrypto } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { validateWorkOSDesktopTokenClaims, type WorkOSDesktopClientConfig, type WorkOSDesktopSession } from "./workos-desktop-client";
import type { MainAuthSession } from "./ipc/commands/auth-session";

interface Descriptor {
  version: 1; owner: string; runId: string; port: number; nonce: string; expiresAt: number;
  subject: string; email: string; organizationId: string; desktopClientId: string;
}
interface Tokens { accessToken: string; refreshToken: string }
const refused = () => new Error("Automatic desktop sign-in refused an invalid private handoff");

function consumePrivateJson(file: string): any {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 128 * 1024 || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 ||
        (process.getuid && stat.uid !== process.getuid())) throw refused();
    const text = fs.readFileSync(fd, "utf8");
    fs.unlinkSync(file); // Consume before parsing, verification or any await.
    return JSON.parse(text);
  } finally { fs.closeSync(fd); }
}

/** Reuse the production desktop claim validator, with signed fixture-org
 * selection in addition. No refresh or unverified token import is needed. */
export async function verifyCloudDesktopSession(tokens: Tokens, descriptor: Descriptor, config: WorkOSDesktopClientConfig,
  key: webcrypto.CryptoKey | JWTVerifyGetKey = createRemoteJWKSet(new URL(config.jwksUrl))): Promise<WorkOSDesktopSession> {
  if (![tokens.accessToken, tokens.refreshToken].every(v => typeof v === "string" && v.length >= 16 && v.length < 64 * 1024) ||
      config.clientId !== descriptor.desktopClientId) throw refused();
  const { payload } = await jwtVerify(tokens.accessToken, key as JWTVerifyGetKey, { issuer: config.issuer, audience: config.audience,
    algorithms: ["RS256"], requiredClaims: ["exp", "iat", "sub", "sid", "jti", "client_id", "org_id"] });
  const claims = validateWorkOSDesktopTokenClaims(payload, config);
  if (claims.providerSubject !== descriptor.subject || claims.email !== descriptor.email.toLowerCase() || payload.org_id !== descriptor.organizationId) throw refused();
  return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken,
    providerSubject: claims.providerSubject, sessionId: claims.sessionId, expiresAt: claims.expiresAt * 1000,
    clientKind: "desktop", email: claims.email, name: claims.displayName, authenticationMethod: "Password" };
}

export async function bootstrapCloudDesktopSession(options: {
  isPackaged: boolean; localDevelopment: boolean; env: NodeJS.ProcessEnv; dataDirectory: string;
  getSession: () => Promise<MainAuthSession | null>;
  getStoredUser: () => Omit<MainAuthSession, "accessToken"> | null;
  verify: (tokens: Tokens, descriptor: Descriptor) => Promise<WorkOSDesktopSession>;
  resolveAccountId: (accessToken: string) => Promise<string>;
  persistSession: (session: WorkOSDesktopSession & { accountId: string }) => void;
  request?: typeof fetch;
}): Promise<"skipped" | "existing" | "signed-in"> {
  const { env } = options;
  if (options.isPackaged || options.localDevelopment || env.ZEROS_CHANNEL !== "dev" || env.ZEROS_DEV_ENVIRONMENT !== "local" ||
      env.ZEROS_ISOLATE !== "1" || !env.ZEROS_CLOUD_DESKTOP_HANDOFF) return "skipped";
  const file = env.ZEROS_CLOUD_DESKTOP_HANDOFF, directory = path.dirname(file);
  const base = path.resolve(options.dataDirectory, "..", "desktop-sign-in");
  if (path.dirname(directory) !== base || path.basename(file) !== "request.json" || !/^[a-f0-9-]{36}$/.test(path.basename(directory))) throw refused();
  // Main HMR retains the original environment after the first consume.
  if (!fs.existsSync(file)) return "skipped";
  for (const dir of [base, directory]) {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw refused();
  }
  const d = consumePrivateJson(file) as Descriptor, profile = JSON.parse(env.ZEROS_DEV_AUTH_PROFILE ?? "null");
  if (d?.version !== 1 || d.owner !== profile?.owner || env.ZEROS_INSTANCE !== `local-${d.owner}` ||
      d.runId !== path.basename(directory) || !Number.isSafeInteger(d.expiresAt) || d.expiresAt <= Date.now() || d.expiresAt > Date.now() + 10 * 60_000 ||
      !/^[A-Za-z0-9_-]{43}$/.test(d.nonce) || !Number.isInteger(d.port) || d.port < 1024 || d.port > 65535 ||
      d.desktopClientId !== env.AUTH_DESKTOP_CLIENT_ID || !d.subject || !d.organizationId || typeof d.email !== "string") throw refused();
  const session = await options.getSession();
  if (session) {
    if (session.provider !== "workos" || session.sub !== d.subject || session.email.toLowerCase() !== d.email.toLowerCase()) throw new Error("Automatic sign-in preserved a different saved session");
    return "existing";
  }
  // A transient refresh/keychain failure must not overwrite saved credentials.
  if (options.getStoredUser()) throw new Error("Automatic sign-in preserved the saved session; retry when authentication is available");
  const request = options.request ?? fetch;
  const call = async (suffix: string) => {
    const response = await request(`http://127.0.0.1:${d.port}/desktop-sign-in${suffix}`, { method: "POST", redirect: "error",
      signal: AbortSignal.timeout(40_000), headers: { authorization: `Bearer ${d.nonce}` } });
    await response.body?.cancel(); if (response.status !== 204) throw refused();
  };
  await call("");
  const tokens = consumePrivateJson(path.join(directory, "session.json"));
  if (tokens?.version !== 1 || tokens.owner !== d.owner || tokens.runId !== d.runId || tokens.nonce !== d.nonce ||
      !Number.isSafeInteger(tokens.expiresAt) || tokens.expiresAt <= Date.now() || tokens.expiresAt > Date.now() + 60_000) throw refused();
  const verified = await options.verify(tokens, d);
  const accountId = await options.resolveAccountId(verified.accessToken);
  if (options.getStoredUser()) throw new Error("Automatic sign-in preserved a concurrently installed saved session");
  options.persistSession({ ...verified, accountId });
  await call("/complete");
  return "signed-in";
}

/** Called only by unpackaged main, before any window or auth monitor starts. */
export async function signInCloudDesktop(): Promise<void> {
  const { IS_PACKAGED, IS_LOCAL_DEVELOPMENT } = await import("./runtime-mode");
  if (IS_PACKAGED || IS_LOCAL_DEVELOPMENT || process.env.ZEROS_DEV_ENVIRONMENT !== "local" || !process.env.ZEROS_CLOUD_DESKTOP_HANDOFF) return;
  const { app } = await import("electron");
  const { desktopAuthConfig } = await import("./workos-desktop-config");
  const { devWorkOSConfigurationIssue, workspaceDevAuthProfile } = await import("./dev-workos-auth-policy");
  const { appBaseUrl } = await import("./app-base-url");
  const { controlPlaneBaseUrl, resolveWorkOSDesktopAccountId } = await import("./workos-desktop-account");
  const { controlPlaneFetch } = await import("./control-plane-fetch");
  const { getValidSessionForMain, getSessionUserForMain, persistWorkOSSession } = await import("./ipc/commands/auth-session");
  const auth = desktopAuthConfig();
  if (auth.provider !== "workos" || devWorkOSConfigurationIssue({ auth, appOrigin: appBaseUrl(), controlPlaneOrigin: controlPlaneBaseUrl(),
    localProfile: workspaceDevAuthProfile(), isolated: process.env.ZEROS_ISOLATE === "1" })) throw refused();
  await bootstrapCloudDesktopSession({ isPackaged: IS_PACKAGED, localDevelopment: IS_LOCAL_DEVELOPMENT, env: process.env,
    dataDirectory: app.getPath("userData"), getSession: getValidSessionForMain, getStoredUser: getSessionUserForMain,
    verify: (tokens, descriptor) => verifyCloudDesktopSession(tokens, descriptor, {
      clientId: auth.desktopClientId, issuer: auth.issuer, audience: auth.audience, jwksUrl: auth.jwksUrl }),
    resolveAccountId: accessToken => resolveWorkOSDesktopAccountId(accessToken, controlPlaneFetch), persistSession: persistWorkOSSession });
}
