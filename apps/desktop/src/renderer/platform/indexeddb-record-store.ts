// ──────────────────────────────────────────────────────────
// IndexedDB record store — records plus a small index, one connection
// ──────────────────────────────────────────────────────────
//
// The shared backend of the renderer's purgeable boot caches (Local chat
// transcripts, Design canvas pictures). Each keeps large records in one object
// store and a small metadata row per record in another, both under the same
// key, so a session reads the whole index once and the records it shows. The
// caches own policy (keys, bounds, eligibility); this only moves records and
// owns the connection's lifecycle.
// ──────────────────────────────────────────────────────────

export interface IndexedDbRecordStoreChange<R, E> {
  /** Retire a cache namespace atomically, including malformed index rows. */
  clear?: boolean;
  put?: Array<{ record: R; entry: E }>;
  touch?: E[];
  remove?: string[];
}

export interface IndexedDbRecordStore<R, E> {
  readIndex(): Promise<E[]>;
  /** The valid records of `keys`, in their order; missing ones are skipped. */
  read(keys: readonly string[]): Promise<R[]>;
  /** Replace records and index rows, and delete `remove`, in one transaction. */
  commit(change: IndexedDbRecordStoreChange<R, E>): Promise<void>;
}

export interface IndexedDbRecordStoreOptions<R, E> {
  factory: IDBFactory | undefined;
  database: string;
  /** Object store of the records; the index rows live in `index`. */
  records: string;
  keyPath: string;
  isEntry(value: unknown): value is E;
  /** The record stored under `key`, or null when it is not a valid one. */
  record(value: unknown, key: string): R | null;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
}

const INDEX = "index";

/** One long-lived connection: reads must not pay an open each. A failed open
 * disables the store for the session (its cache degrades to memory-only). A
 * connection the browser closes (storage cleared, an I/O error) or another
 * window's version change retires it, and the next call opens a new one. */
export function createIndexedDbRecordStore<R, E>(
  options: IndexedDbRecordStoreOptions<R, E>,
): IndexedDbRecordStore<R, E> | null {
  const { factory, keyPath, records } = options;
  if (!factory) return null;
  let connection: Promise<IDBDatabase | null> | null = null;
  let opened: IDBDatabase | null = null;
  const retire = (db: IDBDatabase) => {
    if (opened !== db) return;
    opened = null;
    connection = null;
  };
  const database = (): Promise<IDBDatabase | null> => {
    connection ??= new Promise<IDBDatabase | null>((resolve) => {
      let open: IDBOpenDBRequest;
      try {
        open = factory.open(options.database, 1);
      } catch {
        resolve(null);
        return;
      }
      open.onupgradeneeded = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains(records)) db.createObjectStore(records, { keyPath });
        if (!db.objectStoreNames.contains(INDEX)) db.createObjectStore(INDEX, { keyPath });
      };
      open.onerror = () => resolve(null);
      open.onblocked = () => resolve(null);
      open.onsuccess = () => {
        const db = open.result;
        db.onversionchange = () => {
          db.close();
          retire(db);
        };
        db.onclose = () => retire(db);
        opened = db;
        resolve(db);
      };
    });
    return connection;
  };
  // A connection that closed before its event arrived refuses transactions
  // synchronously; retire it so the next call reopens.
  const transaction = (
    db: IDBDatabase,
    stores: string | string[],
    mode: IDBTransactionMode,
  ): IDBTransaction => {
    try {
      return db.transaction(stores, mode);
    } catch (error) {
      if ((error as { name?: string } | null)?.name === "InvalidStateError") retire(db);
      throw error;
    }
  };

  return {
    async readIndex() {
      const db = await database();
      if (!db) return [];
      const rows = await requestResult(
        transaction(db, INDEX, "readonly").objectStore(INDEX).getAll(),
      );
      return (rows as unknown[]).filter(options.isEntry);
    },
    async read(keys) {
      const db = await database();
      if (!db || keys.length === 0) return [];
      const store = transaction(db, records, "readonly").objectStore(records);
      const values = await Promise.all(keys.map((key) => requestResult(store.get(key))));
      return values.flatMap((value, index) => options.record(value, keys[index]!) ?? []);
    },
    async commit(change) {
      const db = await database();
      if (!db) return;
      const write = transaction(db, [records, INDEX], "readwrite");
      const recordStore = write.objectStore(records);
      const index = write.objectStore(INDEX);
      if (change.clear) {
        recordStore.clear();
        index.clear();
      }
      for (const key of change.remove ?? []) {
        recordStore.delete(key);
        index.delete(key);
      }
      for (const { record, entry } of change.put ?? []) {
        recordStore.put(record);
        index.put(entry);
      }
      for (const entry of change.touch ?? []) index.put(entry);
      await transactionDone(write);
    },
  };
}
