import { readFile as readFileFromDisk } from "node:fs/promises";

const PROC_TCP_PATHS = ["/proc/net/tcp", "/proc/net/tcp6"] as const;
const MAX_PROC_TABLE_BYTES = 4 * 1024 * 1024;
const MAX_OBSERVED_PORTS = 128;
const TCP_LISTEN_STATE = "0A";

export type CloudObservedWorkspacePort = {
  port: number;
  protocol: "tcp";
};

type ProcReader = (path: string, encoding: "utf8") => Promise<string>;

function portsFromProcTable(table: string): number[] {
  if (Buffer.byteLength(table, "utf8") > MAX_PROC_TABLE_BYTES) return [];
  const ports: number[] = [];
  for (const line of table.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/u);
    if (fields.length < 4 || fields[3] !== TCP_LISTEN_STATE) continue;
    const local = fields[1] ?? "";
    const separator = local.lastIndexOf(":");
    const encodedPort = separator === -1 ? "" : local.slice(separator + 1);
    if (!/^[A-Fa-f0-9]{4}$/u.test(encodedPort)) continue;
    const port = Number.parseInt(encodedPort, 16);
    if (Number.isSafeInteger(port)) ports.push(port);
  }
  return ports;
}

/**
 * Read listeners from the current Linux network namespace. `undefined` means
 * the proc view was unavailable and the control plane must retain its last
 * confirmed observation; an empty array is an authoritative "no listeners"
 * scan. No process arguments, paths, or user data cross this boundary.
 */
export async function readObservedCloudWorkspacePorts(
  options: {
    readFile?: ProcReader;
    excludedPorts?: readonly number[];
  } = {},
): Promise<CloudObservedWorkspacePort[] | undefined> {
  if (process.platform !== "linux" && !options.readFile) return undefined;
  const readFile = options.readFile ?? readFileFromDisk;
  const results = await Promise.allSettled(
    PROC_TCP_PATHS.map((path) => readFile(path, "utf8")),
  );
  const readable = results.filter(
    (result): result is PromiseFulfilledResult<string> =>
      result.status === "fulfilled" && typeof result.value === "string",
  );
  if (readable.length === 0) return undefined;

  const excluded = new Set(options.excludedPorts ?? [22_222, 39_393]);
  const ports = new Set<number>();
  for (const result of readable) {
    for (const port of portsFromProcTable(result.value)) {
      if (port >= 1_024 && port <= 65_535 && !excluded.has(port)) {
        ports.add(port);
      }
    }
  }
  return [...ports]
    .sort((left, right) => left - right)
    .slice(0, MAX_OBSERVED_PORTS)
    .map((port) => ({ port, protocol: "tcp" as const }));
}
