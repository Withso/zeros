import { RESIDENT_FRAME_BYTES, type ResidentPtyFrame } from "./resident-protocol";
type Event = Exclude<ResidentPtyFrame, { kind: "reply" | "error" }>;
type Route = { ready: boolean; sequence: number; pending: Event[]; bytes: number;
  authorized(): boolean; send(event: Event): void; overflow(): void };

/** Snapshot watermarks belong to each device, never to the shared PTY. */
export class ResidentTerminalReplay<Client> {
  private readonly clients = new Map<Client, Map<string, Route>>();

  async attach<Snapshot extends { sequence: number }>(client: Client, sessionId: string, authorized: () => boolean,
    snapshot: () => Promise<Snapshot>, publish: (value: Snapshot) => void,
    send: (event: Event) => void, overflow: () => void): Promise<void> {
    const routes = this.clients.get(client) ?? new Map<string, Route>();
    this.clients.set(client, routes);
    const route: Route = { ready: false, sequence: 0, pending: [], bytes: 0, authorized, send, overflow };
    routes.set(sessionId, route);
    try {
      const value = await snapshot();
      if (this.clients.get(client) !== routes || routes.get(sessionId) !== route || !authorized()) return;
      publish(value); route.sequence = value.sequence; route.ready = true;
      for (const event of route.pending) this.deliver(route, event);
      route.pending = []; route.bytes = 0;
    } finally {
      if (!route.ready && routes.get(sessionId) === route) routes.delete(sessionId);
    }
  }

  publish(event: Event): void {
    for (const routes of this.clients.values()) {
      const route = routes.get(event.sessionId);
      if (!route) continue;
      if (!route.authorized()) { routes.delete(event.sessionId); continue; }
      if (route.ready) { this.deliver(route, event); continue; }
      route.bytes += event.kind === "data" ? Buffer.byteLength(event.data) : 128;
      if (route.bytes > RESIDENT_FRAME_BYTES || route.pending.length >= 4096) {
        routes.delete(event.sessionId); route.overflow(); continue;
      }
      route.pending.push(event);
    }
  }

  release(client: Client): void { this.clients.delete(client); }
  retire(sessionId: string): void {
    for (const routes of this.clients.values()) routes.delete(sessionId);
  }
  private deliver(route: Route, event: Event): void {
    if (!route.authorized() || event.kind === "data" && event.sequence <= route.sequence) return;
    if (event.kind === "data") route.sequence = event.sequence;
    route.send(event);
  }
}
