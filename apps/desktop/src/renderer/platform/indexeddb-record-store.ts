// Records and metadata share a key in separate stores, so startup scans the index without reading record bytes.

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
  records: string;
  keyPath: string;
  isEntry(value: unknown): value is E;
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

/** Reuse the connection. A failed open disables persistence for the session; closure or a version change lets the next operation reopen. */
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
  // Transactions may refuse a closed connection before its close event; retire it on that error.
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
