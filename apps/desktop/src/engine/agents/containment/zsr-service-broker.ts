import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  chmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";

import type {
  LocalServiceKind,
  LocalServiceCapability,
  LocalTcpServiceAdapter,
  LocalUnixServiceAdapter,
  ServiceLease,
  TerritoryGeneration,
} from "./types";

const CONNECT_TIMEOUT_MS = 5_000;
const MAX_SERVICES = 64;
const MAX_CONNECTIONS_PER_SERVICE = 128;

interface Route {
  readonly capability: LocalServiceCapability;
  readonly facadePort: number;
  readonly tcpServer: Server;
  readonly unixServer?: Server;
  readonly facadeSocketPath?: string;
  readonly clientStateDirectory?: string;
  readonly targetSocketIdentity?: {
    readonly device: number;
    readonly inode: number;
  };
  readonly sockets: Set<Socket>;
  readonly activeLeases: Set<string>;
}

export interface ZsrLocalServiceBrokerOptions {
  /** Canonical generation-private directory for protocol clients that require
   * an AF_UNIX pathname (SSH/Nix). Omit only when every adapter uses TCP. */
  readonly socketRoot?: string;
  /** Generation-private writable roots used by protocol clients whose socket
   * convention is coupled to mutable client state (currently GnuPG). */
  readonly clientStateRoot?: string;
  /** Engine/control roots a host-side Unix connector must never enter. */
  readonly forbiddenTargetRoots?: readonly string[];
}

const GPG_CLIENT_STATE_FILES: readonly {
  readonly relativePath: string;
  readonly maxBytes: number;
}[] = [
  { relativePath: "pubring.kbx", maxBytes: 64 * 1024 * 1024 },
  { relativePath: "pubring.gpg", maxBytes: 64 * 1024 * 1024 },
  { relativePath: "trustdb.gpg", maxBytes: 64 * 1024 * 1024 },
  { relativePath: "tofu.db", maxBytes: 64 * 1024 * 1024 },
  { relativePath: "public-keys.d/pubring.db", maxBytes: 128 * 1024 * 1024 },
  { relativePath: "public-keys.d/pubring.db-wal", maxBytes: 64 * 1024 * 1024 },
  { relativePath: "public-keys.d/pubring.db-shm", maxBytes: 16 * 1024 * 1024 },
];
const MAX_GPG_CLIENT_STATE_BYTES = 256 * 1024 * 1024;

function canonicalExistingOrLexical(input: string): string {
  if (!path.isAbsolute(input) || input.includes("\0")) {
    throw new Error("forbidden local-service roots must be absolute");
  }
  const missing: string[] = [];
  let cursor = path.normalize(input);
  for (;;) {
    try {
      return path.join(realpathSync(cursor), ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      missing.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

function pathInsideOrEqual(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function validPort(value: unknown): value is number {
  return (
    Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 65_535
  );
}

function adapterReservedEnvironment(
  adapter: LocalTcpServiceAdapter | LocalUnixServiceAdapter,
): readonly string[] {
  switch (adapter) {
    case "environment-only":
      return [];
    case "generic":
      return ["ZEROS_LOCAL_SERVICE_HOST", "ZEROS_LOCAL_SERVICE_PORT"];
    case "generic-unix":
      return ["ZEROS_LOCAL_SERVICE_SOCKET"];
    case "postgres":
      return ["PGHOST", "PGPORT"];
    case "mysql":
      return ["MYSQL_HOST", "MYSQL_TCP_PORT"];
    case "redis":
      return ["REDIS_URL"];
    case "docker-tcp":
    case "docker-unix":
      return ["DOCKER_HOST"];
    case "podman-tcp":
    case "podman-unix":
      return ["CONTAINER_HOST"];
    case "ssh-agent":
      return ["SSH_AUTH_SOCK"];
    case "gpg-agent":
      return ["GNUPGHOME", "GPG_AGENT_INFO"];
    case "nix-daemon":
      return ["NIX_REMOTE"];
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function capabilityEnv(
  capability: LocalServiceCapability,
  route: Route,
  templates: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  const host = "127.0.0.1";
  const port = route.facadePort;
  const socket = route.facadeSocketPath ?? "";
  let generated: Record<string, string>;
  switch (capability.adapter) {
    case "environment-only":
      generated = {};
      break;
    case "postgres":
      generated = { PGHOST: host, PGPORT: String(port) };
      break;
    case "mysql":
      generated = { MYSQL_HOST: host, MYSQL_TCP_PORT: String(port) };
      break;
    case "redis":
      generated = { REDIS_URL: `redis://${host}:${port}` };
      break;
    case "docker-tcp":
      generated = { DOCKER_HOST: `tcp://${host}:${port}` };
      break;
    case "podman-tcp":
      generated = { CONTAINER_HOST: `tcp://${host}:${port}` };
      break;
    case "docker-unix":
      generated = { DOCKER_HOST: `tcp://${host}:${port}` };
      break;
    case "podman-unix":
      generated = { CONTAINER_HOST: `tcp://${host}:${port}` };
      break;
    case "ssh-agent":
      generated = { SSH_AUTH_SOCK: socket };
      break;
    case "gpg-agent": {
      const gpgHome = route.clientStateDirectory;
      if (!gpgHome) throw new Error("GPG client state was not prepared");
      const agentSocket = path.join(gpgHome, "S.gpg-agent");
      generated = {
        GNUPGHOME: gpgHome,
        // Retained for legacy clients. Modern GnuPG discovers the same exact
        // façade at $GNUPGHOME/S.gpg-agent.
        GPG_AGENT_INFO: `${agentSocket}:0:1`,
      };
      break;
    }
    case "nix-daemon":
      generated = { NIX_REMOTE: `unix://${socket}` };
      break;
    case "generic-unix":
      generated = { ZEROS_LOCAL_SERVICE_SOCKET: socket };
      break;
    case "generic":
      generated = {
        ZEROS_LOCAL_SERVICE_HOST: host,
        ZEROS_LOCAL_SERVICE_PORT: String(port),
      };
      break;
  }
  for (const [name, template] of Object.entries(templates ?? {})) {
    generated[name] = template
      .replaceAll("{host}", host)
      .replaceAll("{port}", String(port))
      .replaceAll("{socket}", socket);
  }
  return generated;
}

function validateCapability(
  capability: LocalServiceCapability,
): LocalServiceCapability {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(capability.serviceId)) {
    throw new Error("local service id is invalid");
  }
  if (capability.kind === "docker" || capability.kind === "podman") {
    throw new Error(
      "Docker and Podman require an isolated ZSR container worker; host daemon sockets are never forwarded",
    );
  }
  if (capability.transport === "tcp") {
    if (
      capability.targetHost !== "127.0.0.1" &&
      capability.targetHost !== "::1"
    ) {
      throw new Error("local service target must be an exact loopback address");
    }
    if (!validPort(capability.targetPort)) {
      throw new Error("local service target port is invalid");
    }
    const validAdapters: readonly LocalTcpServiceAdapter[] = [
      "environment-only",
      "generic",
      "postgres",
      "mysql",
      "redis",
      "docker-tcp",
      "podman-tcp",
    ];
    if (!validAdapters.includes(capability.adapter)) {
      throw new Error("local TCP service adapter is invalid");
    }
  } else if (capability.transport === "unix") {
    if (
      !path.isAbsolute(capability.targetPath) ||
      capability.targetPath.includes("\0")
    ) {
      throw new Error("local Unix service target must be an absolute path");
    }
    const canonical = realpathSync(capability.targetPath);
    const stat = lstatSync(canonical);
    if (!stat.isSocket() || stat.isSymbolicLink()) {
      throw new Error("local Unix service target is not a physical socket");
    }
    const validAdapters: readonly LocalUnixServiceAdapter[] = [
      "environment-only",
      "generic-unix",
      "docker-unix",
      "podman-unix",
      "ssh-agent",
      "gpg-agent",
      "nix-daemon",
    ];
    if (!validAdapters.includes(capability.adapter)) {
      throw new Error("local Unix service adapter is invalid");
    }
    capability = { ...capability, targetPath: canonical };
  } else {
    throw new Error("local service transport is invalid");
  }
  const templates = Object.entries(capability.environment ?? {});
  if (templates.length > 32) {
    throw new Error("local service environment has too many entries");
  }
  for (const [name, template] of templates) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) {
      throw new Error("local service environment name is invalid");
    }
    if (
      typeof template !== "string" ||
      template.length > 16 * 1024 ||
      template.includes("\0")
    ) {
      throw new Error("local service environment template is invalid");
    }
    if (adapterReservedEnvironment(capability.adapter).includes(name)) {
      throw new Error(`reserved local service environment variable: ${name}`);
    }
  }
  if (
    capability.transport === "tcp" &&
    (["postgres", "mysql", "redis"] as const).includes(
      capability.adapter as "postgres",
    ) &&
    capability.kind !== "database"
  ) {
    throw new Error("database adapter has the wrong service kind");
  }
  if (
    (capability.adapter === "docker-tcp" ||
      capability.adapter === "docker-unix") &&
    capability.kind !== "docker"
  ) {
    throw new Error("Docker adapter has the wrong service kind");
  }
  if (
    (capability.adapter === "podman-tcp" ||
      capability.adapter === "podman-unix") &&
    capability.kind !== "podman"
  ) {
    throw new Error("Podman adapter has the wrong service kind");
  }
  if (capability.adapter === "ssh-agent" && capability.kind !== "ssh-agent") {
    throw new Error("SSH agent adapter has the wrong service kind");
  }
  if (capability.adapter === "gpg-agent") {
    if (capability.kind !== "gpg-agent") {
      throw new Error("GPG agent adapter has the wrong service kind");
    }
    if (
      !capability.sourceHome ||
      !path.isAbsolute(capability.sourceHome) ||
      capability.sourceHome.includes("\0")
    ) {
      throw new Error("GPG agent requires an absolute client-state source");
    }
    const sourceHome = realpathSync(capability.sourceHome);
    const sourceStat = lstatSync(sourceHome);
    if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
      throw new Error("GPG client-state source must be a physical directory");
    }
    if (
      typeof process.getuid === "function" &&
      sourceStat.uid !== process.getuid()
    ) {
      throw new Error("GPG client-state source has the wrong owner");
    }
    capability = { ...capability, sourceHome };
  } else if (
    capability.transport === "unix" &&
    capability.sourceHome !== undefined
  ) {
    throw new Error("client-state source is only valid for GPG agent services");
  }
  if (capability.adapter === "nix-daemon" && capability.kind !== "nix") {
    throw new Error("Nix adapter has the wrong service kind");
  }
  return { ...capability };
}

function needsUnixFacade(capability: LocalServiceCapability): boolean {
  return (
    capability.transport === "unix" &&
    capability.adapter !== "docker-unix" &&
    capability.adapter !== "podman-unix"
  );
}

function validatePrivateRoot(
  input: string | undefined,
  purpose: string,
): string {
  if (!input || !path.isAbsolute(input) || input.includes("\0")) {
    throw new Error(`a private ${purpose} root is required`);
  }
  const canonical = realpathSync(input);
  const stat = lstatSync(canonical);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${purpose} root must be a physical directory`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`${purpose} root has the wrong owner`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`${purpose} root must be private`);
  }
  return canonical;
}

function copyRegularFileNoFollow(
  source: string,
  destination: string,
  maxBytes: number,
): number {
  let sourceFd: number;
  try {
    sourceFd = openSync(
      source,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ELOOP") return 0;
    throw error;
  }
  let destinationFd: number | undefined;
  try {
    const before = fstatSync(sourceFd);
    if (!before.isFile()) return 0;
    if (before.size > maxBytes) {
      throw new Error(`GPG client-state file exceeds ${maxBytes} bytes`);
    }
    mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    destinationFd = openSync(
      destination,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let copied = 0;
    while (copied < before.size) {
      const length = readSync(
        sourceFd,
        buffer,
        0,
        Math.min(buffer.length, before.size - copied),
        copied,
      );
      if (length === 0) break;
      let written = 0;
      while (written < length) {
        written += writeSync(destinationFd, buffer, written, length - written);
      }
      copied += length;
    }
    const after = fstatSync(sourceFd);
    if (
      copied !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs
    ) {
      throw new Error(
        "GPG client-state changed while it was being snapshotted",
      );
    }
    return copied;
  } catch (error) {
    if (destinationFd !== undefined) closeSync(destinationFd);
    destinationFd = undefined;
    try {
      unlinkSync(destination);
    } catch (unlinkError) {
      if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new AggregateError(
          [error, unlinkError],
          "failed to clean an incomplete GPG client-state snapshot",
        );
      }
    }
    throw error;
  } finally {
    if (destinationFd !== undefined) closeSync(destinationFd);
    closeSync(sourceFd);
  }
}

function copyGpgClientState(sourceHome: string, destination: string): void {
  const nestedSource = path.join(sourceHome, "public-keys.d");
  let nestedSourceIsPhysical = false;
  try {
    const stat = lstatSync(nestedSource);
    nestedSourceIsPhysical = stat.isDirectory() && !stat.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let total = 0;
  for (const entry of GPG_CLIENT_STATE_FILES) {
    if (entry.relativePath.includes("/") && !nestedSourceIsPhysical) continue;
    total += copyRegularFileNoFollow(
      path.join(sourceHome, entry.relativePath),
      path.join(destination, entry.relativePath),
      entry.maxBytes,
    );
    if (total > MAX_GPG_CLIENT_STATE_BYTES) {
      throw new Error("GPG client-state snapshot exceeds its size limit");
    }
  }
}

/** Generation-scoped host TCP façades. A route exists (and its random port is
 * admitted into the immutable OS profile) before spawn, but rejects every
 * connection until requestLocalService mints a lease. */
export class ZsrLocalServiceBroker {
  private readonly routes = new Map<string, Route>();
  private readonly clientStateDirectories = new Set<string>();
  private closed = false;

  private constructor() {}

  static async reserve(
    capabilities: readonly LocalServiceCapability[],
    options: ZsrLocalServiceBrokerOptions = {},
  ): Promise<ZsrLocalServiceBroker> {
    if (capabilities.length > MAX_SERVICES) {
      throw new Error(`at most ${MAX_SERVICES} local services may be declared`);
    }
    const broker = new ZsrLocalServiceBroker();
    try {
      const validated = capabilities.map(validateCapability);
      const forbiddenRoots = (options.forbiddenTargetRoots ?? []).map(
        canonicalExistingOrLexical,
      );
      for (const capability of validated) {
        if (
          capability.transport === "unix" &&
          forbiddenRoots.some((root) =>
            pathInsideOrEqual(capability.targetPath, root),
          )
        ) {
          throw new Error("local Unix service target is engine-private");
        }
        if (
          capability.transport === "unix" &&
          capability.sourceHome &&
          forbiddenRoots.some((root) =>
            pathInsideOrEqual(capability.sourceHome!, root),
          )
        ) {
          throw new Error("local service client state is engine-private");
        }
      }
      const needsSockets = validated.some(needsUnixFacade);
      const socketRoot = needsSockets
        ? validatePrivateRoot(options.socketRoot, "local-service socket")
        : undefined;
      const needsClientState = validated.some(
        (capability) => capability.adapter === "gpg-agent",
      );
      const clientStateRoot = needsClientState
        ? validatePrivateRoot(
            options.clientStateRoot,
            "local-service client-state",
          )
        : undefined;
      for (const [index, capability] of validated.entries()) {
        if (broker.routes.has(capability.serviceId)) {
          throw new Error(
            `duplicate local service id: ${capability.serviceId}`,
          );
        }
        const clientStateDirectory =
          capability.transport === "unix" &&
          capability.adapter === "gpg-agent" &&
          clientStateRoot
            ? path.join(clientStateRoot, `g${index}`)
            : undefined;
        if (clientStateDirectory) {
          if (
            capability.transport !== "unix" ||
            capability.adapter !== "gpg-agent" ||
            !capability.sourceHome
          ) {
            throw new Error("GPG client-state declaration was not validated");
          }
          mkdirSync(clientStateDirectory, { mode: 0o700 });
          broker.clientStateDirectories.add(clientStateDirectory);
          copyGpgClientState(capability.sourceHome, clientStateDirectory);
        }
        const routeRef: { current: Route | null } = { current: null };
        const accept = (socket: Socket) => {
          const route = routeRef.current;
          if (!route) {
            socket.destroy();
            return;
          }
          broker.accept(route, socket);
        };
        const tcpServer = createServer({ pauseOnConnect: true }, accept);
        await new Promise<void>((resolve, reject) => {
          tcpServer.once("error", reject);
          tcpServer.listen(0, "127.0.0.1", resolve);
        });
        const address = tcpServer.address();
        if (!address || typeof address === "string") {
          tcpServer.close();
          throw new Error("local service façade did not receive a TCP port");
        }
        const facadeSocketPath =
          socketRoot && needsUnixFacade(capability)
            ? path.join(socketRoot, `s${index}.sock`)
            : undefined;
        const clientSocketPath = clientStateDirectory
          ? path.join(clientStateDirectory, "S.gpg-agent")
          : undefined;
        if (
          (facadeSocketPath && Buffer.byteLength(facadeSocketPath) > 100) ||
          (clientSocketPath && Buffer.byteLength(clientSocketPath) > 100)
        ) {
          tcpServer.close();
          throw new Error("local-service Unix façade path is too long");
        }
        const unixServer = facadeSocketPath
          ? createServer({ pauseOnConnect: true }, accept)
          : undefined;
        const targetSocketIdentity =
          capability.transport === "unix"
            ? (() => {
                const stat = lstatSync(capability.targetPath);
                return { device: stat.dev, inode: stat.ino };
              })()
            : undefined;
        const route: Route = {
          capability,
          facadePort: address.port,
          tcpServer,
          ...(unixServer ? { unixServer } : {}),
          ...(facadeSocketPath ? { facadeSocketPath } : {}),
          ...(clientStateDirectory ? { clientStateDirectory } : {}),
          ...(targetSocketIdentity ? { targetSocketIdentity } : {}),
          sockets: new Set(),
          activeLeases: new Set(),
        };
        routeRef.current = route;
        broker.routes.set(capability.serviceId, route);
        if (unixServer && facadeSocketPath) {
          await new Promise<void>((resolve, reject) => {
            unixServer.once("error", reject);
            unixServer.listen(facadeSocketPath, resolve);
          });
          chmodSync(facadeSocketPath, 0o600);
          if (clientSocketPath) {
            symlinkSync(facadeSocketPath, clientSocketPath);
          }
          unixServer.unref();
        }
        tcpServer.unref();
      }
      return broker;
    } catch (error) {
      await broker.close();
      throw error;
    }
  }

  facadePorts(): number[] {
    return [...this.routes.values()].map((route) => route.facadePort);
  }

  facadeUnixSocketPaths(): string[] {
    return [...this.routes.values()].flatMap((route) =>
      route.facadeSocketPath ? [route.facadeSocketPath] : [],
    );
  }

  clientWritableRoots(): string[] {
    return [...this.clientStateDirectories];
  }

  private accept(route: Route, client: Socket): void {
    if (
      this.closed ||
      route.activeLeases.size === 0 ||
      route.sockets.size >= MAX_CONNECTIONS_PER_SERVICE
    ) {
      client.destroy();
      return;
    }
    route.sockets.add(client);
    client.once("close", () => route.sockets.delete(client));
    client.once("error", () => route.sockets.delete(client));
    let target: Socket;
    if (route.capability.transport === "tcp") {
      target = createConnection({
        host: route.capability.targetHost,
        port: route.capability.targetPort,
      });
    } else {
      try {
        const stat = lstatSync(route.capability.targetPath);
        if (
          !stat.isSocket() ||
          stat.dev !== route.targetSocketIdentity?.device ||
          stat.ino !== route.targetSocketIdentity?.inode
        ) {
          client.destroy();
          return;
        }
      } catch {
        client.destroy();
        return;
      }
      target = createConnection(route.capability.targetPath);
    }
    route.sockets.add(target);
    const destroyBoth = () => {
      client.destroy();
      target.destroy();
    };
    const timeout = setTimeout(destroyBoth, CONNECT_TIMEOUT_MS);
    target.once("connect", () => {
      clearTimeout(timeout);
      client.pipe(target);
      target.pipe(client);
      client.resume();
    });
    target.once("close", () => route.sockets.delete(target));
    target.once("error", destroyBoth);
    client.once("close", () => target.destroy());
  }

  lease(
    serviceId: string,
    kind: LocalServiceKind,
    generation: TerritoryGeneration,
  ): ServiceLease {
    if (this.closed) throw new Error("execution boundary is revoked");
    const route = this.routes.get(serviceId);
    if (!route) throw new Error("local service was not declared at admission");
    if (route.capability.kind !== kind) {
      throw new Error("local service kind does not match its declaration");
    }
    const leaseId = `service:${generation}:${randomUUID()}`;
    route.activeLeases.add(leaseId);
    let active = true;
    return {
      leaseId,
      generation,
      env: capabilityEnv(route.capability, route, route.capability.environment),
      revoke: async () => {
        if (!active) return;
        active = false;
        route.activeLeases.delete(leaseId);
        if (route.activeLeases.size === 0) {
          for (const socket of route.sockets) socket.destroy();
          route.sockets.clear();
        }
      },
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const route of this.routes.values()) {
      route.activeLeases.clear();
      for (const socket of route.sockets) socket.destroy();
      route.sockets.clear();
    }
    await Promise.all(
      [...this.routes.values()].flatMap((route) => [
        closeServer(route.tcpServer),
        ...(route.unixServer ? [closeServer(route.unixServer)] : []),
      ]),
    );
    for (const route of this.routes.values()) {
      if (!route.facadeSocketPath) continue;
      try {
        unlinkSync(route.facadeSocketPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    for (const directory of this.clientStateDirectories) {
      rmSync(directory, { recursive: true, force: true });
    }
    this.clientStateDirectories.clear();
    this.routes.clear();
  }
}
