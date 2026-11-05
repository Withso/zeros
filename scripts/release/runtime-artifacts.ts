import { constants } from "node:fs";
import { mkdir, open, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { PromotionError, requireCheck } from "./contracts";

export async function readRuntimeJson(path: string): Promise<unknown> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat(); requireCheck(stat.isFile() && stat.size <= 64 * 1024, "invalid file");
      const bytes = await file.readFile(); requireCheck(bytes.length <= 64 * 1024, "invalid size");
      return JSON.parse(bytes.toString("utf8"));
    } finally { await file.close(); }
  } catch { throw new PromotionError("Runtime artifact must be bounded regular JSON; details withheld"); }
}

export async function writeRuntimeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
}
