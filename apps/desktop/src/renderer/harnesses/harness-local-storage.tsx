// Standalone development harness — NOT part of the shipped app.
//
// The real Settings page (rail, Local Storage panel, store and owner
// switching) from the app-sidebar harness, with a native Local Storage double
// in place of Electron main: only the measured sizes are fixtures.
import {
  LOCAL_STORAGE_CATEGORY_IDS,
  LOCAL_STORAGE_PROGRESS_EVENT,
  type LocalStorageCategoryId,
  type LocalStorageReport,
} from "../../../shared/local-storage";

// The section is offered in the Mac app only; this fixture stands in for it.
Object.defineProperty(navigator, "platform", { configurable: true, get: () => "MacIntel" });

const MB = 1_000_000;
const LOADED: Record<LocalStorageCategoryId, number> = {
  workspaces: 58 * MB,
  "cloud-sync": 157 * MB,
  chats: 124 * MB,
  "provider-accounts": 473 * MB,
  "window-state": 2.4 * MB,
  "other-app-data": 45 * MB,
  cache: 61 * MB,
  logs: 19 * MB,
  updates: 1_020 * MB,
};
const LOCATIONS: Partial<Record<LocalStorageCategoryId, string>> = {
  workspaces: "~/zeros/workspaces",
  "cloud-sync": "~/zeros/cloud-sync",
};

type Sizes = Partial<Record<LocalStorageCategoryId, { bytes: number | null; status?: "measured" | "partial" | "unmeasured"; measuring?: boolean; progress?: number }>>;

const calls: { command: string; args: unknown }[] = [];
const handlers = new Set<(payload: unknown) => void>();
let revision = 0;
let confirmed: Sizes = {};
let held: { resolve: () => void } | null = null;
let holdNext = false;
let cancelled = false;

function build(sizes: Sizes, measuring: boolean): LocalStorageReport {
  revision += 1;
  return {
    revision,
    measuring,
    measuredAt: measuring ? null : Date.now(),
    categories: LOCAL_STORAGE_CATEGORY_IDS.map((id) => {
      const size = sizes[id];
      const bytes = size?.bytes ?? null;
      return {
        id,
        status: bytes === null ? "unmeasured" : (size?.status ?? "measured"),
        bytes: bytes === null ? null : Math.round(bytes),
        measuring: size?.measuring ?? false,
        progressBytes: size?.progress ?? null,
        location: LOCATIONS[id] ?? null,
        revealable: true,
      };
    }),
  };
}
const loaded = (): Sizes => Object.fromEntries(LOCAL_STORAGE_CATEGORY_IDS.map((id) => [id, { bytes: LOADED[id] }]));
const emit = (report: LocalStorageReport) => {
  for (const handler of handlers) handler(structuredClone(report));
};

const fixture = {
  calls: () => calls.map(({ command }) => command),
  callsOf: (command: string) => calls.filter((call) => call.command === command).map((call) => call.args),
  /** The next measurement stops part-way, as a first walk of a large folder does. */
  hold: () => {
    holdNext = true;
  },
  release: () => held?.resolve(),
  pending: () => held !== null,
  listeners: () => handlers.size,
};
declare global {
  interface Window {
    __localStorageFixture: typeof fixture;
  }
}
window.__localStorageFixture = fixture;

await import("./harness-app-sidebar");

const base = window.__ZEROS_NATIVE__!;
window.__ZEROS_NATIVE__ = {
  ...base,
  on<T>(event: string, handler: (payload: T) => void) {
    if (event !== LOCAL_STORAGE_PROGRESS_EVENT) return base.on(event, handler);
    const wrapped = handler as (payload: unknown) => void;
    handlers.add(wrapped);
    return () => handlers.delete(wrapped);
  },
  async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    if (!command.startsWith("local_storage_")) return base.invoke<T>(command, args);
    calls.push({ command, args });
    if (command === "local_storage_measure") {
      if (holdNext) {
        holdNext = false;
        const partial: Sizes = {
          ...confirmed,
          ...loaded(),
          workspaces: { bytes: confirmed.workspaces?.bytes ?? null, measuring: true, progress: 41 * MB },
          "cloud-sync": { bytes: confirmed["cloud-sync"]?.bytes ?? null, measuring: true },
        };
        emit(build(partial, true));
        await new Promise<void>((resolve) => {
          held = { resolve };
        });
        held = null;
        if (cancelled) {
          cancelled = false;
          // Main keeps the last confirmed sizes when a walk is cancelled.
          const report = build(confirmed, false);
          emit(report);
          return report as T;
        }
      } else {
        emit(build({ ...confirmed, chats: { bytes: LOADED.chats } }, true));
      }
      confirmed = loaded();
      const report = build(confirmed, false);
      emit(report);
      return report as T;
    }
    if (command === "local_storage_cancel") {
      cancelled = held !== null;
      held?.resolve();
      return null as T;
    }
    if (command === "local_storage_clear_cache") {
      const after = 3.1 * MB;
      const freed = (confirmed.cache?.bytes ?? LOADED.cache) - after;
      confirmed = { ...confirmed, cache: { bytes: after } };
      return { freedBytes: Math.round(freed), report: build(confirmed, false) } as T;
    }
    return null as T;
  },
};
