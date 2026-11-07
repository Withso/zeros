import { AsyncLocalStorage } from "node:async_hooks";
import { parse, type DefaultTreeAdapterTypes } from "parse5";

type Document = DefaultTreeAdapterTypes.Document;

interface SharedParses {
  documents: Map<string, Document>;
  derived: Map<symbol, Map<string, unknown>>;
}

/** A frame's render preparation parses the same text at several stages:
 * healing, linking, Tailwind candidates, sanitizing and stripping often see
 * an unchanged string. Inside one preparation those stages share one located
 * tree per distinct text. */
const scope = new AsyncLocalStorage<SharedParses>();
/** Each stage reads the text the previous stage produced, so the two most
 * recent trees serve every reuse. Larger text is parsed per stage, as
 * unshared parsing does, rather than retaining element-dense trees. */
const MAX_SHARED_DOCUMENTS = 2;
const MAX_SHARED_DERIVATIONS = 2;
const MAX_SHARED_SOURCE_CHARS = 512 * 1024;

const testing = { disabled: false, freeze: false, parses: 0, shared: 0 };

export function withSharedDesignParses<T>(work: () => Promise<T>): Promise<T> {
  if (testing.disabled || scope.getStore()) return work();
  return scope.run({ documents: new Map(), derived: new Map() }, work);
}

/** `parse(source, { sourceCodeLocationInfo: true })`, shared within a scope.
 * Callers must not modify the tree: later stages, the sanitizer among them,
 * read the same one. */
export function parseDesignSource(source: string): Document {
  const shared = scope.getStore();
  const cached = shared?.documents.get(source);
  if (cached) {
    testing.shared++;
    return cached;
  }
  testing.parses++;
  const document = parse(source, { sourceCodeLocationInfo: true });
  if (shared && source.length <= MAX_SHARED_SOURCE_CHARS) {
    if (testing.freeze) freezeTree(document);
    remember(shared.documents, source, document, MAX_SHARED_DOCUMENTS);
  }
  return document;
}

/** A tree a stage already parsed in this scope, for readers that need no
 * source locations; the caller parses itself when there is none. */
export function sharedDesignParse(source: string): Document | undefined {
  const document = scope.getStore()?.documents.get(source);
  if (document) testing.shared++;
  return document;
}

/** A pure derivation of `source`, computed once per scope. */
export function sharedDesignDerivation<T>(kind: symbol, source: string, derive: () => T): T {
  const shared = scope.getStore();
  if (!shared || source.length > MAX_SHARED_SOURCE_CHARS) return derive();
  let values = shared.derived.get(kind);
  if (!values) shared.derived.set(kind, (values = new Map()));
  if (values.has(source)) return values.get(source) as T;
  const value = derive();
  if (testing.freeze && value && typeof value === "object") freezeTree(value);
  remember(values, source, value, MAX_SHARED_DERIVATIONS);
  return value;
}

function remember<T>(entries: Map<string, T>, key: string, value: T, limit: number): void {
  entries.set(key, value);
  if (entries.size > limit) entries.delete(entries.keys().next().value!);
}

function freezeTree(root: object): void {
  const pending: object[] = [root];
  const seen = new Set<object>();
  while (pending.length) {
    const value = pending.pop()!;
    if (seen.has(value)) continue;
    seen.add(value);
    for (const child of Object.values(value)) {
      if (child && typeof child === "object") pending.push(child);
    }
    Object.freeze(value);
  }
}

/** Test hooks: compare against unshared parsing, and prove no stage mutates
 * a shared tree (frozen trees throw on writes in strict mode). */
export function configureSharedDesignParsesForTests(options: { disabled?: boolean; freeze?: boolean }): void {
  testing.disabled = options.disabled ?? false;
  testing.freeze = options.freeze ?? false;
}

export function sharedDesignParseStatsForTests(): { parses: number; shared: number } {
  return { parses: testing.parses, shared: testing.shared };
}
