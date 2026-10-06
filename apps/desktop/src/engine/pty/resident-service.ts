import { ResidentPtyClient } from "./resident-client";
import { coerceDim } from "./service";
import { RESIDENT_FRAME_BYTES, ResidentPtyError, type ResidentEngineAuthority,
  type ResidentPtyCreate, type ResidentPtyFrame, type ResidentPtySession } from "./resident-protocol";

type Event = Exclude<ResidentPtyFrame, { kind: "reply" | "error" }>;

/** Engine-local routing cache. The resident host owns every shell, mirror,
 * actor binding and input cursor; reconnect reconstructs this disposable view. */
export class ResidentTerminalService {
  private readonly client: ResidentPtyClient;
  private readonly sessions = new Map<string, ResidentPtySession>();
  private readonly writes = new Map<string, { tail: Promise<unknown>; count: number }>();
  private listener: ((event: Event) => void) | null = null;
  private loading = 0;
  private operations = 0;
  private epoch = 0;
  private pendingEvents: Event[] = [];
  private pendingBytes = 0;
  private connected = false;

  constructor(private readonly options: { hostId: string; socketPath: string; authority: ResidentEngineAuthority }) {
    this.client = new ResidentPtyClient(options);
    this.client.events(event => this.receive(event));
  }

  events(listener: (event: Event) => void): void { this.listener = listener; }

  async connect(): Promise<void> {
    const epoch = this.epoch;
    this.loading++;
    try {
      await this.client.connect();
      const sessions = await this.client.list();
      if (epoch !== this.epoch || !this.client.isConnected()) throw new ResidentPtyError("host_unavailable");
      this.sessions.clear();
      for (const session of sessions) this.sessions.set(session.sessionId, session);
      this.connected = true;
    } finally { this.loading--; this.flushEvents(); }
  }

  list(): ResidentPtySession[] { return [...this.sessions.values()].map(session => ({ ...session })); }
  get(sessionId: string): ResidentPtySession | undefined {
    const session = this.sessions.get(sessionId); return session ? { ...session } : undefined;
  }
  has(sessionId: string): boolean { return this.sessions.get(sessionId)?.exited === false; }
  healthy(): boolean { return this.connected && this.client.isConnected(); }
  busy(): boolean { return !this.healthy() || this.loading > 0 || this.operations > 0 || this.writes.size > 0; }
  hasRecentInput(): boolean { return [...this.sessions.values()].some(session => session.lastInputAtMs > 0 && Date.now() - session.lastInputAtMs < 10 * 60_000); }

  async create(launch: ResidentPtyCreate): Promise<ResidentPtySession> {
    this.loading++;
    try {
      const session = await this.client.create({ ...launch, cols: coerceDim(launch.cols, 80), rows: coerceDim(launch.rows, 24) });
      this.sessions.set(session.sessionId, session);
      return { ...session };
    } finally { this.loading--; this.flushEvents(); }
  }

  async snapshot(sessionId: string) {
    this.operations++;
    try { return await this.client.snapshot(sessionId); }
    finally { this.operations--; }
  }

  write(sessionId: string, data: string, actorUserId: string | null): Promise<void> {
    if (!this.connected) return Promise.reject(new ResidentPtyError("host_unavailable"));
    const state = this.writes.get(sessionId) ?? { tail: Promise.resolve(), count: 0 };
    if (state.count >= 32) return Promise.reject(new ResidentPtyError("input_limit"));
    state.count++; this.writes.set(sessionId, state);
    const next = state.tail.then(async () => {
      // Exactly one fenced engine owns this producer. Read the host cursor so
      // replacement never resets input ordering or consumes another producer
      // slot. The private protocol still supports replaying an uncertain write
      // with the same producer/sequence when its original caller retains it.
      const sequence = await this.client.cursor(sessionId, this.options.hostId) + 1;
      await this.client.write(sessionId, { producerId: this.options.hostId, sequence, data, actorUserId });
      const session = this.sessions.get(sessionId);
      if (session) session.lastInputAtMs = Date.now();
      if (session?.actorUserId && session.actorUserId !== actorUserId) session.githubShared = true;
    });
    state.tail = next.catch(() => undefined).finally(() => {
      if (--state.count === 0 && this.writes.get(sessionId) === state) this.writes.delete(sessionId);
    });
    return next;
  }

  async resize(sessionId: string, cols: number, rows: number): Promise<void> {
    this.operations++;
    try {
      const previous = this.sessions.get(sessionId);
      cols = coerceDim(cols, previous?.cols ?? 80); rows = coerceDim(rows, previous?.rows ?? 24);
      await this.client.resize(sessionId, cols, rows);
      const session = this.sessions.get(sessionId);
      if (session) { session.cols = cols; session.rows = rows; }
    } finally { this.operations--; }
  }

  async close(sessionId: string): Promise<void> {
    this.operations++;
    try { await this.client.close(sessionId); this.sessions.delete(sessionId); }
    finally { this.operations--; }
  }

  async closeAll(): Promise<void> {
    for (const id of this.sessions.keys()) await this.close(id);
  }

  disconnect(): void {
    this.epoch++;
    this.connected = false; this.client.disconnect(); this.pendingEvents = []; this.pendingBytes = 0;
  }

  private receive(event: Event): void {
    if (this.loading) {
      this.pendingBytes += event.kind === "data" ? Buffer.byteLength(event.data) : 128;
      if (this.pendingBytes > RESIDENT_FRAME_BYTES || this.pendingEvents.length >= 4096) {
        this.disconnect(); return;
      }
      this.pendingEvents.push(event); return;
    }
    const session = this.sessions.get(event.sessionId);
    if (!session) return;
    if (event.kind === "exit") session.exited = true;
    this.listener?.(event);
  }

  private flushEvents(): void {
    if (this.loading) return;
    const events = this.pendingEvents; this.pendingEvents = []; this.pendingBytes = 0;
    for (const event of events) this.receive(event);
  }
}
