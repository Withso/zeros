import { statfs } from "node:fs/promises";

export function publicationMinimumFreeBytes(value: string | undefined): bigint {
  if (value === undefined) return 0n;
  if (!/^(?:0|[1-9]\d{0,14})$/.test(value)) {
    throw new Error("Publication disk budget must be a nonnegative byte count");
  }
  return BigInt(value);
}

export type PublicationDiskBudget = {
  directory: string;
  additionalDirectories?: readonly string[];
  minimumFreeBytes: bigint;
  pollIntervalMs?: number;
  readFreeBytes?: () => Promise<bigint>;
  report?: (message: string) => void;
};

export async function withPublicationDiskBudget<T>(
  budget: PublicationDiskBudget,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  if (budget.minimumFreeBytes === 0n) return operation(controller.signal);
  if (
    budget.minimumFreeBytes < 0n ||
    !Number.isFinite(budget.pollIntervalMs ?? 5_000) ||
    (budget.pollIntervalMs ?? 5_000) < 1
  ) {
    throw new Error("Publication disk budget is invalid");
  }
  const readFreeBytes =
    budget.readFreeBytes ??
    (async () => {
      const directories = new Set([
        budget.directory,
        ...(budget.additionalDirectories ?? []),
      ]);
      const available = await Promise.all(
        [...directories].map(async (directory) => {
          const filesystem = await statfs(directory, { bigint: true });
          return filesystem.bavail * filesystem.bsize;
        }),
      );
      return available.reduce((minimum, bytes) =>
        bytes < minimum ? bytes : minimum,
      );
    });
  const check = async () => {
    let available: bigint;
    try {
      available = await readFreeBytes();
    } catch {
      throw new Error("Publication disk headroom could not be measured");
    }
    if (available < budget.minimumFreeBytes) {
      throw new Error(
        `Publication disk headroom exhausted: ${available} bytes available, ${budget.minimumFreeBytes} bytes reserved`,
      );
    }
  };
  await check();
  let finished = false;
  let failure: Error | undefined;
  let timer: ReturnType<typeof setTimeout>;
  // Schedule after each read, so a slow filesystem cannot accumulate checks.
  const poll = async () => {
    try {
      await check();
    } catch (error) {
      if (finished) return;
      failure = error as Error;
      try {
        budget.report?.(failure.message);
      } catch {
        /* Diagnostics must not prevent cancellation. */
      }
      controller.abort(failure);
    }
    if (!finished && !failure)
      timer = setTimeout(() => {
        void poll();
      }, budget.pollIntervalMs ?? 5_000);
  };
  timer = setTimeout(() => {
    void poll();
  }, budget.pollIntervalMs ?? 5_000);
  try {
    const result = await operation(controller.signal);
    if (failure) throw failure;
    return result;
  } catch (error) {
    throw failure ?? error;
  } finally {
    finished = true;
    clearTimeout(timer);
  }
}
