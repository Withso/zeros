export type ClientReleaseChannel = "alpha" | "beta" | "production" | "dev";
export type ClientUpgradeRequired = {
  minimumVersion: string;
  latestVersion: string;
};

const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/;

export function clientReleaseChannel(channel: unknown): ClientReleaseChannel {
  if (channel === "stable" || channel === "production") return "production";
  return channel === "alpha" || channel === "beta" ? channel : "dev";
}

function validVersion(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 128 &&
    VERSION_PATTERN.test(value)
  );
}

export function desktopClientHeader(channel: unknown, version: string): string {
  return `desktop/${clientReleaseChannel(channel)}/${validVersion(version) ? version : "unknown"}`;
}

export function isDesktopVersionAtLeast(
  candidate: string,
  minimum: string,
): boolean {
  if (!validVersion(candidate)) return false;
  if (!minimum) return true;
  if (!validVersion(minimum)) return false;
  const left = VERSION_PATTERN.exec(candidate)!;
  const right = VERSION_PATTERN.exec(minimum)!;
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(left[index]) - Number(right[index]);
    if (difference !== 0) return difference > 0;
  }
  const leftPre = left[4]?.split(".") ?? [];
  const rightPre = right[4]?.split(".") ?? [];
  if (!leftPre.length || !rightPre.length) return !leftPre.length;
  for (
    let index = 0;
    index < Math.max(leftPre.length, rightPre.length);
    index += 1
  ) {
    const leftPart = leftPre[index];
    const rightPart = rightPre[index];
    if (leftPart === undefined || rightPart === undefined)
      return rightPart === undefined;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric)
      return leftPart.length === rightPart.length
        ? leftPart > rightPart
        : leftPart.length > rightPart.length;
    if (leftNumeric !== rightNumeric) return !leftNumeric;
    return leftPart > rightPart;
  }
  return true;
}

export function parseClientUpgradeRequired(
  value: unknown,
): ClientUpgradeRequired | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    (raw.minimumVersion !== "" && !validVersion(raw.minimumVersion)) ||
    (raw.latestVersion !== "" && !validVersion(raw.latestVersion))
  )
    return null;
  return {
    minimumVersion: raw.minimumVersion as string,
    latestVersion: raw.latestVersion as string,
  };
}

export function mergeClientUpgradeRequired(
  previous: ClientUpgradeRequired | null,
  next: ClientUpgradeRequired,
): ClientUpgradeRequired {
  if (!previous) return next;
  const minimumVersion = isDesktopVersionAtLeast(
    next.minimumVersion,
    previous.minimumVersion,
  )
    ? next.minimumVersion
    : previous.minimumVersion;
  const latestVersion = isDesktopVersionAtLeast(
    next.latestVersion,
    previous.latestVersion,
  )
    ? next.latestVersion
    : previous.latestVersion;
  return minimumVersion === previous.minimumVersion &&
    latestVersion === previous.latestVersion
    ? previous
    : { minimumVersion, latestVersion };
}

async function readUpgradeRequired(
  response: Response,
): Promise<ClientUpgradeRequired> {
  const fallback = { minimumVersion: "", latestVersion: "" };
  const reader = response.clone().body?.getReader();
  if (!reader) return fallback;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = (async () => {
    let bytes = 0;
    let text = "";
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 16_384) return fallback;
        text += decoder.decode(chunk.value, { stream: true });
      }
      const raw = JSON.parse(text + decoder.decode()) as {
        error?: { code?: string };
      } | null;
      return raw?.error?.code === "client_upgrade_required"
        ? (parseClientUpgradeRequired(raw.error) ?? fallback)
        : fallback;
    } catch {
      return fallback;
    } finally {
      void reader.cancel().catch(() => {});
    }
  })();
  const timeout = new Promise<ClientUpgradeRequired>((resolve) => {
    timer = setTimeout(() => {
      void reader.cancel().catch(() => {});
      resolve(fallback);
    }, 2_000);
  });
  try {
    return await Promise.race([read, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

type ClientCompatibilityFetch = (
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
  beforeRequest?: () => void,
) => Promise<Response>;

const CLIENT_HEADER_REJECTION_TTL_MS = 10 * 60_000;
const MAX_CLIENT_HEADER_REJECTION_ORIGINS = 32;

function clientRequestOrigin(
  input: Parameters<typeof fetch>[0],
): string | null {
  try {
    const environment = globalThis as typeof globalThis & {
      location?: { href: string };
    };
    const origin = new URL(
      input instanceof Request ? input.url : input,
      environment.location?.href,
    ).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

export function createClientCompatibilityFetch(options: {
  header: () => string | Promise<string>;
  requireUpgrade: (required: ClientUpgradeRequired) => void;
  fetch?: typeof fetch;
}): ClientCompatibilityFetch {
  const headerRejections = new Map<string, number>();
  return async (input, init, beforeRequest) => {
    const now = Date.now();
    for (const [origin, expiresAt] of headerRejections)
      if (expiresAt <= now) headerRejections.delete(origin);
    const origin = clientRequestOrigin(input);
    const includeHeader = origin === null || !headerRejections.has(origin);
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    if (includeHeader) {
      const identity = options.header();
      headers.set(
        "X-Zeros-Client",
        typeof identity === "string" ? identity : await identity,
      );
    } else {
      headers.delete("X-Zeros-Client");
    }
    const send = () =>
      (options.fetch ?? globalThis.fetch)(input, {
        ...init,
        headers: Object.fromEntries(headers.entries()),
      });
    let response: Response;
    beforeRequest?.();
    try {
      response = await send();
    } catch (error) {
      if (
        !includeHeader ||
        !(error instanceof TypeError) ||
        (method !== "GET" && method !== "HEAD")
      )
        throw error;
      headers.delete("X-Zeros-Client");
      beforeRequest?.();
      response = await send();
      if (origin !== null) {
        headerRejections.delete(origin);
        headerRejections.set(
          origin,
          Date.now() + CLIENT_HEADER_REJECTION_TTL_MS,
        );
        if (headerRejections.size > MAX_CLIENT_HEADER_REJECTION_ORIGINS) {
          const oldestOrigin = headerRejections.keys().next().value;
          if (oldestOrigin !== undefined) headerRejections.delete(oldestOrigin);
        }
      }
    }
    if (response.status === 426)
      options.requireUpgrade(await readUpgradeRequired(response));
    return response;
  };
}
