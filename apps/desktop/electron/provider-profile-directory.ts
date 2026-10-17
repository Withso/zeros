import { secretsFilePath } from "./secret-store";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { BrowserSubscriptionProvider } from "@zeros/protocol/provider-auth";
import { IS_LOCAL_DEVELOPMENT } from "./runtime-mode";

/** These paths are minted by main, never supplied by a renderer or repository.
 * Keep the UUID path stable: providers may namespace keychain entries by it. */
export function providerProfileDirectory(
  provider: BrowserSubscriptionProvider,
  id: string,
): string {
  if (id !== "unconnected" && !/^[0-9a-f-]{36}$/i.test(id))
    throw new Error("Invalid account profile.");
  const root = path.join(
    path.dirname(secretsFilePath()),
    "provider-accounts",
    provider,
  );
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const directory = path.join(root, id);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

/** New native-managed macOS accounts use the OS credential store. Existing
 * profiles and external CLI configuration retain their storage choice. */
export function createProviderAccountProfile(
  provider: BrowserSubscriptionProvider,
  id: string,
  platform = process.platform,
): string {
  const directory = providerProfileDirectory(provider, id);
  if (provider === "codex" && platform === "darwin") {
    try {
      writeFileSync(
        path.join(directory, "config.toml"),
        'cli_auth_credentials_store = "keyring"\n',
        { flag: "wx", mode: 0o600 },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  return directory;
}

/** Migrated Local profiles keep their original path/keychain namespace. They
 * must still be removable without allowing a native logout in arbitrary roots. */
export function isOwnedProviderProfileDirectory(
  provider: BrowserSubscriptionProvider,
  id: string,
  directory: string,
): boolean {
  if (directory === providerProfileDirectory(provider, id)) return true;
  if (!IS_LOCAL_DEVELOPMENT || !/^[0-9a-f-]{36}$/i.test(id)) return false;
  const sharedRoot = path.dirname(secretsFilePath());
  const legacyRoot = path.resolve(directory, "../../..");
  const suffix = path
    .basename(legacyRoot)
    .slice(path.basename(sharedRoot).length);
  return (
    path.dirname(legacyRoot) === path.dirname(sharedRoot) &&
    path.basename(legacyRoot).startsWith(path.basename(sharedRoot)) &&
    /^\.[a-f0-9]{16}$/.test(suffix) &&
    directory === path.join(legacyRoot, "provider-accounts", provider, id)
  );
}
