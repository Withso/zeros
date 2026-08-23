// ──────────────────────────────────────────────────────────
// Terminal Store — workbench terminal panel terminal panel
// ──────────────────────────────────────────────────────────
//
// Tracks open PTY sessions across the app. Each session is
// scoped to a workspace folder (= the chat's `folder` at create
// time) so when the user switches workspaces, the panel filters
// to the right set of terminals.
//
// Collapsing terminal panel keeps every TerminalSessionView mounted; survival across a
// full workbench collapse is METADATA-ONLY today. The
// <Workbench> tree (which owns the panel + every TerminalSessionView)
// unmounts on collapse, so the underlying PTYs die; the store
// keeps title/folder/alive bits so a re-expand restores the tab
// strip with the right names. A full hoist that keeps shells
// alive across collapse is a follow-up — the obvious approach
// (move the panel to MainShellBody) made the panel cover conversation pane's
// chat composer on first paint and was reverted on 2026-05-23.
//
// State shape:
//   sessions:        flat array; ordered by createdAt ASC so newer
//                    tabs land on the right
//   activeTerminalTabByFolder:
//                    per-folder active TERMINAL TAB — "setup" OR a
//                    session id (the run terminal or a plain "Terminal N").
//                    This is which Setup / Run / Terminal tab is focused.
// Terminal panel expansion and height are separate GLOBAL layout state in
// terminal-panel-layout.ts (shared across workspaces/repos); session
// persistence stays here.
//
// PTY lifecycle:
//   - `createSession`   → renderer mints an id + dispatches
//                         `pty_create` in the terminal panel panel; the
//                         session view component owns the IPC.
//                         This store only records the metadata.
//   - `closeSession`    → removes from list AND fires `pty_kill`.
//   - `markExited`      → external (PTY exited on its own); marks
//                         the entry so the tab shows a "(exited)"
//                         badge until the user closes it.
//
// Title naming:
//   - Exactly one terminal in the folder → titled "Terminal"
//     (no number).
//   - Two or more → titled "Terminal 1" / "Terminal 2" / … by
//     `createdAt` ascending. The list re-numbers contiguously on
//     every create/delete so the user always sees 1, 2, 3 with
//     no gaps. Custom renames via the tab pill are intentionally
//     overwritten by the next mutation — the user explicitly
//     asked for the strict ascending order.
//   - The last terminal in a folder cannot be closed (the close
//     affordance is hidden when `sessions.length === 1`).
// ──────────────────────────────────────────────────────────

import { create } from "zustand";

import { isRunSessionId } from "@zeros/protocol/run-actions";

import {
  onPtyData,
  onPtyExit,
  ptyKill,
  type PtyExitEvent,
} from "../../platform/pty";
import { loadProjects } from "../../state/projects-store";
import {
  folderIsOwnedByProject,
  folderIsWithinRoot,
} from "../../state/workspace-resolution";
import { recordWorkspaceActivity } from "../../state/workspace-store";

// Per-(folder, action) run session ids live in @zeros/protocol/run-actions now —
// the ENGINE mints/validates the same ids (RunManager), so the hash has one
// home. Re-exported verbatim so existing imports keep working: runSessionId
// keeps the legacy unsuffixed id for the migrated "run" action, so persisted
// run terminals keep matching.
export { runSessionId, isRunSessionId } from "@zeros/protocol/run-actions";

export interface TerminalSession {
  id: string;
  /** Workspace folder this terminal was spawned in (= the chat's
   *  `folder` at create time). Used to scope the tab strip per
   *  workspace. Never mutated. */
  folder: string;
  title: string;
  createdAt: number;
  /** False once the underlying PTY has exited. The tab stays in the
   *  strip with an "(exited)" suffix so the user can read final
   *  output; closing the tab removes it. */
  alive: boolean;
  /** Terminal-agent profile to auto-launch after the PTY shell is
   *  ready (resolved at create time from the Settings → Providers
   *  → Terminal agents default). Null = plain shell. Stable across
   *  the session's lifetime so a re-mount knows whether it already
   *  fired the launch line. */
  agentId: string | null;
  /** A command typed into the shell once, on the original spawn (the repo's
   *  `scripts.run` dev server). RUNTIME-ONLY: dropped on persistence/hydration
   *  so it never re-fires on reload — TerminalSessionView's reattach latch
   *  already keeps it from re-running within a session's lifetime. A session
   *  carrying this also keeps its own title (skipped by `renumberFolder`). */
  initialCommand?: string;
  /** Multiplayer reconcile flag: true once this terminal has been CONFIRMED
   *  present in the engine's shared registry. Set by syncEngineTerminals; a
   *  terminal that was engineSeen and then VANISHES from the registry was closed
   *  on another device → drop it. A locally-created terminal stays unseen (so a
   *  not-yet-registered create isn't pruned) until it shows up in a list.
   *  Runtime-only — NOT persisted, so a reload never surprise-prunes a tab. */
  engineSeen?: boolean;
  /** True once the user renames this terminal (via terminal panel's terminal
   *  dropdown). A renamed terminal KEEPS its title — renumberFolder skips it
   *  (like run terminals) so a later create/delete doesn't overwrite the custom
   *  name. Persisted so the name survives a reload. */
  renamed?: boolean;
}

interface TerminalStoreState {
  sessions: TerminalSession[];
  /** Terminal panel's active tab ("setup" OR a session id), per folder. */
  activeTerminalTabByFolder: Record<string, string | null>;
  /** Explicit owner deletion invalidates retained terminal/Setup DOM decks. */
  retentionGeneration: number;

  // ── Mutators ─────────────────────────────────────────────
  /** Create (or, when `id` matches an existing session, focus) a terminal in
   *  `folder`. `initialCommand` is typed into the shell once on first spawn
   *  (the repo's run script); `id` lets a caller use a deterministic session
   *  id (the per-folder "run" terminal) so a repeat Run reattaches to the live
   *  one instead of spawning a duplicate. */
  createSession(
    folder: string,
    agentId?: string | null,
    initialCommand?: string,
    id?: string,
    /** When false, the terminal is created but NOT made the active sub-tab —
     *  used by auto-seeding so the current sub-tab stays selected. */
    activate?: boolean,
    /** Explicit title for a pinned session (a run action's name). Plain
     *  terminals omit it and get renumbered "Terminal N" names. */
    title?: string,
  ): TerminalSession;
  /** Reconcile a folder's tab strip against the engine's SHARED terminal
   *  registry (multiplayer): ADD terminals this device doesn't have yet (so it
   *  shows terminals another device created), and REMOVE ones that were
   *  confirmed-present and have since vanished from the registry (closed on
   *  another device). `folderTerminals` = engine terminals whose cwd is THIS
   *  folder (for additions); `allEngineIds` = every live terminal id (for the
   *  vanish check, so a terminal isn't pruned just because the caller scoped the
   *  list). A no-op returns the same state (no re-render). */
  syncEngineTerminals(
    folder: string,
    folderTerminals: Array<{
      sessionId: string;
      createdAt: number;
      exited?: boolean;
    }>,
    allEngineIds: string[],
  ): void;
  renameSession(id: string, title: string): void;
  markExited(id: string): void;
  markAlive(id: string): void;
  closeSession(id: string): void;
  /** Set the active TERMINAL sub-tab for a folder ("setup" or a session id). */
  setActiveTerminalTab(folder: string, id: string): void;
  /** Remove a session even if it's the last one in its folder (the "at least
   *  one terminal" rule is bypassed). Used to restart an exited run terminal —
   *  the unmount lets the recreate re-fire its initialCommand. */
  forceCloseSession(id: string): void;
}

// The terminal STORE's persisted metadata (sessions + the active sub-tab map).
// The "terminal-panel" name is legacy — deliberately KEPT so existing users'
// saved terminal sessions/titles round-trip a reload (a rename would strand
// them). Layout now has its own global key in terminal-panel-layout.ts; the
// old source-panel global height/expanded keys are intentionally not reused.

const SESSIONS_KEY = "zeros:terminal-panel:sessions";
const MAX_TERMINAL_SELECTION_FOLDERS = 128;

/** Touch one per-folder selection while bounding stale owner identities. Null
 * means no explicit selection and is represented by absence, not dead weight. */
function setTerminalSelection(
  record: Record<string, string | null>,
  folder: string,
  id: string | null,
): Record<string, string | null> {
  if (!folder) return record;
  if (id === null && !(folder in record)) return record;
  if (
    id !== null &&
    record[folder] === id &&
    Object.keys(record).length <= MAX_TERMINAL_SELECTION_FOLDERS
  ) {
    return record;
  }
  const next = { ...record };
  delete next[folder];
  if (id !== null) next[folder] = id;
  const folders = Object.keys(next);
  for (
    let index = 0;
    index < folders.length - MAX_TERMINAL_SELECTION_FOLDERS;
    index += 1
  ) {
    delete next[folders[index]!];
  }
  return next;
}

function parseTerminalSelections(raw: unknown): Record<string, string | null> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>)
      .filter(
        (entry): entry is [string, string] =>
          entry[0].length > 0 &&
          typeof entry[1] === "string" &&
          entry[1].length > 0,
      )
      .slice(-MAX_TERMINAL_SELECTION_FOLDERS),
  );
}

/** Persisted shape of the terminal-store sessions. Only metadata —
 *  the PTY lives in the main process keyed by sessionId, and survives
 *  page refreshes there. On boot the hydrated list is rebound via
 *  TerminalSessionView's reattach-aware ptyCreate so the renderer
 *  walks back into the live shells with their full scrollback. */
interface PersistedSessions {
  sessions: TerminalSession[];
  activeTerminalTabByFolder: Record<string, string | null>;
}

function loadPersistedSessions(): PersistedSessions {
  const empty: PersistedSessions = {
    sessions: [],
    activeTerminalTabByFolder: {},
  };
  if (typeof window === "undefined") return empty;
  try {
    const raw = window.localStorage.getItem(SESSIONS_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return empty;
    const rec = parsed as Record<string, unknown>;
    const sessions = Array.isArray(rec.sessions) ? rec.sessions : [];
    const activeTerminalTabByFolder = parseTerminalSelections(
      rec.activeTerminalTabByFolder,
    );
    // Defensive: re-mark every restored session as "alive=true". The
    // actual PTY state lives in main; if a session is dead there, the
    // reattach in TerminalSessionView still spawns a fresh shell with
    // the same sessionId (idempotent). The store's `alive` flag is a
    // UI affordance updated by the markExited callback below.
    return {
      sessions: sessions
        .map((s) => ({
          id:
            typeof (s as { id?: unknown }).id === "string"
              ? (s as { id: string }).id
              : "",
          folder:
            typeof (s as { folder?: unknown }).folder === "string"
              ? (s as { folder: string }).folder
              : "",
          title:
            typeof (s as { title?: unknown }).title === "string"
              ? (s as { title: string }).title
              : "Terminal",
          createdAt:
            typeof (s as { createdAt?: unknown }).createdAt === "number"
              ? (s as { createdAt: number }).createdAt
              : Date.now(),
          alive: true,
          agentId:
            typeof (s as { agentId?: unknown }).agentId === "string"
              ? (s as { agentId: string }).agentId
              : null,
          // Preserve the custom-name flag so a rename survives reload (the title
          // is restored above; this keeps renumberFolder from overwriting it).
          renamed:
            (s as { renamed?: unknown }).renamed === true ? true : undefined,
        }))
        .filter((s) => s.id && s.folder)
        // Drop PRE-EXISTING persisted run sessions (written before run
        // sessions stopped being persisted) — their PTYs are gone, and the
        // durable last-run state covers them.
        .filter((s) => !isRunSessionId(s.id)),
      activeTerminalTabByFolder,
    };
  } catch {
    return empty;
  }
}

function persistSessions(state: {
  sessions: TerminalSession[];
  activeTerminalTabByFolder: Record<string, string | null>;
}): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      SESSIONS_KEY,
      JSON.stringify({
        // Run sessions are NOT persisted: they're reconstructable — a LIVE
        // run PTY is re-added from the engine's shared registry on the next
        // sync, and a dead one is better represented by the durable last-run
        // state (RunManager) than a stale tab. Persisting them made an app
        // relaunch mount a session whose PTY no longer existed, spawning a
        // plain shell under the deterministic run id.
        sessions: state.sessions.filter((s) => !isRunSessionId(s.id)),
        activeTerminalTabByFolder: parseTerminalSelections(
          state.activeTerminalTabByFolder,
        ),
      }),
    );
  } catch {
    /* quota / private mode — non-essential */
  }
}

let idCounter = 0;
function mintSessionId(): string {
  idCounter += 1;
  return `pty-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

/** True for a LEGACY trunk setup terminal (`pty-setup-<hash>`). The trunk's
 *  setup now runs through the engine's SetupManager (see setup-tab.tsx), so
 *  nothing MINTS these ids anymore — the recognizer remains so a persisted
 *  legacy session stays out of the plain "Terminal N" strip / numbering until
 *  TerminalPanel's migration purge closes it. */
export function isSetupSessionId(id: string): boolean {
  return id.startsWith("pty-setup-");
}

/** Walk `sessions` and rewrite every terminal in `folder` so the
 *  titles run contiguously: "Terminal" alone (one), or "Terminal 1",
 *  "Terminal 2", … sorted by `createdAt`. Sessions in other folders
 *  are untouched. Returns a new array — callers pass it through to
 *  `set({ sessions })`. */
function renumberFolder(
  sessions: TerminalSession[],
  folder: string,
): TerminalSession[] {
  const inFolder = sessions
    .filter((s) => s.folder === folder)
    .sort((a, b) => a.createdAt - b.createdAt);
  // Pinned terminals keep their own title and are RESERVED so the generated
  // "Terminal N" names skip them — otherwise renaming a terminal to e.g.
  // "Terminal 2" collides with an auto-numbered one (a duplicate in the list).
  // Pinned = run/setup terminals (runtime `initialCommand`, OR the persisted
  // `pty-run-`/`pty-setup-` id so a RELOADED one — whose initialCommand was
  // dropped — still keeps its title and stays out of the plain sequence) and
  // user-renamed ones.
  const isPinned = (s: TerminalSession) =>
    !!s.initialCommand ||
    !!s.renamed ||
    isRunSessionId(s.id) ||
    isSetupSessionId(s.id);
  const reserved = new Set(inFolder.filter(isPinned).map((s) => s.title));
  const plain = inFolder.filter((s) => !isPinned(s));
  const desired = new Map<string, string>();
  if (plain.length === 1 && !reserved.has("Terminal")) {
    desired.set(plain[0]!.id, "Terminal");
  } else {
    let n = 1;
    for (const s of plain) {
      while (reserved.has(`Terminal ${n}`)) n += 1;
      desired.set(s.id, `Terminal ${n}`);
      n += 1;
    }
  }
  return sessions.map((s) => {
    const next = desired.get(s.id);
    if (!next || s.title === next) return s;
    return { ...s, title: next };
  });
}

type StoreSet = (
  partial:
    | Partial<TerminalStoreState>
    | ((s: TerminalStoreState) => Partial<TerminalStoreState>),
) => void;
type StoreGet = () => TerminalStoreState;

/** Shared close logic. `force` bypasses the "at least one terminal per folder"
 *  rule (used to restart an exited run terminal). */
function closeSessionImpl(
  set: StoreSet,
  get: StoreGet,
  id: string,
  force: boolean,
): void {
  const target = get().sessions.find((s) => s.id === id);
  if (!target) return;
  // Enforce the "at least one terminal per folder" rule unless forced. The tab
  // pill hides its close affordance when there's one session, so this is
  // defence-in-depth for keyboard / programmatic callers that bypass the UI.
  const siblingsBefore = get().sessions.filter(
    (s) => s.folder === target.folder,
  );
  if (!force && siblingsBefore.length <= 1) return;
  if (target.alive) {
    void ptyKill({ sessionId: id }).catch(() => {
      /* main-side dead already — fine */
    });
  }
  set((s) => {
    const remaining = s.sessions.filter((sess) => sess.id !== id);
    const renumbered = renumberFolder(remaining, target.folder);
    // Repoint terminal panel's active terminal tab.
    let nextActive = s.activeTerminalTabByFolder;
    if (nextActive[target.folder] === id) {
      const siblings = renumbered.filter((x) => x.folder === target.folder);
      // Prefer a PLAIN terminal — the run + trunk-setup terminals have their own
      // sub-tabs (Run / Setup), so repointing onto one after deleting a plain
      // terminal would surprise the user (the plain tab looks unselected while
      // Run/Setup lights up).
      const plain = siblings.filter(
        (x) => !isRunSessionId(x.id) && !isSetupSessionId(x.id),
      );
      const pick = plain.length > 0 ? plain : siblings;
      nextActive = setTerminalSelection(
        nextActive,
        target.folder,
        pick.length > 0 ? pick[pick.length - 1]!.id : null,
      );
    }
    const next = {
      sessions: renumbered,
      activeTerminalTabByFolder: nextActive,
    };
    persistSessions({
      sessions: next.sessions,
      activeTerminalTabByFolder: next.activeTerminalTabByFolder,
    });
    return next;
  });
}

const hydrated = loadPersistedSessions();

export const useTerminalStore = create<TerminalStoreState>((set, get) => ({
  sessions: hydrated.sessions,
  activeTerminalTabByFolder: hydrated.activeTerminalTabByFolder,
  retentionGeneration: 0,

  createSession(folder, agentId, initialCommand, id, activate = true, title) {
    // Reuse an existing session with the given explicit id (the per-folder
    // "run" terminal) — just refocus it instead of spawning a duplicate.
    if (id) {
      const existing = get().sessions.find((sess) => sess.id === id);
      if (existing) {
        set((s) => {
          // Reuse focuses the terminal's sub-tab.
          const activeTerminalTabByFolder = setTerminalSelection(
            s.activeTerminalTabByFolder,
            folder,
            id,
          );
          if (activeTerminalTabByFolder === s.activeTerminalTabByFolder) {
            return s;
          }
          const next = {
            activeTerminalTabByFolder,
          };
          persistSessions({
            sessions: s.sessions,
            activeTerminalTabByFolder: next.activeTerminalTabByFolder,
          });
          return next;
        });
        if (activate) recordWorkspaceActivity(folder);
        return existing;
      }
    }
    const session: TerminalSession = {
      id: id ?? mintSessionId(),
      folder,
      // Placeholder — overwritten by `renumberFolder` below so the
      // returned object reflects the actual stored title. A run terminal
      // (explicit title / initialCommand / pty-run- id) keeps its name
      // (renumberFolder skips it).
      title:
        title ??
        (initialCommand || (id && isRunSessionId(id)) ? "Run" : "Terminal"),
      createdAt: Date.now(),
      alive: true,
      agentId: agentId ?? null,
      initialCommand,
    };
    set((s) => {
      // A new terminal focuses its terminal panel tab.
      const next = {
        sessions: renumberFolder([...s.sessions, session], folder),
        activeTerminalTabByFolder: activate
          ? setTerminalSelection(
              s.activeTerminalTabByFolder,
              folder,
              session.id,
            )
          : s.activeTerminalTabByFolder,
      };
      persistSessions({
        sessions: next.sessions,
        activeTerminalTabByFolder: next.activeTerminalTabByFolder,
      });
      return next;
    });
    const stored = get().sessions.find((sess) => sess.id === session.id);
    if (activate) recordWorkspaceActivity(folder);
    return stored ?? session;
  },

  syncEngineTerminals(folder, folderTerminals, allEngineIds) {
    set((s) => {
      const engineIds = new Set(allEngineIds.filter(Boolean));
      // sessionId → exited, for this folder's engine terminals (drives `alive`
      // so a natural exit / restart on ANY device propagates to this one).
      const exitedById = new Map(
        folderTerminals.map((t) => [t.sessionId, t.exited === true]),
      );
      const known = new Set(s.sessions.map((x) => x.id));
      // ADD: engine terminals in this folder we don't track yet. An EXITED
      // run terminal is skipped — its registry entry is history (the durable
      // last-run state represents it); re-adding it would mount a dead tab
      // whose attach-only view has nothing to bind to. Live run terminals
      // ARE re-added (a renderer reload walks back into the dev server).
      const additions: TerminalSession[] = folderTerminals
        .filter((t) => t.sessionId && !known.has(t.sessionId))
        .filter((t) => !(isRunSessionId(t.sessionId) && t.exited === true))
        .map((t) => ({
          id: t.sessionId,
          folder,
          // Plain terminals are renumbered below; a run terminal synced from
          // another device keeps "Run" (renumberFolder pins it by id).
          title: isRunSessionId(t.sessionId) ? "Run" : "Terminal",
          createdAt:
            typeof t.createdAt === "number" && t.createdAt > 0
              ? t.createdAt
              : Date.now(),
          // A shell that already exited shows "(exited)"; otherwise it's live.
          alive: t.exited !== true,
          // A shared terminal from the engine is always a plain shell here — the
          // terminal-agent auto-launch is a conversation pane concern, not this panel's.
          agentId: null,
          engineSeen: true,
        }));
      let changed = additions.length > 0;
      // RECONCILE existing sessions in THIS folder against the registry.
      const kept: TerminalSession[] = [];
      for (const sess of s.sessions) {
        if (sess.folder !== folder) {
          kept.push(sess);
          continue;
        }
        if (engineIds.has(sess.id)) {
          // Present in the engine → confirm engineSeen + mirror its exited state
          // (so an exit/restart elsewhere flips this device's "(exited)" badge).
          const reported = exitedById.get(sess.id);
          const nextAlive = reported === undefined ? sess.alive : !reported;
          if (!sess.engineSeen || sess.alive !== nextAlive) {
            kept.push({ ...sess, engineSeen: true, alive: nextAlive });
            changed = true;
          } else {
            kept.push(sess);
          }
        } else if (sess.engineSeen) {
          // Was registered, now GONE → CLOSED on another device. Drop it.
          changed = true;
        } else {
          // Local + not yet registered (its ptyCreate is in flight) → keep.
          kept.push(sess);
        }
      }
      // No net change → return the SAME state so useSyncExternalStore sees an
      // unchanged snapshot and skips a re-render (avoids a fetch→sync→render loop).
      if (!changed) return s;
      const merged = renumberFolder([...kept, ...additions], folder);
      // If terminal panel's active tab named the terminal we removed,
      // repoint it to a sibling. Guard that `active` was actually a tracked
      // terminal: the sub-tab value can also be "setup" (never in `sessions`),
      // which a vanished terminal must not yank away from.
      let activeTerminalTabByFolder = s.activeTerminalTabByFolder;
      const active = s.activeTerminalTabByFolder[folder];
      const activeWasTerminal =
        active != null && s.sessions.some((x) => x.id === active);
      if (activeWasTerminal && !merged.some((m) => m.id === active)) {
        const inFolder = merged.filter((m) => m.folder === folder);
        activeTerminalTabByFolder = setTerminalSelection(
          s.activeTerminalTabByFolder,
          folder,
          inFolder[inFolder.length - 1]?.id ?? null,
        );
      }
      const next = { sessions: merged, activeTerminalTabByFolder };
      persistSessions({
        sessions: next.sessions,
        activeTerminalTabByFolder: next.activeTerminalTabByFolder,
      });
      return next;
    });
  },

  renameSession(id, title) {
    set((s) => {
      const target = s.sessions.find((sess) => sess.id === id);
      // `renamed: true` pins the title against renumberFolder so it survives
      // the next create/delete (and reload).
      const renamed = s.sessions.map((sess) =>
        sess.id === id ? { ...sess, title, renamed: true } : sess,
      );
      // Renumber so a rename to a reserved "Terminal N" name doesn't leave a
      // duplicate — the renamed title becomes reserved and the auto-numbered
      // siblings skip it (the new name wins; a colliding auto sibling shifts).
      const sessions = target
        ? renumberFolder(renamed, target.folder)
        : renamed;
      persistSessions({
        sessions,
        activeTerminalTabByFolder: s.activeTerminalTabByFolder,
      });
      return { sessions };
    });
  },

  markExited(id) {
    set((s) => {
      const next = {
        sessions: s.sessions.map((sess) =>
          sess.id === id ? { ...sess, alive: false } : sess,
        ),
      };
      persistSessions({
        sessions: next.sessions,
        activeTerminalTabByFolder: s.activeTerminalTabByFolder,
      });
      return next;
    });
  },

  // Inverse of markExited — clears the "(exited)" tab badge when a
  // dead session is restarted in place (TerminalSessionView respawns
  // the PTY under the same id after the user presses a key on an
  // exited terminal). No-ops for ids the store doesn't track (e.g.
  // conversation pane terminal-agent tabs, which live in the workspace store).
  markAlive(id) {
    set((s) => {
      const next = {
        sessions: s.sessions.map((sess) =>
          sess.id === id ? { ...sess, alive: true } : sess,
        ),
      };
      persistSessions({
        sessions: next.sessions,
        activeTerminalTabByFolder: s.activeTerminalTabByFolder,
      });
      return next;
    });
  },

  closeSession(id) {
    closeSessionImpl(set, get, id, false);
  },

  forceCloseSession(id) {
    closeSessionImpl(set, get, id, true);
  },

  setActiveTerminalTab(folder, id) {
    set((s) => {
      const activeTerminalTabByFolder = setTerminalSelection(
        s.activeTerminalTabByFolder,
        folder,
        id,
      );
      if (activeTerminalTabByFolder === s.activeTerminalTabByFolder) return s;
      const next = {
        activeTerminalTabByFolder,
      };
      persistSessions({
        sessions: s.sessions,
        activeTerminalTabByFolder: next.activeTerminalTabByFolder,
      });
      return next;
    });
  },
}));

/** Remove terminal sessions and selected sub-tabs with deleted workspace
 * owners. Repository deletion already destroys those worktrees, so keeping or
 * reattaching their PTYs would expose dead tabs on a later path reuse. */
export function clearTerminalFolders(
  folders: readonly string[],
  projectId?: string,
): void {
  const removedRoots = [...new Set(folders.filter(Boolean))];
  if (removedRoots.length === 0) return;
  const projects = projectId ? loadProjects() : [];
  const folderWasRemoved = (folder: string) =>
    projectId
      ? folderIsOwnedByProject(folder, projectId, projects, removedRoots)
      : removedRoots.some((root) => folderIsWithinRoot(folder, root));
  const current = useTerminalStore.getState();
  const removedSessions = current.sessions.filter((session) =>
    folderWasRemoved(session.folder),
  );
  for (const session of removedSessions) {
    if (!session.alive) continue;
    void ptyKill({ sessionId: session.id }).catch(() => {
      /* repository/worktree teardown may already have killed the PTY */
    });
  }
  useTerminalStore.setState((state) => {
    const sessions = state.sessions.filter(
      (session) => !folderWasRemoved(session.folder),
    );
    const activeTerminalTabByFolder = Object.fromEntries(
      Object.entries(state.activeTerminalTabByFolder).filter(
        ([folder]) => !folderWasRemoved(folder),
      ),
    );
    if (
      sessions.length === state.sessions.length &&
      Object.keys(activeTerminalTabByFolder).length ===
        Object.keys(state.activeTerminalTabByFolder).length
    ) {
      return { retentionGeneration: state.retentionGeneration + 1 };
    }
    persistSessions({ sessions, activeTerminalTabByFolder });
    return {
      sessions,
      activeTerminalTabByFolder,
      retentionGeneration: state.retentionGeneration + 1,
    };
  });
}

/** Select sessions scoped to a given folder, ordered by createdAt. */
export function selectSessionsForFolder(
  state: TerminalStoreState,
  folder: string,
): TerminalSession[] {
  return state.sessions
    .filter((s) => s.folder === folder)
    .sort((a, b) => a.createdAt - b.createdAt);
}

// ──────────────────────────────────────────────────────────
// PTY event router — one listener per event, dispatched by sessionId.
//
// A listener per `TerminalSessionView` mount would register its own
// `nativeListen("pty-data")` handler and filter on sessionId
// in JS. The preload fans every event to every subscriber, so with N
// open terminals each PTY byte triggered N callbacks — quadratic in
// tab count.
//
// Now: the store installs exactly one `pty-data` and one `pty-exit`
// listener on first bind. Session views register a per-id callback
// via `bindWriter` / `bindExitHandler`. Dispatch is a single Map
// lookup; unknown ids no-op.
// ──────────────────────────────────────────────────────────

// One sessionId can be mounted by MORE THAN ONE TerminalSessionView at
// once. The clearest case: a conversation pane terminal-agent chat whose PTY the
// engine also publishes in the shared registry (handlePtyCreate adds every
// non-ephemeral session), so the workbench terminal panel — when open on the
// same folder — mounts a SECOND view for the same shell. Both views must
// render the live stream, so each id maps to a SET of consumers and the
// router fans every event out to all of them.
//
// The previous single-entry Map (`writers.set(id, fn)`) silently dropped
// all but the most-recently-bound view: the user typed into the visible
// conversation pane terminal but the PTY echo rendered only in the hidden workbench copy,
// so the terminal looked frozen — the "can't type in the 2nd-column
// terminal" bug. A Set keyed by id fixes it without having to prevent the
// (intentional, multiplayer) double-mount.
const writers = new Map<string, Set<(data: string) => void>>();
const exitHandlers = new Map<string, Set<(evt: PtyExitEvent) => void>>();
let routerInstalled = false;

function installPtyRouter(): void {
  if (routerInstalled) return;
  routerInstalled = true;
  void onPtyData((evt) => {
    const fns = writers.get(evt.sessionId);
    if (!fns) return;
    // Snapshot before iterating: a consumer's xterm.write can synchronously
    // drive a React effect that binds/unbinds and mutates the set.
    for (const fn of [...fns]) fn(evt.data);
  });
  void onPtyExit((evt) => {
    const fns = exitHandlers.get(evt.sessionId);
    if (!fns) return;
    for (const fn of [...fns]) fn(evt);
  });
}

/** Register a `pty-data` consumer for one session. Multiple consumers may
 *  bind the same id (see the registry note above) and each receives every
 *  byte. Returns an unbind callback — call it from the consumer's cleanup so
 *  a re-mount doesn't accumulate stale handlers. */
export function bindPtyWriter(
  sessionId: string,
  fn: (data: string) => void,
): () => void {
  installPtyRouter();
  let set = writers.get(sessionId);
  if (!set) {
    set = new Set();
    writers.set(sessionId, set);
  }
  set.add(fn);
  return () => {
    const s = writers.get(sessionId);
    if (!s) return;
    s.delete(fn);
    if (s.size === 0) writers.delete(sessionId);
  };
}

/** Register a `pty-exit` consumer for one session. Same multi-consumer
 *  contract as `bindPtyWriter`. */
export function bindPtyExitHandler(
  sessionId: string,
  fn: (evt: PtyExitEvent) => void,
): () => void {
  installPtyRouter();
  let set = exitHandlers.get(sessionId);
  if (!set) {
    set = new Set();
    exitHandlers.set(sessionId, set);
  }
  set.add(fn);
  return () => {
    const s = exitHandlers.get(sessionId);
    if (!s) return;
    s.delete(fn);
    if (s.size === 0) exitHandlers.delete(sessionId);
  };
}
