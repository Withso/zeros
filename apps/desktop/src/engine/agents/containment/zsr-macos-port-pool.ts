import { randomBytes } from "node:crypto";

const MIN_BIND_PORT = 30_000;
const MAX_BIND_PORT = 65_535;
const PORT_SPAN = MAX_BIND_PORT - MIN_BIND_PORT + 1;
const MAX_POOL_SIZE = 64;
export const DEFAULT_MACOS_BIND_PORT_POOL_SIZE = 32;

const processReservations = new Set<number>();

export interface MacosPortPoolReservation {
  readonly ports: readonly number[];
  release(): void;
}

interface ReserveMacosPortPoolOptions {
  readonly size?: number;
  readonly excludedPorts: readonly number[];
  /** Deterministic seam for collision and exhaustion tests. */
  readonly randomUInt32?: () => number;
}

/** Reserve a process-wide set of high TCP ports for one immutable Seatbelt
 * generation. The native interposer still handles ambient host collisions by
 * trying another member; this registry prevents two live boundaries owned by
 * the same engine from ever receiving overlapping authority. */
export function reserveMacosPortPool(
  options: ReserveMacosPortPoolOptions,
): MacosPortPoolReservation {
  const size = options.size ?? DEFAULT_MACOS_BIND_PORT_POOL_SIZE;
  if (!Number.isInteger(size) || size < 1 || size > MAX_POOL_SIZE) {
    throw new Error("invalid macOS bind-port pool size");
  }
  const excluded = new Set(options.excludedPorts);
  if (
    [...excluded].some(
      (port) => !Number.isInteger(port) || port < 1 || port > 65_535,
    )
  ) {
    throw new Error("invalid excluded macOS bind port");
  }
  const randomUInt32 =
    options.randomUInt32 ?? (() => randomBytes(4).readUInt32BE(0));
  const selected: number[] = [];
  try {
    while (selected.length < size) {
      const start = Math.abs(randomUInt32()) % PORT_SPAN;
      let allocated: number | undefined;
      for (let offset = 0; offset < PORT_SPAN; offset += 1) {
        const candidate = MIN_BIND_PORT + ((start + offset) % PORT_SPAN);
        if (excluded.has(candidate) || processReservations.has(candidate)) {
          continue;
        }
        processReservations.add(candidate);
        selected.push(candidate);
        allocated = candidate;
        break;
      }
      if (allocated === undefined) {
        throw new Error("macOS bind-port pool is exhausted");
      }
    }
  } catch (error) {
    for (const port of selected) processReservations.delete(port);
    throw error;
  }
  selected.sort((left, right) => left - right);
  let released = false;
  return {
    ports: Object.freeze([...selected]),
    release() {
      if (released) return;
      released = true;
      for (const port of selected) processReservations.delete(port);
    },
  };
}
