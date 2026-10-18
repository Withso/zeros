import { createContext, useContext, useSyncExternalStore } from "react";

export class DesignSavedEditingSession {
  editing = false;
  private alive = true;
  private generation = 0;
  private intent = 0;
  private advisoryPixels = false;
  private preparations = new Map<() => void | Promise<void>, Promise<void> | null>();
  private failures = new Set<() => void | Promise<void>>();
  private drains = new Set<() => Promise<void>>();
  private listeners = new Set<() => void>();

  constructor(private readonly ownerIsCurrent: () => boolean) {}

  isCurrent = () => this.alive && this.ownerIsCurrent();
  needsNativePixels = () => this.advisoryPixels;
  snapshot = () => !this.editing ? 0 : this.failures.size || [...this.preparations.values()].some(Boolean) ? 1 : 2;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish() { for (const listener of this.listeners) listener(); }

  activate() { this.alive = true; }

  requireNativePixels() {
    if (this.advisoryPixels) return;
    this.advisoryPixels = true;
    this.publish();
  }

  retire() {
    this.alive = false;
    this.generation += 1;
    this.intent += 1;
    this.editing = false;
    this.failures.clear();
    for (const prepare of this.preparations.keys()) this.preparations.set(prepare, null);
    this.publish();
  }

  private prepare(prepare: () => void | Promise<void>) {
    const generation = this.generation;
    try {
      const result = prepare();
      if (!result) {
        this.preparations.set(prepare, null);
        return;
      }
      const pending = result.catch(() => {
        if (this.isCurrent() && this.generation === generation && this.preparations.get(prepare) === pending)
          this.failures.add(prepare);
      }).finally(() => {
        if (this.generation !== generation || this.preparations.get(prepare) !== pending) return;
        this.preparations.set(prepare, null);
        this.publish();
      });
      this.preparations.set(prepare, pending);
    } catch {
      this.failures.add(prepare);
    }
  }

  registerPreparation(prepare: () => void | Promise<void>) {
    this.preparations.set(prepare, null);
    if (this.editing) this.prepare(prepare);
    this.publish();
    return () => {
      this.preparations.delete(prepare);
      this.failures.delete(prepare);
      this.publish();
    };
  }

  registerDrain(drain: () => Promise<void>) {
    this.drains.add(drain);
    return () => { this.drains.delete(drain); };
  }

  retain(save: Promise<unknown>) {
    const drain = async () => { await save; };
    const remove = this.registerDrain(drain);
    void save.then(remove, remove);
  }

  enter(): boolean {
    if (!this.isCurrent()) return false;
    this.intent += 1;
    if (!this.editing || this.failures.size) {
      this.editing = true;
      this.generation += 1;
      this.failures.clear();
      for (const prepare of this.preparations.keys()) this.prepare(prepare);
      this.publish();
    }
    return this.snapshot() === 2;
  }

  leave(): void {
    const intent = ++this.intent;
    void Promise.resolve().then(async () => {
      await Promise.all([...this.drains].map((drain) => drain().catch(() => {})));
      await Promise.all([...this.preparations.values()]);
      if (!this.isCurrent() || this.intent !== intent) return;
      this.generation += 1;
      this.editing = false;
      this.failures.clear();
      this.publish();
    });
  }
}

export const DesignSavedEditingContext = createContext<DesignSavedEditingSession | null>(null);
const subscribeEmpty = () => () => {};
const viewSnapshot = () => 0;
const nativePixelsSnapshot = () => false;

export function useDesignSavedEditing() {
  const session = useContext(DesignSavedEditingContext);
  const state = useSyncExternalStore(session?.subscribe ?? subscribeEmpty, session?.snapshot ?? viewSnapshot, viewSnapshot);
  const nativePixels = useSyncExternalStore(session?.subscribe ?? subscribeEmpty, session?.needsNativePixels ?? nativePixelsSnapshot, nativePixelsSnapshot);
  return { session, state, nativePixels };
}
