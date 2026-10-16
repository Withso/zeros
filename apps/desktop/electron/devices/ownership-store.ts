// Which simulators Zeros booted, in a private file in userData. Only these
// are ever shut down by idle shutdown or on quit, including after a crash.

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { isSimulatorDeviceId } from "@zeros/protocol/simulators";

import type { DeviceOwnershipStore } from "./device-hub";

const MAX_BYTES = 64 * 1024;
const MAX_DEVICES = 64;

export function readOwnershipDocument(text: string): string[] {
  try {
    const document = JSON.parse(text) as { version?: unknown; devices?: unknown };
    if (document?.version !== 1 || !Array.isArray(document.devices)) return [];
    return [...new Set(document.devices.filter(isSimulatorDeviceId))].slice(0, MAX_DEVICES);
  } catch {
    return [];
  }
}

export function fileOwnershipStore(filePath: string): DeviceOwnershipStore {
  let writes = Promise.resolve();
  return {
    async load() {
      let handle;
      try {
        handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch {
        return [];
      }
      try {
        const metadata = await handle.stat();
        if (
          !metadata.isFile() ||
          metadata.size > MAX_BYTES ||
          metadata.uid !== process.getuid?.()
        ) {
          return [];
        }
        return readOwnershipDocument(await handle.readFile("utf8"));
      } finally {
        await handle.close();
      }
    },
    save(deviceIds) {
      const devices = [...new Set(deviceIds.filter(isSimulatorDeviceId))].slice(0, MAX_DEVICES);
      const write = async () => {
        await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
        const temporary = `${filePath}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, `${JSON.stringify({ version: 1, devices })}\n`, {
            flag: "wx",
            mode: 0o600,
          });
          await rename(temporary, filePath);
        } finally {
          await rm(temporary, { force: true });
        }
      };
      // In order, so an older list never lands after a newer one.
      const next = writes.then(write, write);
      writes = next.catch(() => undefined);
      return next;
    },
  };
}
