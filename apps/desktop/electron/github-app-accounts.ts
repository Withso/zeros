// Per-account GitHub App connections on a Mac shared by several Zeros
// accounts. The connection in use stays in `github.app`, so older builds and the
// refresh path keep reading one slot; other accounts' connections wait in
// `github.app.parked` and move back when their account becomes active again.

import {
  sanitizeGithubCredential,
  type GithubCredential,
} from "@zeros/protocol/github-auth";
import { GITHUB_APP_ACCOUNT } from "./github-credential-store";

export const GITHUB_APP_PARKED_ACCOUNT = "github.app.parked";
const MAX_PARKED_CONNECTIONS = 12;

type GithubAppCredential = Extract<GithubCredential, { method: "github-app" }>;

export interface GithubAppSlotStore {
  update(
    accounts: readonly string[],
    update: (values: Record<string, string | null>) => Record<string, string | null>,
  ): void;
}

function parseCredential(raw: unknown): GithubAppCredential | null {
  const credential = sanitizeGithubCredential(raw);
  return credential?.method === "github-app" ? credential : null;
}

function parseSlot(raw: string | null): GithubAppCredential | null {
  if (!raw) return null;
  try {
    return parseCredential(JSON.parse(raw));
  } catch {
    return null;
  }
}

function parseParked(raw: string | null): Map<string, GithubAppCredential> {
  const parked = new Map<string, GithubAppCredential>();
  if (!raw) return parked;
  try {
    const value = JSON.parse(raw) as { version?: unknown; connections?: unknown };
    if (value?.version !== 1 || !Array.isArray(value.connections)) return parked;
    for (const entry of value.connections) {
      const credential = parseCredential(entry);
      if (credential?.ownerSub) parked.set(credential.ownerSub, credential);
    }
  } catch {
    return parked;
  }
  return parked;
}

function serializeParked(parked: ReadonlyMap<string, GithubAppCredential>): string | null {
  const connections = [...parked.values()].slice(-MAX_PARKED_CONNECTIONS);
  return connections.length ? JSON.stringify({ version: 1, connections }) : null;
}

/**
 * Put `owner`'s GitHub App connection in the shared slot, parking the one there
 * when it belongs to another account. A connection without a recorded owner
 * predates this and stays where it is. Returns whether the slot changed.
 */
export function selectGithubAppConnection(store: GithubAppSlotStore, owner: string | null): boolean {
  let changed = false;
  store.update([GITHUB_APP_ACCOUNT, GITHUB_APP_PARKED_ACCOUNT], (values) => {
    const inUse = parseSlot(values[GITHUB_APP_ACCOUNT]);
    if (!owner || (values[GITHUB_APP_ACCOUNT] && !inUse?.ownerSub) || inUse?.ownerSub === owner) {
      return values;
    }
    const parked = parseParked(values[GITHUB_APP_PARKED_ACCOUNT]);
    if (inUse?.ownerSub) {
      parked.delete(inUse.ownerSub);
      parked.set(inUse.ownerSub, inUse);
    }
    const restored = parked.get(owner) ?? null;
    parked.delete(owner);
    changed = Boolean(inUse || restored);
    return {
      [GITHUB_APP_ACCOUNT]: restored ? JSON.stringify(restored) : null,
      [GITHUB_APP_PARKED_ACCOUNT]: serializeParked(parked),
    };
  });
  return changed;
}
