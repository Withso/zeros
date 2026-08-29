/** Provider deletion calls may return before inventory converges. Qualification
 * is allowed to report cleanup only after a fresh provider inventory proves
 * the exact resource is absent. */

export interface ResourceAbsenceOptions {
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  readonly checkTimeoutMs?: number;
}

function validateResourceLabel(label: string): void {
  if (
    !label ||
    Buffer.byteLength(label, "utf8") > 512 ||
    /[\0\r\n]/.test(label)
  ) {
    throw new Error("provider cleanup resource label is invalid");
  }
}

export async function runBoundedProviderOperation<T>(
  label: string,
  operation: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  validateResourceLabel(label);
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 2 * 60 * 60_000
  ) {
    throw new Error("provider operation timeout is invalid");
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function validatedOptions(options: ResourceAbsenceOptions): {
  timeoutMs: number;
  pollMs: number;
  checkTimeoutMs: number;
} {
  const timeoutMs = options.timeoutMs ?? 90_000;
  const pollMs = options.pollMs ?? 1_000;
  const checkTimeoutMs = options.checkTimeoutMs ?? Math.min(30_000, timeoutMs);
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 5 * 60_000 ||
    !Number.isSafeInteger(pollMs) ||
    pollMs < 1 ||
    pollMs > 5_000 ||
    !Number.isSafeInteger(checkTimeoutMs) ||
    checkTimeoutMs < 1 ||
    checkTimeoutMs > 60_000
  ) {
    throw new Error("provider cleanup verification options are invalid");
  }
  return { timeoutMs, pollMs, checkTimeoutMs };
}

export async function waitForResourceAbsence(
  label: string,
  isPresent: () => Promise<boolean>,
  options: ResourceAbsenceOptions = {},
): Promise<void> {
  validateResourceLabel(label);
  const { timeoutMs, pollMs, checkTimeoutMs } = validatedOptions(options);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let present: boolean;
    try {
      present = await Promise.race([
        isPresent(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${label} inventory check timed out`)),
            Math.min(checkTimeoutMs, Math.max(1, deadline - Date.now())),
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (typeof present !== "boolean") {
      throw new Error(
        `${label} inventory returned an invalid presence verdict`,
      );
    }
    if (!present) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`${label} is still present after provider deletion`);
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(pollMs, remaining)),
    );
  }
}

interface SandboxInventory {
  list(query: {
    id: string;
    limit: number;
  }): AsyncIterable<{ readonly id: string }>;
}

export async function verifySandboxAbsent(
  inventory: SandboxInventory,
  sandboxId: string,
  options: ResourceAbsenceOptions = {},
): Promise<void> {
  if (
    !sandboxId ||
    Buffer.byteLength(sandboxId, "utf8") > 256 ||
    /[\0\r\n]/.test(sandboxId)
  ) {
    throw new Error("sandbox cleanup identity is invalid");
  }
  await waitForResourceAbsence(
    `sandbox ${sandboxId}`,
    async () => {
      for await (const sandbox of inventory.list({
        id: sandboxId,
        limit: 100,
      })) {
        if (sandbox.id === sandboxId) return true;
      }
      return false;
    },
    options,
  );
}

interface SnapshotInventory {
  list(
    page?: number,
    limit?: number,
  ): Promise<{
    readonly items: readonly {
      readonly name: string;
    }[];
    readonly totalPages: number;
  }>;
}

export async function verifySnapshotNameAbsent(
  inventory: SnapshotInventory,
  snapshotName: string,
  options: ResourceAbsenceOptions = {},
): Promise<void> {
  if (
    !snapshotName ||
    Buffer.byteLength(snapshotName, "utf8") > 256 ||
    /[\0\r\n]/.test(snapshotName)
  ) {
    throw new Error("snapshot cleanup identity is invalid");
  }
  await waitForResourceAbsence(
    `snapshot ${snapshotName}`,
    async () => {
      for (let page = 1; page <= 1_000; page++) {
        const result = await inventory.list(page, 100);
        if (
          !Number.isSafeInteger(result.totalPages) ||
          result.totalPages < 0 ||
          result.totalPages > 1_000
        ) {
          throw new Error("snapshot inventory pagination is invalid");
        }
        if (result.items.some((snapshot) => snapshot.name === snapshotName)) {
          return true;
        }
        if (page >= result.totalPages) return false;
      }
      throw new Error("snapshot inventory exceeded 1000 pages");
    },
    options,
  );
}
