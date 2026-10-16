import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { PromotionError, requireCheck } from "./contracts";

type AlphaReleaseEdit = Readonly<{ repository: string; sha: string; title: string; notes: string }>;
type EditPorts = {
  run: (args: readonly string[], signal?: AbortSignal) => Promise<void>;
  wait: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  report: (message: string) => void;
};
const exec = promisify(execFile);
const defaults: EditPorts = {
  run: async (args, signal) => {
    // Capture subprocess output: gh can include private response text in errors.
    await exec("gh", [...args], { encoding: "utf8", maxBuffer: 16 * 1024, signal });
  },
  wait: async (milliseconds, signal) => { await delay(milliseconds, undefined, { signal }); },
  report: message => console.log(message),
};

function active(signal?: AbortSignal): void {
  if (signal?.aborted) throw new PromotionError("Alpha release edit cancelled; publication stopped.");
}

/** gh's single HTTP error line must identify this repository's release object. */
function releaseServerError(error: unknown, repository: string): number | null {
  if (!error || typeof error !== "object") return null;
  const failure = error as { code?: unknown; killed?: unknown; signal?: unknown; stderr?: unknown };
  if (failure.code !== 1 || failure.killed || failure.signal || typeof failure.stderr !== "string") return null;
  const match = /^HTTP (5\d{2})(?:: [^\r\n()]{1,256})? \(https:\/\/api\.github\.com\/repos\/([^/\s()]+\/[^/\s()]+)\/releases\/[1-9]\d*\)\r?\n?$/.exec(failure.stderr);
  // Compare the unnormalized repository exactly; other operations and URLs refuse.
  if (!match || match[2] !== repository) return null;
  return Number(match[1]);
}

/** Repeating these exact metadata values is idempotent inside Alpha's publication lock. */
export async function editAlphaRelease(input: AlphaReleaseEdit, signal?: AbortSignal, ports: EditPorts = defaults): Promise<void> {
  requireCheck(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(input.repository)
    && /^[a-f0-9]{40}$/i.test(input.sha)
    && input.title.length > 0 && input.title.length <= 1024
    && input.notes.length > 0 && input.notes.length <= 65_536,
  "Alpha release edit inputs are invalid; publication stopped.");
  const args = Object.freeze(["release", "edit", "alpha", "--repo", input.repository,
    "--prerelease", "--title", input.title, "--notes", input.notes, "--target", input.sha]);
  for (let attempt = 1; attempt <= 3; attempt++) {
    active(signal);
    try {
      await ports.run(args, signal);
      active(signal);
      return;
    } catch (error) {
      active(signal);
      const status = releaseServerError(error, input.repository);
      if (status !== null) ports.report(`Alpha release edit returned HTTP ${status} (attempt ${attempt}/3).`);
      if (status === null || attempt === 3) {
        throw new PromotionError("Alpha release metadata edit failed; publication stopped. Private diagnostics withheld.");
      }
      try { await ports.wait(attempt * 1000, signal); }
      catch {
        active(signal);
        throw new PromotionError("Alpha release edit backoff failed; publication stopped.");
      }
    }
  }
}
