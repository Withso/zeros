import { secretsFilePath } from "./secret-store";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { BrowserSubscriptionProvider } from "@zeros/protocol/provider-auth";

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
