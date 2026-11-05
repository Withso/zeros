import { closeSync, constants, fsyncSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export interface RuntimePermit {
  arm(id: string): void;
  revoke(): void;
}

/** Atomic consumption races Stop's unlink on the VM, so a provider command
 * delayed after HTTP admission cannot acquire a retired quiet worker. */
export function runtimePermit(directory: string, bootId: string): RuntimePermit {
  const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
  if (!uuid.test(bootId)) throw new Error("Invalid runtime boot.");
  const root = join(directory, "runtime-handoffs");
  let path: string | undefined;
  return {
    arm(id) {
      if (!uuid.test(id)) throw new Error("Invalid runtime handoff.");
      if (path) throw new Error("Runtime permit is already armed.");
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const next = join(root, `permit-${id}-${bootId}`);
      const fd = openSync(next, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      path = next;
      try { fsyncSync(fd); } finally { closeSync(fd); }
      const parent = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY);
      try { fsyncSync(parent); } finally { closeSync(parent); }
    },
    revoke() {
      if (!path) return;
      try { unlinkSync(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      path = undefined;
    },
  };
}
