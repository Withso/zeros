import { expect, it } from "vitest";
import { createIndexedDbRecordStore } from "../indexeddb-record-store";

type Handler = (() => void) | null;

/** The IndexedDB surface the record store uses, with a hook for the browser
 * closing a connection (storage cleared, an I/O error). */
function fakeIndexedDb() {
  const databases = new Map<string, { stores: Map<string, Map<string, unknown>>; keyPaths: Map<string, string> }>();
  const connections: FakeDatabase[] = [];
  const state = { failOpen: false, opens: 0 };

  class FakeDatabase {
    closed = false;
    onclose: Handler = null;
    onversionchange: Handler = null;
    constructor(private readonly data: { stores: Map<string, Map<string, unknown>>; keyPaths: Map<string, string> }) {}
    objectStoreNames = { contains: (name: string) => this.data.stores.has(name) };
    createObjectStore(name: string, options: { keyPath: string }) {
      this.data.stores.set(name, new Map());
      this.data.keyPaths.set(name, options.keyPath);
    }
    close() {
      this.closed = true;
    }
    /** The browser closes the connection and says so. */
    lose() {
      this.closed = true;
      this.onclose?.();
    }
    transaction(names: string | string[]) {
      if (this.closed) throw new DOMException("The database connection is closing.", "InvalidStateError");
      let pending = 0;
      let done = false;
      const transaction = { oncomplete: null as Handler, onabort: null as Handler, onerror: null as Handler, error: null,
        objectStore: (name: string) => {
          if (!(Array.isArray(names) ? names : [names]).includes(name)) throw new Error(`${name} is outside the transaction`);
          const store = this.data.stores.get(name)!;
          const keyPath = this.data.keyPaths.get(name)!;
          const request = <T>(run: () => T) => {
            pending++;
            const result = { result: undefined as T | undefined, error: null, onsuccess: null as Handler, onerror: null as Handler };
            setTimeout(() => {
              result.result = run();
              pending--;
              result.onsuccess?.();
              complete();
            });
            return result;
          };
          return {
            get: (key: string) => request(() => store.get(key)),
            getAll: () => request(() => [...store.values()]),
            put: (value: Record<string, unknown>) => request(() => void store.set(String(value[keyPath]), value)),
            delete: (key: string) => request(() => void store.delete(key)),
          };
        },
      };
      const complete = () => {
        if (pending || done) return;
        done = true;
        setTimeout(() => transaction.oncomplete?.());
      };
      setTimeout(complete);
      return transaction;
    }
  }

  const factory = {
    open(name: string) {
      state.opens++;
      const request = { result: undefined as FakeDatabase | undefined, error: null as DOMException | null,
        onupgradeneeded: null as Handler, onsuccess: null as Handler, onerror: null as Handler, onblocked: null as Handler };
      setTimeout(() => {
        if (state.failOpen) {
          request.error = new DOMException("Storage is unavailable.", "UnknownError");
          request.onerror?.();
          return;
        }
        let data = databases.get(name);
        const fresh = !data;
        if (!data) databases.set(name, (data = { stores: new Map(), keyPaths: new Map() }));
        request.result = new FakeDatabase(data);
        if (fresh) request.onupgradeneeded?.();
        connections.push(request.result);
        request.onsuccess?.();
      });
      return request;
    },
  };
  return { factory: factory as unknown as IDBFactory, databases, connections, state };
}

interface Row { id: string; bytes: number }
interface Item { id: string; text: string }

function open(factory: IDBFactory) {
  return createIndexedDbRecordStore<Item, Row>({
    factory,
    database: "zeros:test:v1",
    records: "items",
    keyPath: "id",
    isEntry: (value): value is Row =>
      typeof (value as Partial<Row> | null)?.id === "string" && typeof (value as Partial<Row>).bytes === "number",
    record: (value, key) => {
      const item = value as Partial<Item> | undefined;
      return item?.id === key && typeof item.text === "string" ? { id: key, text: item.text } : null;
    },
  })!;
}

const put = (id: string, text: string) => ({ record: { id, text }, entry: { id, bytes: text.length } });

it("keeps records and index rows together, reading only valid ones in the order asked", async () => {
  const idb = fakeIndexedDb();
  const store = open(idb.factory);
  await store.commit({ put: [put("a", "A"), put("b", "BB")] });
  idb.databases.get("zeros:test:v1")!.stores.get("index")!.set("junk", { id: "junk" });
  expect(await store.readIndex()).toEqual([{ id: "a", bytes: 1 }, { id: "b", bytes: 2 }]);
  expect(await store.read(["b", "missing", "a"])).toEqual([{ id: "b", text: "BB" }, { id: "a", text: "A" }]);
  await store.commit({ remove: ["a"], touch: [{ id: "b", bytes: 3 }] });
  expect(await store.readIndex()).toEqual([{ id: "b", bytes: 3 }]);
  expect(await store.read(["a"])).toEqual([]);
  expect(idb.state.opens).toBe(1);
});

it("opens a new connection after the browser closes the old one", async () => {
  const idb = fakeIndexedDb();
  const store = open(idb.factory);
  await store.commit({ put: [put("a", "A")] });
  idb.connections[0]!.lose();
  expect(await store.read(["a"])).toEqual([{ id: "a", text: "A" }]);
  expect(idb.state.opens).toBe(2);
});

it("opens a new connection when a closed one refuses a transaction before its close event", async () => {
  const idb = fakeIndexedDb();
  const store = open(idb.factory);
  await store.commit({ put: [put("a", "A")] });
  idb.connections[0]!.closed = true;
  await expect(store.read(["a"])).rejects.toThrow(/closing/);
  expect(await store.read(["a"])).toEqual([{ id: "a", text: "A" }]);
  expect(idb.state.opens).toBe(2);
});

it("closes for another window's version change and reopens on the next call", async () => {
  const idb = fakeIndexedDb();
  const store = open(idb.factory);
  await store.commit({ put: [put("a", "A")] });
  idb.connections[0]!.onversionchange?.();
  expect(idb.connections[0]!.closed).toBe(true);
  expect(await store.readIndex()).toEqual([{ id: "a", bytes: 1 }]);
  expect(idb.state.opens).toBe(2);
});

it("degrades to an empty store for the session when the database cannot open", async () => {
  const idb = fakeIndexedDb();
  idb.state.failOpen = true;
  const store = open(idb.factory);
  expect(await store.readIndex()).toEqual([]);
  expect(await store.read(["a"])).toEqual([]);
  await expect(store.commit({ put: [put("a", "A")] })).resolves.toBeUndefined();
  expect(idb.state.opens).toBe(1);
  expect(createIndexedDbRecordStore({ factory: undefined, database: "x", records: "items", keyPath: "id",
    isEntry: (value): value is Row => !!value, record: () => null })).toBeNull();
});
