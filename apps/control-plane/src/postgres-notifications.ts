import type pg from "pg";

// A continuously held LISTEN session is not an idle query-pool connection.
// PlanetScale requires replacement within 24h; keep an hour of headroom rather
// than interrupting every subscriber at the query pool's ten-minute limit.
const NOTIFICATION_CONNECTION_LIFETIME_MS = 23 * 60 * 60_000;

type Options = {
  channels: readonly string[];
  onNotification: (notification: pg.Notification) => void;
  onReady?: () => void;
  onDisconnect?: () => void;
  onUnavailable?: () => void;
  /** Security streams must reconnect explicitly after a gap. Durable queue
   * consumers instead re-read their work after every successful LISTEN. */
  reconnect?: boolean;
};

export interface PostgresNotificationSubscription {
  start(): Promise<void>;
  healthy(): boolean;
  stop(): Promise<void>;
}

const listeners = new WeakMap<pg.Pool, SharedListener>();

/** All consumers of one dedicated pool share one disposable LISTEN session.
 * Only static SQL identifiers are accepted; payload validation and durable
 * replay belong to each consumer. Constructing a subscription is lazy. */
export function postgresNotificationSubscription(
  pool: pg.Pool,
  options: Options,
): PostgresNotificationSubscription {
  const channels = [...new Set(options.channels)];
  if (!channels.length || channels.some(channel => !/^[a-z_][a-z0-9_]{0,62}$/.test(channel))) {
    throw new Error("invalid_database_notification_channel");
  }
  let listener = listeners.get(pool);
  if (!listener) {
    listener = new SharedListener(pool);
    listeners.set(pool, listener);
  }
  return new Subscription(listener, { ...options, channels });
}

// A bad wake callback must not prevent another queue from observing its hint.
function invoke(callback: (() => void) | undefined): void {
  try { callback?.(); }
  catch { console.warn("[database] notification consumer callback failed"); }
}

class Subscription implements PostgresNotificationSubscription {
  ready = false;
  private stopped = false;
  private stopping: Promise<void> | undefined;
  private pending: { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void } | undefined;

  constructor(private readonly listener: SharedListener, readonly options: Options) {}

  start(): Promise<void> {
    if (this.stopped || this.ready) return Promise.resolve();
    if (this.pending) return this.pending.promise;
    let resolve!: () => void, reject!: (error: unknown) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    this.pending = { promise, resolve, reject };
    this.listener.add(this);
    return promise;
  }

  healthy(): boolean { return this.ready && !this.stopped; }

  connected(): void {
    if (this.stopped || this.ready) return;
    this.ready = true;
    this.pending?.resolve();
    this.pending = undefined;
    invoke(this.options.onReady);
  }

  disconnected(error: unknown): void {
    this.ready = false;
    this.pending?.reject(error);
    this.pending = undefined;
    invoke(this.options.onDisconnect);
    invoke(this.options.onUnavailable);
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    this.ready = false;
    this.pending?.resolve();
    this.pending = undefined;
    this.stopping = this.listener.remove(this);
    return this.stopping;
  }
}

type Session = {
  client: pg.PoolClient;
  channels: Set<string>;
  disposed: boolean;
  announced: boolean;
  dispose: (error?: unknown) => void;
  retirement?: NodeJS.Timeout;
};

class SharedListener {
  private readonly subscriptions = new Set<Subscription>();
  private session: Session | undefined;
  private syncing: Promise<void> | undefined;
  private retry: NodeJS.Timeout | undefined;
  private retryMs = 1_000;
  private recovering = false;

  constructor(private readonly pool: pg.Pool) {}

  add(subscription: Subscription): void {
    this.subscriptions.add(subscription);
    // An explicit security-stream reconnect must not wait behind a worker's
    // backoff. Concurrent starts still share the same in-flight acquisition.
    clearTimeout(this.retry);
    this.retry = undefined;
    this.sync();
  }

  async remove(subscription: Subscription): Promise<void> {
    this.subscriptions.delete(subscription);
    if (this.subscriptions.size) return;
    clearTimeout(this.retry);
    this.retry = undefined;
    this.session?.dispose();
    // A late acquisition must be discarded before the owning pool is ended.
    await this.syncing;
  }

  private reconnect(): void {
    if (!this.subscriptions.size || this.retry || this.syncing) return;
    this.retry = setTimeout(() => { this.retry = undefined; this.sync(); }, this.retryMs);
    this.retry.unref();
    this.retryMs = Math.min(30_000, this.retryMs * 2);
  }

  private failed(error: unknown): void {
    if (this.subscriptions.size) this.recovering = true;
    for (const subscription of [...this.subscriptions]) {
      if (subscription.options.reconnect === false) this.subscriptions.delete(subscription);
      subscription.disconnected(error);
    }
  }

  private sync(): void {
    if (this.syncing || this.retry || !this.subscriptions.size) return;
    // Coalesce consumers started together before acquiring or issuing LISTEN.
    this.syncing = Promise.resolve().then(() => this.synchronize()).catch(error => {
      if (this.session) this.session.dispose(error);
      else this.failed(error);
    }).finally(() => {
      this.syncing = undefined;
      if (!this.session) this.reconnect();
      else if ([...this.subscriptions].some(subscription => !subscription.ready)) this.sync();
    });
  }

  private async acquire(): Promise<Session | undefined> {
    const client = await this.pool.connect();
    if (!this.subscriptions.size) { client.release(true); return; }
    const session: Session = { client, channels: new Set(), disposed: false, announced: false, dispose: () => {} };
    const notify = (notice: pg.Notification) => {
      if (session.disposed) return;
      for (const subscription of [...this.subscriptions]) {
        if (subscription.healthy() && subscription.options.channels.includes(notice.channel)) {
          invoke(() => subscription.options.onNotification(notice));
        }
      }
    };
    session.dispose = (error = new Error("database_notification_listener_unavailable")) => {
      if (session.disposed) return;
      session.disposed = true;
      clearTimeout(session.retirement);
      client.removeListener("notification", notify);
      if (this.session === session) this.session = undefined;
      // Retain idempotent error/end handlers through socket teardown. Never
      // return a connection with session-scoped LISTEN state to a query pool.
      client.release(true);
      this.failed(error);
      this.reconnect();
    };
    this.session = session;
    client.on("notification", notify);
    client.on("error", session.dispose);
    client.on("end", session.dispose);
    return session;
  }

  private async synchronize(): Promise<void> {
    const session = this.session ?? await this.acquire();
    if (!session) return;
    while (!session.disposed) {
      const channels = [...new Set([...this.subscriptions].flatMap(subscription => subscription.options.channels))];
      const missing = channels.filter(channel => !session.channels.has(channel));
      if (missing.length) {
        try {
          await session.client.query(missing.map(channel => `LISTEN ${channel}`).join("; "));
        } catch (error) {
          // Initial callers retain the driver's failure, while diagnostics
          // remain closed strings and automatic retries stay payload-free.
          session.dispose(error);
          return;
        }
        if (session.disposed) return;
        for (const channel of missing) session.channels.add(channel);
      }
      this.retryMs = 1_000;
      if (!session.retirement) {
        session.retirement = setTimeout(() => {
          if (session.disposed) return;
          this.logStatus("[database] notification listener rotating at lifetime limit");
          session.dispose();
        }, NOTIFICATION_CONNECTION_LIFETIME_MS);
        session.retirement.unref();
      }
      for (const subscription of [...this.subscriptions]) {
        if (subscription.options.channels.every(channel => session.channels.has(channel))) subscription.connected();
      }
      if ([...this.subscriptions].every(subscription => subscription.ready)) {
        if (!session.disposed && !session.announced && this.subscriptions.size) {
          session.announced = true;
          this.logStatus(this.recovering
            ? "[database] notification listener restored"
            : "[database] notification listener ready");
          this.recovering = false;
        }
        return;
      }
    }
  }

  private logStatus(message: string): void {
    try { console.info(message); } catch { /* Observability cannot break listening. */ }
  }
}
