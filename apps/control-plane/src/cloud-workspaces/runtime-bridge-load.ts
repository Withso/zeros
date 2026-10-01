// Local, bounded load harness for CloudRuntimeBridgeRelay.
//
//   pnpm --dir apps/control-plane load:relay
//   pnpm --dir apps/control-plane load:relay -- --scenario realistic --pairs 64
//   pnpm --dir apps/control-plane load:relay -- --help
//
// Everything runs on loopback. Fake desktop clients and fake engines live in
// this process; the relay runs in a forked child, so its resident memory, heap
// and CPU are measured in isolation. No database, provider, network or
// credential is involved. Pairs, duration and the child's resident memory are
// capped, and the child is always killed when a scenario ends.

import { fork, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { CLOUD_RUNTIME_BRIDGE_PATH } from "./engine-client-admission.js";
import {
  CloudRuntimeBridgeRelay,
  type CloudRuntimeRelayStats,
} from "./runtime-bridge.js";
import { cloudRuntimeRelayLimits } from "./runtime-bridge-limits.js";

const MiB = 1024 * 1024;
const CHILD_FLAG = "--relay-load-child";
/** Hard ceilings so a mistyped flag cannot starve a shared machine. */
export const LOAD_HARNESS_CAPS = {
  pairs: 512,
  durationMs: 60_000,
  messageBytes: 64 * MiB,
  relayRssMiB: 6_144,
} as const;

export type LoadTraffic =
  | "idle"
  | "realistic"
  | "max-message"
  | "assembly-hold"
  | "slow-reader";

/** Options forwarded to the relay constructor in the child process. */
export type RelayLoadOptions = Omit<
  ConstructorParameters<typeof CloudRuntimeBridgeRelay>[0],
  "resolve" | "revalidate" | "openUpstream" | "log"
>;

export type LoadScenario = {
  name: string;
  traffic: LoadTraffic;
  /** Pairs to open. Pairs above the relay limit measure refusal. */
  pairs: number;
  /** Pairs given the adversarial pattern; the rest carry realistic traffic. */
  adversarial: number;
  readOnlyPairs?: number;
  /** Pairs are spread round-robin across this many workspaces. */
  workspaces: number;
  durationMs: number;
  /** Size of each adversarial maximum-size message. */
  messageBytes: number;
  relay: RelayLoadOptions;
};

export type LoadResult = {
  scenario: string;
  traffic: LoadTraffic;
  limits: RelayLoadOptions;
  pairs: number;
  admitted: number;
  refused: Record<string, number>;
  admitMs: { p50: number; max: number; total: number };
  memoryMiB: {
    baselineRss: number;
    idleRss: number;
    idleHeapUsed: number;
    peakRss: number;
    peakHeapUsed: number;
    peakExternal: number;
    afterRss: number;
  };
  perPairKiB: { idleRss: number; idleHeap: number; idleExternal: number };
  relayCpuPercent: number;
  driverCpuPercent: number;
  latencyMs: {
    samples: number;
    p50: number;
    p95: number;
    p99: number;
    max: number;
  };
  roundTripMs: { samples: number; p50: number; p95: number; p99: number };
  fairness: {
    healthyPairs: number;
    healthyClosed: number;
    jainDelivery: number;
    worstPairP99Ms: number;
    medianPairP99Ms: number;
  };
  adversarial: {
    pairs: number;
    closed: number;
    medianCloseMs: number | null;
    transferMs: number | null;
    completedTransfers: number;
  };
  relay: {
    peakOutboundMiB: number;
    peakInboundMiB: number;
    /** Non-zero counters only. */
    rejected: Record<string, number>;
    retired: Record<string, number>;
    /** The relay's own operational lines, most recent last. */
    log: string[];
  };
  aborted: string | null;
  durationMs: number;
};

function nonZero(values: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== 0),
  );
}

// ── deterministic helpers ────────────────────────────────────────────────

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Uniform reservoir so long, many-pair runs keep bounded sample memory. */
class Samples {
  private readonly values: Float64Array;
  private count = 0;
  private seen = 0;
  constructor(
    capacity: number,
    private readonly next: () => number,
  ) {
    this.values = new Float64Array(capacity);
  }
  add(value: number): void {
    this.seen += 1;
    if (this.count < this.values.length) {
      this.values[this.count++] = value;
      return;
    }
    const slot = Math.floor(this.next() * this.seen);
    if (slot < this.values.length) this.values[slot] = value;
  }
  get size(): number {
    return this.seen;
  }
  sorted(): Float64Array {
    return this.values.slice(0, this.count).sort();
  }
}

function at(sorted: Float64Array, quantile: number): number {
  if (sorted.length === 0) return Number.NaN;
  return sorted[
    Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))
  ]!;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function round(value: number, digits = 1): number {
  const scale = 10 ** digits;
  return Number.isFinite(value) ? Math.round(value * scale) / scale : value;
}

/** Load tokens carry only a pair index; the relay child maps it to a fake
 * workspace. They match the production token shape but authorize nothing. */
function tokenFor(index: number): string {
  return `zws_${`load${index.toString(36).padStart(8, "0")}`.padEnd(43, "A")}`;
}
function indexOf(token: string): number {
  return Number.parseInt(token.slice(8, 16), 36);
}

const padding = new Map<number, string>();
/** JSON text frame shaped like an engine event, stamped for latency. */
function frame(kind: string, stamp: number, bytes: number): string {
  const head = `{"t":${stamp.toFixed(3)},"k":"${kind}","p":"`;
  const length = Math.max(0, bytes - head.length - 2);
  let fill = padding.get(length);
  if (fill === undefined) {
    fill = "x".repeat(length);
    padding.set(length, fill);
  }
  return `${head}${fill}"}`;
}
function stampOf(data: Buffer): { stamp: number; kind: number } | null {
  const comma = data.indexOf(44, 5);
  if (comma < 0) return null;
  return {
    stamp: Number(data.toString("latin1", 5, comma)),
    kind: data[comma + 6] ?? 0,
  };
}

// ── raw RFC 6455 framing for adversarial peers ────────────────────────────
// Adversarial peers write and discard frames directly so the driver never
// assembles the multi-megabyte messages it sends through the relay.

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Clients mask with this fixed key, as browsers do with random ones, so the
 * relay pays the real unmask cost. Large payloads are pre-masked blocks. */
const CLIENT_MASK = Buffer.from([0x3c, 0xa5, 0x5a, 0xc3]);

function frameHeader(opcode: number, length: number, masked: boolean): Buffer {
  const extended = length < 126 ? 0 : length < 65_536 ? 2 : 8;
  const header = Buffer.alloc(2 + extended + (masked ? 4 : 0));
  header[0] = 0x80 | opcode;
  header[1] =
    (masked ? 0x80 : 0) |
    (extended === 0 ? length : extended === 2 ? 126 : 127);
  if (extended === 2) header.writeUInt16BE(length, 2);
  if (extended === 8) header.writeBigUInt64BE(BigInt(length), 2);
  if (masked) CLIENT_MASK.copy(header, header.length - 4);
  return header;
}

/** Counts complete messages, discards payloads and answers pings. */
class DiscardingReader {
  private readonly header = Buffer.alloc(14);
  private headerLength = 0;
  private remaining = 0;
  private opcode = 0;
  private final = false;
  private inPayload = false;
  private control: Buffer[] = [];
  constructor(
    private readonly onMessage: () => void,
    private readonly onPing: (payload: Buffer) => void,
  ) {}
  feed(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      if (!this.inPayload) {
        this.header[this.headerLength++] = chunk[offset++]!;
        if (this.headerLength < 2) continue;
        const length7 = this.header[1]! & 0x7f;
        const needed =
          2 +
          (length7 === 126 ? 2 : length7 === 127 ? 8 : 0) +
          (this.header[1]! & 0x80 ? 4 : 0);
        if (this.headerLength < needed) continue;
        this.opcode = this.header[0]! & 0x0f;
        this.final = (this.header[0]! & 0x80) !== 0;
        this.remaining =
          length7 === 126
            ? this.header.readUInt16BE(2)
            : length7 === 127
              ? Number(this.header.readBigUInt64BE(2))
              : length7;
        this.headerLength = 0;
        this.inPayload = true;
        this.control = [];
      }
      const take = Math.min(this.remaining, chunk.length - offset);
      if (this.opcode >= 8 && take > 0)
        this.control.push(chunk.subarray(offset, offset + take));
      offset += take;
      this.remaining -= take;
      if (this.remaining > 0) return;
      this.inPayload = false;
      if (this.opcode === 9) this.onPing(Buffer.concat(this.control));
      else if (this.opcode < 8 && this.final) this.onMessage();
    }
  }
}

function waitWritable(socket: Duplex): Promise<boolean> {
  if (socket.destroyed) return Promise.resolve(false);
  return new Promise((resolve) => {
    const done = (value: boolean) => {
      socket.off("drain", drained);
      socket.off("close", closed);
      resolve(value);
    };
    const drained = () => done(true);
    const closed = () => done(false);
    socket.on("drain", drained);
    socket.on("close", closed);
  });
}

/** Writes a binary frame declaring `declared` bytes but sends only `sent`. */
async function writeLargeFrame(
  socket: Duplex,
  declared: number,
  sent: number,
  masked: boolean,
): Promise<boolean> {
  // Every slice starts at a multiple of the block size, so a pre-masked block
  // stays aligned with the four-byte masking key.
  const block = payloadBlock(masked);
  if (
    !socket.write(frameHeader(2, declared, masked)) &&
    !(await waitWritable(socket))
  )
    return false;
  for (let offset = 0; offset < sent; offset += block.length) {
    if (socket.destroyed) return false;
    const slice = block.subarray(0, Math.min(block.length, sent - offset));
    if (!socket.write(slice) && !(await waitWritable(socket))) return false;
  }
  return !socket.destroyed;
}
const blocks = new Map<boolean, Buffer>();
function payloadBlock(masked: boolean): Buffer {
  let block = blocks.get(masked);
  if (!block) {
    block = Buffer.alloc(MiB);
    if (masked)
      for (let index = 0; index < block.length; index++)
        block[index] = CLIENT_MASK[index & 3]!;
    blocks.set(masked, block);
  }
  return block;
}

function writePong(socket: Duplex, payload: Buffer, masked: boolean): void {
  if (socket.destroyed || socket.writableEnded) return;
  const body = Buffer.from(payload);
  if (masked)
    for (let index = 0; index < body.length; index++)
      body[index] = body[index]! ^ CLIENT_MASK[index & 3]!;
  socket.write(Buffer.concat([frameHeader(10, body.length, masked), body]));
}

type RawPeer = { socket: Socket; reader: DiscardingReader };

/** Client-side handshake by hand so adversarial frames reach the relay intact. */
function rawClient(
  port: number,
  token: string,
  onMessage: () => void,
): Promise<RawPeer | { refused: string }> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    const key = randomBytes(16).toString("base64");
    let head = Buffer.alloc(0);
    let settled = false;
    const reader = new DiscardingReader(onMessage, (payload) =>
      writePong(socket, payload, true),
    );
    const finish = (value: RawPeer | { refused: string }) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    socket.on("error", () => finish({ refused: "socket" }));
    socket.on("close", () => finish({ refused: "closed" }));
    socket.on("connect", () => {
      socket.write(
        `GET ${CLOUD_RUNTIME_BRIDGE_PATH} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
          "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n" +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Protocol: zeros-v1, ` +
          `zeros-cloud-token.${Buffer.from(token).toString("base64url")}\r\n\r\n`,
      );
    });
    const onData = (chunk: Buffer) => {
      if (settled) {
        reader.feed(chunk);
        return;
      }
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return;
      const status = /^HTTP\/1\.1 (\d{3})/.exec(head.toString("latin1", 0, 16));
      if (status?.[1] !== "101") {
        finish({ refused: status?.[1] ?? "invalid" });
        socket.destroy();
        return;
      }
      finish({ socket, reader });
      const rest = head.subarray(end + 4);
      if (rest.length > 0) reader.feed(rest);
    };
    socket.on("data", onData);
  });
}

function rawAccept(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  onMessage: () => void,
): { socket: Duplex; reader: DiscardingReader } {
  const accept = createHash("sha1")
    .update(`${request.headers["sec-websocket-key"]}${WEBSOCKET_GUID}`)
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n" +
      `Connection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  const reader = new DiscardingReader(onMessage, (payload) =>
    writePong(socket, payload, false),
  );
  socket.on("data", (chunk: Buffer) => reader.feed(chunk));
  if (head.length > 0) reader.feed(head);
  return { socket, reader };
}

// ── relay child ───────────────────────────────────────────────────────────

type ChildConfig = {
  enginePort: number;
  workspaces: number;
  relay: RelayLoadOptions;
  lifetimeMs: number;
  readOnlyFrom: number;
};
type MemorySample = {
  rss: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
};
type ChildSample = {
  memory: MemorySample;
  peak: MemorySample;
  cpuMicros: number;
  relay: CloudRuntimeRelayStats;
  logs: string[];
};
type ChildRequest = {
  id: number;
  type: "sample";
  gc: boolean;
  resetPeak: boolean;
};

async function relayChild(): Promise<void> {
  const config = JSON.parse(
    process.env.ZEROS_RELAY_LOAD_CONFIG ?? "{}",
  ) as ChildConfig;
  // Never outlive the driver: exit with the IPC channel or after a hard cap.
  process.on("disconnect", () => process.exit(0));
  setTimeout(() => process.exit(3), config.lifetimeMs).unref();
  const logs: string[] = [];
  const relay = new CloudRuntimeBridgeRelay({
    ...config.relay,
    log: (line) => {
      logs.push(line);
      if (logs.length > 40) logs.shift();
    },
    resolve: async (token) => ({
      workspaceId: `workspace-${indexOf(token) % config.workspaces}`,
      organizationId: "organization",
      generation: 1,
      authorityEpoch: 1,
      engineInstanceId: "engine",
      resourceId: "resource",
      readOnly: indexOf(token) >= config.readOnlyFrom,
      endpoint: { url: "https://relay-load.invalid/" },
    }),
    revalidate: async () => true,
    openUpstream: (_url, options) =>
      new WebSocket(`ws://127.0.0.1:${config.enginePort}/ws`, options),
  });
  const server = createServer((_request, response) => {
    response.statusCode = 404;
    response.end();
  });
  server.on("upgrade", (request, socket, head) => {
    if (!relay.handleUpgrade(request, socket, head)) socket.destroy();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");

  const read = (): MemorySample => {
    const usage = process.memoryUsage();
    return {
      rss: usage.rss,
      heapUsed: usage.heapUsed,
      external: usage.external,
      arrayBuffers: usage.arrayBuffers,
    };
  };
  let peak = read();
  const track = () => {
    const now = read();
    peak = {
      rss: Math.max(peak.rss, now.rss, process.resourceUsage().maxRSS * 1024),
      heapUsed: Math.max(peak.heapUsed, now.heapUsed),
      external: Math.max(peak.external, now.external),
      arrayBuffers: Math.max(peak.arrayBuffers, now.arrayBuffers),
    };
    return now;
  };
  setInterval(track, 20).unref();
  const collect = (globalThis as { gc?: () => void }).gc;
  process.on("message", (message: ChildRequest) => {
    if (message.type !== "sample") return;
    if (message.gc && collect) {
      collect();
      collect();
    }
    const memory = track();
    const sample: ChildSample = {
      memory,
      peak,
      cpuMicros: (() => {
        const cpu = process.cpuUsage();
        return cpu.user + cpu.system;
      })(),
      relay: relay.stats(),
      logs: [...logs],
    };
    if (message.resetPeak) peak = memory;
    process.send?.({ type: "sample", id: message.id, sample });
  });
  process.send?.({ type: "ready", port: address.port });
}

class RelayProcess {
  private nextId = 1;
  private readonly waiting = new Map<number, (sample: ChildSample) => void>();
  private constructor(
    readonly child: ChildProcess,
    readonly port: number,
  ) {
    child.on(
      "message",
      (message: { type: string; id?: number; sample?: ChildSample }) => {
        if (
          message.type !== "sample" ||
          message.id === undefined ||
          !message.sample
        )
          return;
        this.waiting.get(message.id)?.(message.sample);
        this.waiting.delete(message.id);
      },
    );
  }
  static async start(
    config: ChildConfig,
    execArgv: string[],
  ): Promise<RelayProcess> {
    const child = fork(fileURLToPath(import.meta.url), [CHILD_FLAG], {
      execArgv,
      env: { ...process.env, ZEROS_RELAY_LOAD_CONFIG: JSON.stringify(config) },
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("relay child did not start"));
      }, 30_000);
      child.once("error", () => {
        clearTimeout(timer);
        reject(new Error("relay child could not start"));
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`relay child exited (${code})`));
      });
      child.on("message", (message: { type: string; port?: number }) => {
        if (message.type !== "ready" || message.port === undefined) return;
        clearTimeout(timer);
        resolve(message.port);
      });
    });
    return new RelayProcess(child, port);
  }
  sample(
    options: { gc?: boolean; resetPeak?: boolean } = {},
  ): Promise<ChildSample> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error("relay child sample timed out"));
      }, 10_000);
      this.waiting.set(id, (sample) => {
        clearTimeout(timer);
        resolve(sample);
      });
      this.child.send(
        {
          id,
          type: "sample",
          gc: options.gc ?? false,
          resetPeak: options.resetPeak ?? false,
        } satisfies ChildRequest,
        (error) => {
          if (!error) return;
          clearTimeout(timer);
          this.waiting.delete(id);
          reject(new Error("relay child unavailable"));
        },
      );
    });
  }
  async stop(): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      const exited = once(this.child, "exit");
      this.child.kill("SIGKILL");
      await exited;
    }
  }
}

// ── fake engine and fake clients ──────────────────────────────────────────

type Pair = {
  index: number;
  role: "healthy" | "adversarial";
  readOnly: boolean;
  client: WebSocket | null;
  rawClient: RawPeer | null;
  engine: WebSocket | null;
  rawEngine: { socket: Duplex; reader: DiscardingReader } | null;
  admitted: boolean;
  closedAt: number | null;
  sentBytes: number;
  receivedBytes: number;
  latencies: Samples;
  clientMessages: number;
  engineMessages: number;
  engineReady: () => void;
  engineOpened: Promise<void>;
};

class FakeEngine {
  readonly server: Server;
  private readonly sockets = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: 128 * MiB,
  });
  constructor(
    private readonly pairs: Map<number, Pair>,
    private readonly rawEngine: (pair: Pair) => boolean,
    private readonly onEngine: (pair: Pair) => void,
  ) {
    this.server = createServer((_request, response) => {
      response.statusCode = 404;
      response.end();
    });
    this.server.on("upgrade", (request, socket, head) => {
      socket.on("error", () => {});
      const token = request.headers["x-zeros-cloud-token"];
      const pair =
        typeof token === "string" ? this.pairs.get(indexOf(token)) : undefined;
      if (!pair || request.url !== "/ws") {
        socket.destroy();
        return;
      }
      if (this.rawEngine(pair)) {
        pair.rawEngine = rawAccept(request, socket, head, () => {
          pair.engineMessages += 1;
        });
        pair.engineReady();
        this.onEngine(pair);
        return;
      }
      this.sockets.handleUpgrade(request, socket, head, (engine) => {
        engine.on("error", () => {});
        pair.engine = engine;
        pair.engineReady();
        this.onEngine(pair);
      });
    });
  }
  async listen(): Promise<number> {
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    return address.port;
  }
  close(): void {
    for (const client of this.sockets.clients) client.terminate();
    this.sockets.close();
    this.server.closeAllConnections();
    this.server.close();
  }
}

/** Per-pair realistic mix: streamed agent tokens, PTY output with bursts,
 * file events with periodic batches, and small client requests. */
type Mix = {
  tokenCredit: number;
  ptyCredit: number;
  nextBurstAt: number;
  nextFileAt: number;
  nextBatchAt: number;
  nextRequestAt: number;
};
const REALISTIC = {
  tokensPerSecond: 40,
  tokenBytes: [160, 280] as const,
  ptyPerSecond: 2,
  ptyBytes: 300,
  burstMessages: 32,
  burstMessageBytes: 8 * 1024,
  burstEveryMs: [1_500, 4_500] as const,
  fileEventEveryMs: 1_000,
  fileEventBytes: 600,
  fileBatchEveryMs: 10_000,
  fileBatchBytes: 32 * 1024,
  requestEveryMs: 1_000,
  requestBytes: 400,
  responseBytes: 2 * 1024,
};

// ── scenario runner ───────────────────────────────────────────────────────

export async function runLoadScenario(
  input: LoadScenario,
  options: { execArgv?: string[]; maxRelayRssMiB?: number } = {},
): Promise<LoadResult> {
  const scenario = boundedScenario(input);
  const maxRelayRss =
    Math.min(options.maxRelayRssMiB ?? 3_072, LOAD_HARNESS_CAPS.relayRssMiB) *
    MiB;
  const next = random(0x5eed + scenario.pairs);
  const pairs = new Map<number, Pair>();
  const latencies = new Samples(400_000, next);
  const roundTrips = new Samples(100_000, next);
  const adversarialCloseMs: number[] = [];
  const transferMs: number[] = [];
  const startedAt = performance.now();
  let trafficStartedAt = 0;
  let aborted: string | null = null;

  for (let index = 0; index < scenario.pairs; index++) {
    let engineReady!: () => void;
    const engineOpened = new Promise<void>((resolve) => {
      engineReady = resolve;
    });
    pairs.set(index, {
      index,
      // Adversarial pairs come last so healthy pairs are admitted first.
      role:
        index >= scenario.pairs - scenario.adversarial
          ? "adversarial"
          : "healthy",
      readOnly: index >= scenario.pairs - (scenario.readOnlyPairs ?? 0),
      client: null,
      rawClient: null,
      engine: null,
      rawEngine: null,
      admitted: false,
      closedAt: null,
      sentBytes: 0,
      receivedBytes: 0,
      latencies: new Samples(512, next),
      clientMessages: 0,
      engineMessages: 0,
      engineReady,
      engineOpened,
    });
  }
  const rawEnds =
    scenario.traffic === "max-message" || scenario.traffic === "assembly-hold";
  const engine = new FakeEngine(
    pairs,
    (pair) => pair.role === "adversarial" && rawEnds,
    (pair) => {
      // A paused (slow) client cannot observe the relay's FIN, so teardown is
      // detected from whichever end closes first.
      const closed = () => {
        pair.closedAt ??= performance.now();
      };
      pair.rawEngine?.socket.on("close", closed);
      const upstream = pair.engine;
      if (!upstream) return;
      upstream.on("close", closed);
      upstream.on("message", (data: RawData, binary: boolean) => {
        pair.engineMessages += 1;
        if (binary || !Buffer.isBuffer(data)) return;
        const stamp = stampOf(data);
        // `r` — a client request; answer it like a workspace read.
        if (stamp?.kind === 114 && upstream.readyState === WebSocket.OPEN)
          upstream.send(frame("s", stamp.stamp, REALISTIC.responseBytes));
      });
    },
  );
  const execArgv = options.execArgv ?? [...process.execArgv, "--expose-gc"];
  let relay: RelayProcess | undefined;
  const driverCpuStart = process.cpuUsage();
  try {
    const enginePort = await engine.listen();
    relay = await RelayProcess.start(
      {
        enginePort,
        workspaces: scenario.workspaces,
        relay: scenario.relay,
        lifetimeMs: scenario.durationMs + 120_000,
        readOnlyFrom: scenario.pairs - (scenario.readOnlyPairs ?? 0),
      },
      execArgv,
    );
    const relayPort = relay.port;
    const baseline = await relay.sample({ gc: true });
    const refused: Record<string, number> = {};
    const admitMs: number[] = [];
    const admitStart = performance.now();
    const ordered = [...pairs.values()];
    for (let offset = 0; offset < ordered.length; offset += 8) {
      await Promise.all(
        ordered.slice(offset, offset + 8).map(async (pair) => {
          const began = performance.now();
          const outcome = await openClient(relayPort, pair, scenario, {
            latencies,
            roundTrips,
            trafficStarted: () => trafficStartedAt,
          });
          if (outcome !== null) {
            refused[outcome] = (refused[outcome] ?? 0) + 1;
            return;
          }
          admitMs.push(performance.now() - began);
          await Promise.race([
            pair.engineOpened,
            new Promise((resolve) => setTimeout(resolve, 5_000)),
          ]);
        }),
      );
    }
    const admitTotal = performance.now() - admitStart;
    const admitted = ordered.filter((pair) => pair.admitted);
    const idle = await relay.sample({ gc: true, resetPeak: true });
    const idleCpu = idle.cpuMicros;
    trafficStartedAt = performance.now();
    const stopTraffic = startTraffic(scenario, admitted, {
      latencies,
      transferMs,
      next,
    });
    const deadline = trafficStartedAt + scenario.durationMs;
    while (performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const sample = await relay.sample();
      if (sample.peak.rss > maxRelayRss) {
        aborted = `relay RSS exceeded ${Math.round(maxRelayRss / MiB)} MiB`;
        break;
      }
      if (process.memoryUsage.rss() > 3 * 1024 * MiB) {
        aborted = "driver RSS exceeded 3072 MiB";
        break;
      }
    }
    await stopTraffic();
    const trafficMs = performance.now() - trafficStartedAt;
    await new Promise((resolve) => setTimeout(resolve, 500));
    const during = await relay.sample();
    const after = await relay.sample({ gc: true });
    for (const pair of admitted)
      if (pair.role === "adversarial" && pair.closedAt !== null)
        adversarialCloseMs.push(pair.closedAt - trafficStartedAt);

    const healthy = admitted.filter((pair) => pair.role === "healthy");
    const ratios = healthy
      .filter((pair) => pair.sentBytes > 0)
      .map((pair) => pair.receivedBytes / pair.sentBytes);
    const jain =
      ratios.length === 0
        ? Number.NaN
        : ratios.reduce((sum, value) => sum + value, 0) ** 2 /
          (ratios.length *
            ratios.reduce((sum, value) => sum + value * value, 0));
    const pairP99 = healthy
      .map((pair) => at(pair.latencies.sorted(), 0.99))
      .filter((value) => Number.isFinite(value));
    const sortedLatency = latencies.sorted();
    const sortedRoundTrip = roundTrips.sorted();
    const count = Math.max(1, admitted.length);
    const driverCpu = process.cpuUsage(driverCpuStart);
    return {
      scenario: scenario.name,
      traffic: scenario.traffic,
      limits: scenario.relay,
      pairs: scenario.pairs,
      admitted: admitted.length,
      refused,
      admitMs: {
        p50: round(median(admitMs) ?? Number.NaN),
        max: round(Math.max(0, ...admitMs)),
        total: round(admitTotal),
      },
      memoryMiB: {
        baselineRss: round(baseline.memory.rss / MiB),
        idleRss: round(idle.memory.rss / MiB),
        idleHeapUsed: round(idle.memory.heapUsed / MiB),
        peakRss: round(during.peak.rss / MiB),
        peakHeapUsed: round(during.peak.heapUsed / MiB),
        peakExternal: round(during.peak.external / MiB),
        afterRss: round(after.memory.rss / MiB),
      },
      perPairKiB: {
        idleRss: round((idle.memory.rss - baseline.memory.rss) / count / 1024),
        idleHeap: round(
          (idle.memory.heapUsed - baseline.memory.heapUsed) / count / 1024,
        ),
        idleExternal: round(
          (idle.memory.external - baseline.memory.external) / count / 1024,
        ),
      },
      relayCpuPercent: round(
        ((during.cpuMicros - idleCpu) / 1_000 / trafficMs) * 100,
      ),
      driverCpuPercent: round(
        ((driverCpu.user + driverCpu.system) /
          1_000 /
          (performance.now() - startedAt)) *
          100,
      ),
      latencyMs: {
        samples: latencies.size,
        p50: round(at(sortedLatency, 0.5), 2),
        p95: round(at(sortedLatency, 0.95), 2),
        p99: round(at(sortedLatency, 0.99), 2),
        max: round(
          sortedLatency.length
            ? sortedLatency[sortedLatency.length - 1]!
            : Number.NaN,
          2,
        ),
      },
      roundTripMs: {
        samples: roundTrips.size,
        p50: round(at(sortedRoundTrip, 0.5), 2),
        p95: round(at(sortedRoundTrip, 0.95), 2),
        p99: round(at(sortedRoundTrip, 0.99), 2),
      },
      fairness: {
        healthyPairs: healthy.length,
        healthyClosed: healthy.filter((pair) => pair.closedAt !== null).length,
        jainDelivery: round(jain, 4),
        worstPairP99Ms: round(
          pairP99.length ? Math.max(...pairP99) : Number.NaN,
          2,
        ),
        medianPairP99Ms: round(median(pairP99) ?? Number.NaN, 2),
      },
      adversarial: {
        pairs: admitted.filter((pair) => pair.role === "adversarial").length,
        closed: adversarialCloseMs.length,
        medianCloseMs: median(adversarialCloseMs),
        transferMs: median(transferMs),
        completedTransfers: transferMs.length,
      },
      relay: {
        peakOutboundMiB: round(after.relay.peakOutboundQueuedBytes / MiB),
        peakInboundMiB: round(after.relay.peakInboundReservedBytes / MiB),
        rejected: nonZero(after.relay.rejected),
        retired: nonZero(after.relay.retired),
        log: after.logs,
      },
      aborted,
      durationMs: round(performance.now() - startedAt),
    };
  } finally {
    await relay?.stop();
    for (const pair of pairs.values()) {
      pair.client?.terminate();
      pair.rawClient?.socket.destroy();
      pair.engine?.terminate();
      pair.rawEngine?.socket.destroy();
    }
    engine.close();
  }
}

export function boundedScenario(input: LoadScenario): LoadScenario {
  const integer = (
    value: number,
    minimum: number,
    maximum: number,
    name: string,
  ) => {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
      throw new Error(
        `${name} must be an integer from ${minimum} to ${maximum}`,
      );
    return value;
  };
  const pairs = integer(input.pairs, 1, LOAD_HARNESS_CAPS.pairs, "pairs");
  cloudRuntimeRelayLimits(input.relay);
  return {
    ...input,
    pairs,
    adversarial: integer(input.adversarial, 0, pairs, "adversarial"),
    readOnlyPairs: integer(input.readOnlyPairs ?? 0, 0, pairs, "readOnlyPairs"),
    workspaces: integer(input.workspaces, 1, pairs, "workspaces"),
    durationMs: integer(
      input.durationMs,
      100,
      LOAD_HARNESS_CAPS.durationMs,
      "durationMs",
    ),
    messageBytes: integer(
      input.messageBytes,
      1,
      LOAD_HARNESS_CAPS.messageBytes,
      "messageBytes",
    ),
  };
}

type Recorders = {
  latencies: Samples;
  roundTrips: Samples;
  trafficStarted: () => number;
};

/** Returns null when admitted, otherwise the refusal (HTTP status or cause). */
async function openClient(
  port: number,
  pair: Pair,
  scenario: LoadScenario,
  recorders: Recorders,
): Promise<string | null> {
  const token = tokenFor(pair.index);
  const markClosed = () => {
    pair.closedAt ??= performance.now();
  };
  if (
    pair.role === "adversarial" &&
    (scenario.traffic === "max-message" || scenario.traffic === "assembly-hold")
  ) {
    const outcome = await rawClient(port, token, () => {
      pair.clientMessages += 1;
    });
    if ("refused" in outcome) return outcome.refused;
    pair.rawClient = outcome;
    pair.admitted = true;
    outcome.socket.on("close", markClosed);
    return null;
  }
  const client = new WebSocket(
    `ws://127.0.0.1:${port}${CLOUD_RUNTIME_BRIDGE_PATH}`,
    [
      "zeros-v1",
      `zeros-cloud-token.${Buffer.from(token).toString("base64url")}`,
    ],
    {
      perMessageDeflate: false,
      maxPayload: 128 * MiB,
      handshakeTimeout: 15_000,
    },
  );
  const refusal = await new Promise<string | null>((resolve) => {
    client.once("open", () => resolve(null));
    client.once("error", (error) => {
      resolve(
        /Unexpected server response: (\d+)/.exec(String(error))?.[1] ?? "error",
      );
    });
  });
  if (refusal !== null) {
    client.terminate();
    return refusal;
  }
  client.on("error", () => {});
  pair.client = client;
  pair.admitted = true;
  client.on("close", markClosed);
  if (pair.role === "adversarial" && scenario.traffic === "slow-reader") {
    // Stop reading: TCP backpressure now reaches the relay's client socket.
    client.pause();
    return null;
  }
  client.on("message", (data: RawData, binary: boolean) => {
    pair.clientMessages += 1;
    if (binary || !Buffer.isBuffer(data)) return;
    const stamp = stampOf(data);
    if (!stamp || recorders.trafficStarted() === 0) return;
    const elapsed = performance.now() - stamp.stamp;
    if (stamp.kind === 115) recorders.roundTrips.add(elapsed);
    else {
      pair.receivedBytes += data.length;
      recorders.latencies.add(elapsed);
      pair.latencies.add(elapsed);
    }
  });
  return null;
}

function startTraffic(
  scenario: LoadScenario,
  admitted: Pair[],
  recorders: { latencies: Samples; transferMs: number[]; next: () => number },
): () => Promise<void> {
  const { next } = recorders;
  const healthy = admitted.filter((pair) => pair.role === "healthy");
  const adversarial = admitted.filter((pair) => pair.role === "adversarial");
  let running = true;
  const work: Promise<unknown>[] = [];
  const realistic = scenario.traffic !== "idle";
  const mixes = new Map<Pair, Mix>();
  const now0 = performance.now();
  for (const pair of healthy)
    mixes.set(pair, {
      tokenCredit: next(),
      ptyCredit: next(),
      nextBurstAt: now0 + next() * REALISTIC.burstEveryMs[1],
      nextFileAt: now0 + next() * REALISTIC.fileEventEveryMs,
      nextBatchAt: now0 + next() * REALISTIC.fileBatchEveryMs,
      nextRequestAt: now0 + next() * REALISTIC.requestEveryMs,
    });
  let last = now0;
  const sendEngine = (pair: Pair, kind: string, bytes: number) => {
    const upstream = pair.engine;
    if (!upstream || upstream.readyState !== WebSocket.OPEN) return;
    const text = frame(kind, performance.now(), bytes);
    pair.sentBytes += text.length;
    upstream.send(text);
  };
  const ticker = realistic
    ? setInterval(() => {
        const now = performance.now();
        const seconds = (now - last) / 1_000;
        last = now;
        for (const [pair, mix] of mixes) {
          if (pair.closedAt !== null) continue;
          mix.tokenCredit += REALISTIC.tokensPerSecond * seconds;
          for (; mix.tokenCredit >= 1; mix.tokenCredit -= 1)
            sendEngine(
              pair,
              "token",
              REALISTIC.tokenBytes[0] +
                Math.floor(
                  next() * (REALISTIC.tokenBytes[1] - REALISTIC.tokenBytes[0]),
                ),
            );
          if (!pair.readOnly) {
            mix.ptyCredit += REALISTIC.ptyPerSecond * seconds;
            for (; mix.ptyCredit >= 1; mix.ptyCredit -= 1)
              sendEngine(pair, "pty", REALISTIC.ptyBytes);
          }
          if (!pair.readOnly && now >= mix.nextBurstAt) {
            for (let count = 0; count < REALISTIC.burstMessages; count++)
              sendEngine(pair, "pty", REALISTIC.burstMessageBytes);
            mix.nextBurstAt =
              now +
              REALISTIC.burstEveryMs[0] +
              next() * (REALISTIC.burstEveryMs[1] - REALISTIC.burstEveryMs[0]);
          }
          if (now >= mix.nextFileAt) {
            sendEngine(pair, "file", REALISTIC.fileEventBytes);
            mix.nextFileAt += REALISTIC.fileEventEveryMs;
          }
          if (now >= mix.nextBatchAt) {
            sendEngine(pair, "files", REALISTIC.fileBatchBytes);
            mix.nextBatchAt += REALISTIC.fileBatchEveryMs;
          }
          if (
            now >= mix.nextRequestAt &&
            pair.client?.readyState === WebSocket.OPEN
          ) {
            pair.client.send(
              frame("r", performance.now(), REALISTIC.requestBytes),
            );
            mix.nextRequestAt += REALISTIC.requestEveryMs;
          }
        }
      }, 20)
    : null;

  for (const pair of adversarial) {
    if (scenario.traffic === "max-message")
      work.push(
        (async () => {
          const client = pair.rawClient?.socket;
          const upstream = pair.rawEngine?.socket;
          if (!client || !upstream) return;
          while (running && pair.closedAt === null) {
            const began = performance.now();
            const clientBefore = pair.clientMessages;
            const engineBefore = pair.engineMessages;
            const sent = await Promise.all([
              writeLargeFrame(
                client,
                scenario.messageBytes,
                scenario.messageBytes,
                true,
              ),
              writeLargeFrame(
                upstream,
                scenario.messageBytes,
                scenario.messageBytes,
                false,
              ),
            ]);
            if (!sent.every(Boolean)) return;
            while (
              pair.closedAt === null &&
              (pair.clientMessages === clientBefore ||
                pair.engineMessages === engineBefore)
            )
              await new Promise((resolve) => setTimeout(resolve, 5));
            if (pair.closedAt !== null) return;
            recorders.transferMs.push(performance.now() - began);
          }
        })(),
      );
    if (scenario.traffic === "assembly-hold")
      work.push(
        (async () => {
          const client = pair.rawClient?.socket;
          const upstream = pair.rawEngine?.socket;
          if (!client || !upstream) return;
          // Declare a maximum-size message from both ends and withhold the
          // final byte: the relay must hold both partial messages.
          await Promise.all([
            writeLargeFrame(
              client,
              scenario.messageBytes,
              scenario.messageBytes - 1,
              true,
            ),
            writeLargeFrame(
              upstream,
              scenario.messageBytes,
              scenario.messageBytes - 1,
              false,
            ),
          ]);
        })(),
      );
    if (scenario.traffic === "slow-reader")
      work.push(
        (async () => {
          const upstream = pair.engine;
          if (!upstream) return;
          const chunk = frame("pty", 0, 64 * 1024);
          while (running && upstream.readyState === WebSocket.OPEN) {
            // Bounded bursts: a socket the relay has torn down can still read
            // OPEN until its close event runs, so never spin without yielding.
            for (
              let sent = 0;
              sent < 64 &&
              upstream.readyState === WebSocket.OPEN &&
              upstream.bufferedAmount < 8 * MiB;
              sent++
            )
              upstream.send(chunk);
            await new Promise((resolve) => setTimeout(resolve, 2));
          }
        })(),
      );
  }
  return async () => {
    running = false;
    if (ticker) clearInterval(ticker);
    await Promise.race([
      Promise.all(work),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  };
}

// ── command line ──────────────────────────────────────────────────────────

const HELP = `Local load harness for the cloud runtime bridge relay.

Scenarios:
  sweep (default)         per-pair cost, realistic scaling, refusal at the
                          configured ceiling, and worst-case adversarial mixes
  profiles                each recommended instance profile under its worst
                          adversarial mix
  idle | realistic | max-message | assembly-hold | slow-reader
                          one scenario, shaped by the options below

Options:
  --pairs <n>             pairs to open (default 8, cap ${LOAD_HARNESS_CAPS.pairs})
  --adversarial <n>       adversarial pairs (default 2 for adversarial scenarios)
  --read-only-pairs <n>   Read-only pairs (default 0; no terminal traffic)
  --workspaces <n>        workspaces the pairs are spread across (default pairs)
  --duration-ms <n>       traffic duration (default 8000, cap ${LOAD_HARNESS_CAPS.durationMs})
  --message-mib <n>       adversarial message size (default 64)
  --max-connections <n>   relay connections per instance (default: pairs, min 8)
  --max-per-workspace <n> relay connections per workspace
  --max-read-only-per-workspace <n> relay Read-only connections per workspace
  --outbound-mib <n>      relay aggregate outbound budget
  --inbound-mib <n>       relay aggregate inbound (assembly) budget
  --max-relay-rss-mib <n> abort when the relay child exceeds this (default 3072)
  --json                  print one JSON result per line instead of a table`;

export function parseArguments(argv: string[]): Map<string, string> {
  const values = new Map<string, string>();
  const allowed = new Set([
    "--scenario",
    "--pairs",
    "--adversarial",
    "--read-only-pairs",
    "--workspaces",
    "--duration-ms",
    "--message-mib",
    "--max-connections",
    "--max-per-workspace",
    "--max-read-only-per-workspace",
    "--outbound-mib",
    "--inbound-mib",
    "--max-relay-rss-mib",
    "--json",
    "--help",
  ]);
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index]!;
    if (name === "--") continue;
    if (!name.startsWith("--")) throw new Error(`unexpected argument ${name}`);
    if (!allowed.has(name)) throw new Error(`unknown option ${name}`);
    const value = argv[index + 1];
    if (name === "--json" || name === "--help") values.set(name, "true");
    else if (value === undefined || value.startsWith("--"))
      throw new Error(`${name} needs a value`);
    else {
      values.set(name, value);
      index += 1;
    }
  }
  return values;
}

function numberArgument(
  values: Map<string, string>,
  name: string,
): number | undefined {
  const raw = values.get(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${name} must be an integer`);
  return value;
}

function relayOptions(
  values: Map<string, string>,
  pairs: number,
): RelayLoadOptions {
  const options: RelayLoadOptions = {
    maxConnections:
      numberArgument(values, "--max-connections") ??
      Math.min(1_024, Math.max(8, pairs)),
  };
  const perWorkspace = numberArgument(values, "--max-per-workspace");
  const readOnlyPerWorkspace = numberArgument(
    values,
    "--max-read-only-per-workspace",
  );
  const outbound = numberArgument(values, "--outbound-mib");
  const inbound = numberArgument(values, "--inbound-mib");
  if (perWorkspace !== undefined)
    options.maxConnectionsPerWorkspace = perWorkspace;
  if (readOnlyPerWorkspace !== undefined)
    options.maxReadOnlyConnectionsPerWorkspace = readOnlyPerWorkspace;
  if (outbound !== undefined) options.outboundBudgetBytes = outbound * MiB;
  if (inbound !== undefined) options.inboundBudgetBytes = inbound * MiB;
  return options;
}

/** Recommended envelopes per instance memory size (see the sizing table in
 * docs/cloud-workspace/client-runtime-contract.md). */
export const RELAY_PROFILES = {
  "2gib": {
    maxConnections: 64,
    maxConnectionsPerWorkspace: 10,
    maxReadOnlyConnectionsPerWorkspace: 10,
    outboundBudgetBytes: 128 * MiB,
    inboundBudgetBytes: 256 * MiB,
  },
  "4gib": {
    maxConnections: 128,
    maxConnectionsPerWorkspace: 10,
    maxReadOnlyConnectionsPerWorkspace: 10,
    outboundBudgetBytes: 256 * MiB,
    inboundBudgetBytes: 512 * MiB,
  },
  "8gib": {
    maxConnections: 256,
    maxConnectionsPerWorkspace: 10,
    maxReadOnlyConnectionsPerWorkspace: 10,
    outboundBudgetBytes: 512 * MiB,
    inboundBudgetBytes: 1_024 * MiB,
  },
} as const satisfies Record<string, RelayLoadOptions>;

function scenarioOf(
  values: Map<string, string>,
  name: string,
  traffic: LoadTraffic,
  pairs: number,
  adversarial: number,
  relay: RelayLoadOptions,
): LoadScenario {
  return {
    name,
    traffic,
    pairs,
    adversarial,
    readOnlyPairs: numberArgument(values, "--read-only-pairs") ?? 0,
    workspaces: pairs,
    durationMs: numberArgument(values, "--duration-ms") ?? 8_000,
    messageBytes: (numberArgument(values, "--message-mib") ?? 64) * MiB,
    relay,
  };
}

function sweep(values: Map<string, string>): LoadScenario[] {
  const at = (
    name: string,
    traffic: LoadTraffic,
    pairs: number,
    adversarial: number,
    relay: RelayLoadOptions = { maxConnections: pairs },
  ) => scenarioOf(values, name, traffic, pairs, adversarial, relay);
  return [
    // Fixed cost per connected pair.
    at("idle-256", "idle", 256, 0),
    // Realistic mixed traffic as connections grow; defaults first.
    at("realistic-8", "realistic", 8, 0),
    at("realistic-64", "realistic", 64, 0),
    at("realistic-128", "realistic", 128, 0),
    at("realistic-256", "realistic", 256, 0),
    // Refusal exactly at the default and at a configured ceiling.
    at("refusal-9-of-8", "realistic", 9, 0, { maxConnections: 8 }),
    at("refusal-65-of-64", "realistic", 65, 0, { maxConnections: 64 }),
    // Today's worst case: every socket holds a partial maximum-size message.
    at("assembly-hold-8", "assembly-hold", 8, 8, {}),
    // Back-to-back maximum-size messages beside realistic pairs.
    at("max-message-8", "max-message", 8, 2, {}),
    // Slow readers beside realistic pairs.
    at("slow-reader-8", "slow-reader", 8, 2, {}),
  ];
}

/** Each recommended profile at its connection ceiling: realistic pairs beside
 * a quarter of adversarial pairs, under every adversarial pattern. */
function profiles(values: Map<string, string>): LoadScenario[] {
  const scenarios: LoadScenario[] = [];
  for (const [name, relay] of Object.entries(RELAY_PROFILES))
    for (const traffic of [
      "assembly-hold",
      "max-message",
      "slow-reader",
    ] as const)
      scenarios.push(
        scenarioOf(
          values,
          `${name} ${traffic}`,
          traffic,
          relay.maxConnections,
          relay.maxConnections / 4,
          relay,
        ),
      );
  return scenarios;
}

function table(results: LoadResult[]): string {
  const header = [
    "scenario",
    "admitted",
    "refused",
    "idle KiB/pair rss/heap",
    "base→peak RSS MiB",
    "peak heap/ext MiB",
    "peak queued/inbound MiB",
    "relay CPU %",
    "latency p50/p99/max ms",
    "rtt p99 ms",
    "jain",
    "healthy closed",
    "adv closed",
    "closed by",
  ];
  const rows = results.map((result) => [
    result.scenario + (result.aborted ? ` (ABORTED: ${result.aborted})` : ""),
    `${result.admitted}/${result.pairs}`,
    Object.entries(result.refused)
      .map(([reason, count]) => `${reason}:${count}`)
      .join(" ") || "-",
    `${result.perPairKiB.idleRss}/${result.perPairKiB.idleHeap}`,
    `${result.memoryMiB.baselineRss}→${result.memoryMiB.peakRss}`,
    `${result.memoryMiB.peakHeapUsed}/${result.memoryMiB.peakExternal}`,
    `${result.relay.peakOutboundMiB}/${result.relay.peakInboundMiB}`,
    String(result.relayCpuPercent),
    `${result.latencyMs.p50}/${result.latencyMs.p99}/${result.latencyMs.max}`,
    String(result.roundTripMs.p99),
    String(result.fairness.jainDelivery),
    `${result.fairness.healthyClosed}/${result.fairness.healthyPairs}`,
    `${result.adversarial.closed}/${result.adversarial.pairs}`,
    Object.entries(result.relay.retired)
      .filter(([reason]) => reason !== "shutdown")
      .map(([reason, count]) => `${reason}:${count}`)
      .join(" ") || "-",
  ]);
  return [header, header.map(() => "---"), ...rows]
    .map((row) => `| ${row.join(" | ")} |`)
    .join("\n");
}

async function main(argv: string[]): Promise<void> {
  const values = parseArguments(argv);
  if (values.has("--help")) {
    console.log(HELP);
    return;
  }
  const name = values.get("--scenario") ?? "sweep";
  const scenarios: LoadScenario[] = [];
  if (name === "sweep") scenarios.push(...sweep(values));
  else if (name === "profiles") scenarios.push(...profiles(values));
  else {
    const traffic = name as LoadTraffic;
    if (
      ![
        "idle",
        "realistic",
        "max-message",
        "assembly-hold",
        "slow-reader",
      ].includes(traffic)
    )
      throw new Error(`unknown scenario ${name}`);
    const pairs = numberArgument(values, "--pairs") ?? 8;
    scenarios.push({
      ...scenarioOf(
        values,
        `${traffic}-${pairs}`,
        traffic,
        pairs,
        numberArgument(values, "--adversarial") ??
          (traffic === "idle" || traffic === "realistic"
            ? 0
            : Math.min(2, pairs)),
        relayOptions(values, pairs),
      ),
      workspaces: numberArgument(values, "--workspaces") ?? pairs,
    });
  }
  const maxRelayRssMiB = numberArgument(values, "--max-relay-rss-mib");
  const results: LoadResult[] = [];
  for (const scenario of scenarios) {
    const result = await runLoadScenario(
      scenario,
      maxRelayRssMiB === undefined ? {} : { maxRelayRssMiB },
    );
    results.push(result);
    if (values.has("--json")) console.log(JSON.stringify(result));
    else
      console.error(`finished ${result.scenario} in ${result.durationMs} ms`);
  }
  if (!values.has("--json")) console.log(table(results));
}

if (process.argv.includes(CHILD_FLAG)) {
  void relayChild().catch((error: unknown) => {
    console.error("relay load child failed", error);
    process.exit(1);
  });
} else if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1]
) {
  void main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
