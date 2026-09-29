import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSecretIfAbsent, getSecret, replaceSecretIfUnchanged, watchSecrets } from "./secret-store";

/** Only expiring OAuth callback routing is shared. Each workspace continues to
 * keep tokens, provider credentials and account state in its own secret store. */
export function localDevCallbackStore(home = os.homedir()) {
  let directory = fs.realpathSync(home);
  for (const name of [".zeros-dev", "callbacks"]) {
    directory = path.join(directory, name);
    try { fs.mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory ||
        (typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
        (stat.mode & (name === "callbacks" ? 0o077 : 0o022)) !== 0) {
      throw new Error("Unsafe Dev callback directory");
    }
  }
  return callbackStore(directory);
}

function callbackStore(directory: string) {
  const file = path.join(directory, "secrets.json");
  const validate = (account: string) => {
    if (!["auth-workos:dev-callbacks", "github-app:dev-callbacks"].includes(account)) throw new Error("Invalid Dev callback store account");
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory ||
        (typeof process.getuid === "function" && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0) {
      throw new Error("Unsafe Dev callback directory");
    }
    if (fs.existsSync(file)) {
      const value = fs.lstatSync(file);
      if (!value.isFile() || value.isSymbolicLink() || value.size > 128 * 1024 ||
          (typeof process.getuid === "function" && value.uid !== process.getuid()) || (value.mode & 0o077) !== 0) {
        throw new Error("Unsafe Dev callback file");
      }
    }
  };
  return {
    read: (account: string) => { validate(account); return getSecret(account, file); },
    create: (account: string, value: string) => { validate(account); return createSecretIfAbsent(account, value, file); },
    replace: (account: string, before: string, after: string | null) => {
      validate(account); return replaceSecretIfUnchanged(account, before, after, file);
    },
    watch: (callback: (accounts: readonly string[]) => void) => {
      validate("auth-workos:dev-callbacks"); return watchSecrets(callback, file);
    },
  };
}
