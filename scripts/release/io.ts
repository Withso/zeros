import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PromotionError } from "./contracts";
const exec = promisify(execFile);
export type Command = (file: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number }) => Promise<string>;
/** Never inherit child output: provider/driver CLIs can echo secrets. */
export const command: Command = async (file, args, options = {}) => {
  try {
    const result = await exec(file, args, { ...options, timeout: options.timeout ?? 30 * 60_000, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" });
    return result.stdout;
  } catch { throw new PromotionError("Release subprocess failed; output withheld. Reconcile the current stage before retrying."); }
};
export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export async function poll<T>(read: () => Promise<T | false>, options: { attempts?: number; sleep?: typeof sleep; timeoutMs?: number } = {}): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? 30 * 60_000);
  for (let n = 0; n < (options.attempts ?? 180); n++) {
    if (Date.now() >= deadline) break;
    const result = await read();
    if (result !== false) return result;
    await (options.sleep ?? sleep)(10_000);
  }
  throw new PromotionError("Release readiness timed out; no downstream publication is authorized");
}
export function jsonClient(fetcher: typeof fetch = fetch, pause = sleep) {
  return async (url: string, init: RequestInit = {}, readOnly = true): Promise<any> => {
    for (let n = 0; n < (readOnly ? 3 : 1); n++) {
      try {
        const response = await fetcher(url, { ...init, redirect: "error", signal: AbortSignal.timeout(30_000) });
        if (readOnly && [408, 429, 500, 502, 503, 504].includes(response.status) && n < 2) { await pause(1000 * (n + 1)); continue; }
        if (!response.ok) throw new Error("http");
        const bytes = await response.text();
        if (bytes.length > 2 * 1024 * 1024) throw new Error("size");
        return JSON.parse(bytes);
      } catch {
        if (!readOnly || n === 2) throw new PromotionError("Provider request failed; response withheld. Reconcile any unacknowledged mutation before retrying.");
        await pause(1000 * (n + 1));
      }
    }
    throw new PromotionError("Provider request failed");
  };
}
