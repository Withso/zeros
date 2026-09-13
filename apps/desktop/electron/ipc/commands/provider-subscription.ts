import { readSelectedProviderUsage } from "../../provider-usage";
import { readClaudeUsage, readCursorUsage } from "../../provider-usage-readers";
import { app, shell } from "electron";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  providerSubscriptionActionSchema,
  providerUsageIdentity,
  type BrowserSubscriptionProvider,
} from "@zeros/protocol/provider-auth";
import {
  readSettingsFile,
  userSettingsPath,
  managedSettingsPath,
} from "../../../src/engine/settings/files";
import { resolveSettings } from "../../../src/engine/settings/resolve";
import {
  ProviderSubscriptionController,
  SubscriptionError,
} from "../../provider-subscription-controller";
import {
  createSubscriptionDriver,
  subscriptionEnvironment,
  type SubscriptionRuntime,
} from "../../provider-subscription-drivers";
import { resolveClaudeCliPaths, resolveCodexCliPaths } from "../../sidecar";
import {
  cursorSubscriptionController,
  loginCursorSubscription,
} from "./cursor-subscription";
import { ProviderAccountManager } from "../../provider-account-manager";
import {
  readProviderAccounts,
  updateProviderAccounts,
  type StoredProviderAccount,
} from "../../provider-account-store";
import { providerProfileDirectory } from "../../provider-profile-directory";
import { readLegacyCursorSubscription } from "../../provider-credentials";
import { pushProviderCredentialsToEngine } from "../../sidecar";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { emitEvent } from "../events";
import type { CommandHandler } from "../router";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function resolveRuntime(
  provider: "claude" | "codex",
  configDir?: string,
): Promise<SubscriptionRuntime> {
  const user = readSettingsFile(userSettingsPath());
  const managed = readSettingsFile(managedSettingsPath());
  if (user.error || managed.error) throw new SubscriptionError("runtime");
  const { effective } = resolveSettings({
    user: user.doc,
    managed: managed.doc,
  });
  const providers = effective.providers;
  const cfg =
    isPlainObject(providers) && isPlainObject(providers[provider])
      ? providers[provider]
      : {};
  // Only trusted device/managed configuration can select an auth executable.
  // The renderer and the selected (possibly remote) workspace supply no paths.
  const override =
    typeof cfg.executable_path === "string" ? cfg.executable_path.trim() : "";
  const binary =
    override ||
    (provider === "claude"
      ? resolveClaudeCliPaths().binary
      : resolveCodexCliPaths().binary);
  try {
    if (!binary || !path.isAbsolute(binary) || !(await stat(binary)).isFile())
      throw new Error();
    await access(binary, constants.X_OK);
  } catch {
    throw new SubscriptionError("runtime");
  }
  const root = path.join(app.getPath("userData"), "provider-auth");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const cwd = await mkdtemp(path.join(root, `${provider}-`));
  return {
    command: binary!,
    cwd,
    env: {
      ...subscriptionEnvironment(process.env),
      ...(configDir
        ? {
            [provider === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"]:
              configDir,
          }
        : {}),
    },
    cleanup: () => rm(cwd, { recursive: true, force: true }),
  };
}

const managers = new Map<BrowserSubscriptionProvider, ProviderAccountManager>();
function managerFor(
  provider: BrowserSubscriptionProvider,
): ProviderAccountManager {
  let manager = managers.get(provider);
  if (manager) return manager;
  const driverFor = (account: StoredProviderAccount | null) =>
    createSubscriptionDriver(provider as "claude" | "codex", {
      resolveRuntime: () =>
        resolveRuntime(provider as "claude" | "codex", account?.configDir),
      openBrowser: (url) => shell.openExternal(url),
    });
  manager = new ProviderAccountManager({
    readStore: () => readProviderAccounts(provider),
    updateStore: (update) => updateProviderAccounts(provider, update),
    createProfile: async (id) =>
      provider === "cursor"
        ? undefined
        : providerProfileDirectory(provider, id),
    read: async (account, signal) => {
      if (provider !== "cursor") return driverFor(account).read(signal);
      const credential = account?.credential ?? readLegacyCursorSubscription();
      return credential
        ? {
            state:
              credential.expiresAtMs > Date.now() ? "connected" : "expired",
            email: credential.email,
            expiresAtMs: credential.expiresAtMs,
          }
        : { state: "disconnected" };
    },
    login: async (account, options) => {
      if (provider !== "cursor")
        return { account: await driverFor(account).login(options) };
      const result = await loginCursorSubscription(options.signal);
      if (
        !result.apiKey ||
        !Number.isFinite(result.apiKeyExpiresAtMs) ||
        result.apiKeyExpiresAtMs <= Date.now()
      )
        throw new SubscriptionError("failed");
      return {
        account: {
          state: "connected",
          email: result.email,
          expiresAtMs: result.apiKeyExpiresAtMs,
        },
        credential: {
          apiKey: result.apiKey,
          email: result.email,
          expiresAtMs: result.apiKeyExpiresAtMs,
        },
      };
    },
    discard: async (account) => {
      if (!account.configDir || provider === "cursor") return;
      // Logout only a main-owned isolated profile; never touch the device CLI.
      if (account.configDir !== providerProfileDirectory(provider, account.id))
        throw new SubscriptionError("failed");
      const runtime = await resolveRuntime(provider, account.configDir);
      try {
        await promisify(execFile)(
          runtime.command,
          provider === "claude" ? ["auth", "logout"] : ["logout"],
          {
            env: runtime.env,
            cwd: runtime.cwd,
            timeout: 15_000,
            maxBuffer: 65_536,
          },
        );
      } finally {
        await runtime.cleanup();
      }
      // Native transcripts remain available for history; the provider owns the
      // credential removal and keychain namespace used by its logout command.
    },
    changed: pushProviderCredentialsToEngine,
  });
  managers.set(provider, manager);
  return manager;
}

const controllers = new Map<
  BrowserSubscriptionProvider,
  ProviderSubscriptionController
>();
function controllerFor(
  provider: BrowserSubscriptionProvider,
): ProviderSubscriptionController {
  let controller = controllers.get(provider);
  if (!controller) {
    const driver = managerFor(provider);
    controller = new ProviderSubscriptionController(
      provider,
      driver,
      (status) => {
        emitEvent("provider-subscription-status", status);
        // OAuth URLs/codes/tokens never enter IPC events. Invalidate account-scoped
        // tools even if a cancellation raced a provider credential-store commit.
        if (status.attemptId && status.state !== "connecting")
          emitEvent("provider-auth-changed", {});
      },
    );
    controllers.set(provider, controller);
  }
  return controller;
}

export const providerSubscription: CommandHandler = (args) => {
  const parsed = providerSubscriptionActionSchema.safeParse(args);
  // Zod diagnostics can contain user-supplied values. Never echo a pasted code.
  if (!parsed.success)
    throw new Error("Invalid subscription connection request.");
  const request = parsed.data;
  const controller = controllerFor(request.provider);
  switch (request.action) {
    case "usage":
      return readSelectedProviderUsage(request, {
        readStore: () => readProviderAccounts(request.provider),
        readUsage: async (account, signal) => {
          if (request.provider === "cursor") {
            const credential =
              account?.credential ?? readLegacyCursorSubscription();
            if (!credential || credential.expiresAtMs <= Date.now())
              throw new Error("No usage credential.");
            return {
              ...(await readCursorUsage(credential.apiKey, signal)),
              // This exact credential and its identity came from the same
              // native store snapshot; Cursor has no ambient CLI mode.
              identity: providerUsageIdentity(account ?? credential),
            };
          }
          if (request.provider === "claude")
            return readClaudeUsage(
              account?.configDir ?? process.env.CLAUDE_CONFIG_DIR,
              signal,
            );
          return createSubscriptionDriver("codex", {
            resolveRuntime: () => resolveRuntime("codex", account?.configDir),
            openBrowser: async () => {},
          }).readUsage(signal);
        },
      });
    case "status":
      return controller.status();
    case "connect":
      return controller.connect();
    case "cancel":
      return controller.cancel(request.attemptId);
    case "submit-code":
      return controller.submitCode(request.attemptId, request.code);
    case "select-account":
    case "remove-account":
    case "select-method": {
      return controller.change(async () => {
        const manager = managerFor(request.provider);
        if (request.action === "select-method") {
          if (request.provider === "cursor" && request.method === "cli")
            throw new Error("Cursor does not support CLI connections.");
          await manager.setMethod(request.method);
        } else if (request.action === "remove-account")
          await manager.remove(request.accountId);
        else
          return manager.select(request.accountId, AbortSignal.timeout(20_000));
        return manager.read(AbortSignal.timeout(20_000));
      });
    }
  }
};

export async function stopProviderSubscriptions(): Promise<void> {
  await Promise.allSettled(
    [...controllers.values()].map((controller) => controller.dispose()),
  );
  cursorSubscriptionController.cancel();
}
