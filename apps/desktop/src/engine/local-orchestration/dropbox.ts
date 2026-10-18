// ──────────────────────────────────────────────────────────
// Local orchestration — the drop folder a sandboxed shell can reach
// ──────────────────────────────────────────────────────────
//
// A provider shell sandbox (Codex workspace-write, or any shell without
// network) refuses the CLI's loopback connection, so the agent's first
// `zeros local …` used to fail and only an escalated retry worked. The same
// sandboxes still let the shell write under $TMPDIR, which a Local agent
// process inherits from the engine. Admission gives each execution a private
// folder there (0700, removed on dispose), and the CLI falls back to it only
// when loopback is denied:
//
//   CLI writes  <id>.req.tmp → renames to <id>.req   ({ protocol, token, body })
//   engine      renames <id>.req → <id>.work (claim), runs the call,
//               writes an exclusive random temporary → <id>.res (the envelope)
//   CLI reads   <id>.res and removes it
//
// The bearer is checked exactly like the HTTP endpoint's and must belong to
// the folder's own execution. Only fixed names are read; nothing in a request
// is echoed back. The engine never follows links out of the folder.
// ──────────────────────────────────────────────────────────

import { createHash, randomUUID } from "node:crypto";
import { constants, watch, type FSWatcher, type Stats } from "node:fs";
import { mkdir, mkdtemp, open, readdir, realpath, rename, rmdir, unlink } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  LOCAL_MAX_REQUEST_BYTES,
  LOCAL_ORCHESTRATION_PROTOCOL,
  localFail,
  type LocalEnvelope,
} from "@zeros/protocol/local-orchestration";
import type { LocalCallHandler, LocalCapabilityRegistry } from "./server";
import type { LocalCallerScope } from "./types";
import { LOCAL_READ_FLAGS, openLocalDirectory, readLocalText, type LocalDirectory } from "./filesystem";

export const LOCAL_DROPBOX_REQUEST = ".req";
export const LOCAL_DROPBOX_RESPONSE = ".res";
/** A request id the CLI chose: 24 lowercase hex characters. */
export const LOCAL_DROPBOX_ID = /^[a-f0-9]{24}$/;

const SWEEP_MS = 100;
const MAX_IDLE_SWEEP_MS = 2_000;
const MAX_ACTIVE_PER_BOX = 16;
/** A response the CLI never collected (it timed out) is cleared after this. */
const ORPHAN_MS = 10 * 60_000;

export interface LocalDropboxHandle {
  dir: string;
  close(): Promise<void>;
}

interface Box {
  dir: string;
  directory: LocalDirectory;
  identity: Stats;
  scope: LocalCallerScope;
  active: Map<string, Promise<void>>;
  closed: boolean;
  controller: AbortController;
  watcher: FSWatcher | null;
  timer: ReturnType<typeof setTimeout> | null;
  sweepDelayMs: number;
  orphanTimer: ReturnType<typeof setTimeout> | null;
  sweeping: Promise<void> | null;
  dirty: boolean;
  responses: Map<string, number>;
}

export class LocalDropbox {
  private readonly boxes = new Set<Box>();

  constructor(
    private readonly registry: LocalCapabilityRegistry,
    private readonly handler: LocalCallHandler,
    private readonly engineId: () => string,
    private readonly options: { root?: string; sweepMs?: number } = {},
  ) {}

  /** The engine-wide parent: under the engine's own $TMPDIR, which a Local
   * provider shell inherits and its sandbox may write. */
  private root(): string {
    if (this.options.root) return this.options.root;
    const tag = createHash("sha256").update(this.engineId()).digest("hex").slice(0, 12);
    return path.join(os.tmpdir(), `zeros-local-${tag}`);
  }

  async open(scope: LocalCallerScope): Promise<LocalDropboxHandle> {
    const configured = path.resolve(this.root());
    // Resolve the trusted temp parent once (macOS /var and /tmp are aliases).
    // The engine's root and every agent-writable component must not be links.
    const parentPath = await realpath(path.dirname(configured));
    const root = path.join(parentPath, path.basename(configured));
    const parent = await openLocalDirectory(parentPath);
    let directory: LocalDirectory;
    let dir: string;
    try {
      await mkdir(path.join(parent.path, path.basename(root)), { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      const rootDirectory = await openLocalDirectory(root);
      try {
        // mkdtemp creates mode 0700; a later pathname chmod could follow a link.
        const temporary = await mkdtemp(path.join(rootDirectory.path, "x-"));
        dir = path.join(root, path.basename(temporary));
        try {
          directory = await openLocalDirectory(dir);
        } catch (error) {
          await rmdir(temporary).catch(() => {});
          throw error;
        }
      } finally {
        await rootDirectory.handle.close();
      }
    } finally {
      await parent.handle.close();
    }
    const box: Box = {
      dir,
      directory,
      identity: await directory.handle.stat(),
      scope,
      active: new Map(),
      closed: false,
      controller: new AbortController(),
      watcher: null,
      timer: null,
      sweepDelayMs: this.options.sweepMs ?? SWEEP_MS,
      orphanTimer: null,
      sweeping: null,
      dirty: false,
      responses: new Map(),
    };
    try {
      box.watcher = watch(directory.path, () => {
        this.scheduleSafetySweep(box, true);
        this.requestSweep(box);
      });
      box.watcher.on("error", () => {
        box.watcher?.close();
        box.watcher = null;
        this.scheduleSafetySweep(box, true);
      });
    } catch {
      box.watcher = null;
      this.scheduleSafetySweep(box, true);
    }
    this.boxes.add(box);
    // Close the watch-installation race before exposing the folder to a CLI.
    await this.sweep(box);
    this.scheduleSafetySweep(box);
    return { dir, close: () => this.close(box) };
  }

  /** A watcher can arm without delivering events in the packaged runtime.
   * Keep a safety read, backing off only while notifications appear available;
   * activity or an explicit watcher failure restores the fast cadence. */
  private scheduleSafetySweep(box: Box, reset = false): void {
    if (box.closed) return;
    if (reset) {
      box.sweepDelayMs = this.options.sweepMs ?? SWEEP_MS;
      if (box.timer) clearTimeout(box.timer);
      box.timer = null;
    }
    if (box.timer) return;
    box.timer = setTimeout(() => {
      box.timer = null;
      box.sweepDelayMs = box.watcher
        ? Math.min(box.sweepDelayMs * 2, MAX_IDLE_SWEEP_MS)
        : this.options.sweepMs ?? SWEEP_MS;
      this.requestSweep(box);
    }, box.sweepDelayMs);
    box.timer.unref?.();
  }

  private requestSweep(box: Box): void {
    if (box.closed) return;
    box.dirty = true;
    if (box.sweeping) return;
    box.sweeping = Promise.resolve().then(async () => {
      do {
        box.dirty = false;
        await this.sweep(box);
      } while (box.dirty && !box.closed);
    }).catch(() => {
      // An unavailable directory is not an engine failure. The next event or
      // fallback read revalidates its identity before touching any request.
    }).finally(() => {
      box.sweeping = null;
      if (box.dirty) this.requestSweep(box);
      this.scheduleOrphanSweep(box);
      this.scheduleSafetySweep(box);
    });
  }

  private scheduleOrphanSweep(box: Box): void {
    if (box.orphanTimer) clearTimeout(box.orphanTimer);
    box.orphanTimer = null;
    if (box.closed || box.responses.size === 0) return;
    let oldest = Infinity;
    for (const at of box.responses.values()) oldest = Math.min(oldest, at);
    box.orphanTimer = setTimeout(() => {
      box.orphanTimer = null;
      this.requestSweep(box);
    }, Math.max(1_000, oldest + ORPHAN_MS + 1 - Date.now()));
    box.orphanTimer.unref?.();
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.boxes].map((box) => this.close(box)));
  }

  private async close(box: Box): Promise<void> {
    if (box.closed) return;
    box.closed = true;
    this.boxes.delete(box);
    box.controller.abort();
    box.watcher?.close();
    if (box.timer) clearTimeout(box.timer);
    if (box.orphanTimer) clearTimeout(box.orphanTimer);
    box.responses.clear();
    try {
      // The protocol owns flat files only. Never recurse through a directory
      // an agent may have replaced with a link while cleanup is in flight.
      for (const name of await readdir(box.directory.path)) {
        await unlink(path.join(box.directory.path, name)).catch(() => {});
      }
    } catch {
      /* A removed or redirected directory needs no pathname cleanup. */
    } finally {
      await box.directory.handle.close();
    }
    const parent = await openLocalDirectory(path.dirname(box.dir)).catch(() => null);
    if (parent) {
      try {
        await rmdir(path.join(parent.path, path.basename(box.dir))).catch(() => {});
      } finally {
        await parent.handle.close();
      }
    }
  }

  /** Each operation owns its descriptor until it finishes, even if close()
   * retires the box while its handler awaits a provider. */
  private async directoryFor(box: Box): Promise<LocalDirectory | null> {
    const directory = await openLocalDirectory(box.dir).catch(() => null);
    if (!directory) return null;
    try {
      const current = await directory.handle.stat();
      if (!box.closed && current.dev === box.identity.dev && current.ino === box.identity.ino) return directory;
    } catch {
      /* A disappearing directory is no longer this execution's transport. */
    }
    await directory.handle.close();
    return null;
  }

  private async sweep(box: Box): Promise<void> {
    if (box.closed) return;
    const directory = await this.directoryFor(box);
    if (!directory) {
      box.responses.clear();
      return;
    }
    try {
      const priorResponses = new Map(box.responses);
      const names = await readdir(directory.path);
      const present = new Set(names);
      // Completed CLI exchanges remove their response immediately. Keep only
      // receipts for files still awaiting collection, without dropping one
      // published after this directory read began.
      for (const [id, at] of priorResponses) {
        if (!present.has(id + LOCAL_DROPBOX_RESPONSE) && box.responses.get(id) === at) box.responses.delete(id);
      }
      const now = Date.now();
      for (const name of names) {
        if (box.closed) return;
        if (name.endsWith(LOCAL_DROPBOX_RESPONSE)) {
          const id = name.slice(0, -LOCAL_DROPBOX_RESPONSE.length);
          const at = box.responses.get(id) ?? now;
          if (now - at > ORPHAN_MS) {
            box.responses.delete(id);
            await unlink(path.join(directory.path, name)).catch(() => {});
          }
          continue;
        }
        if (!name.endsWith(LOCAL_DROPBOX_REQUEST)) continue;
        const id = name.slice(0, -LOCAL_DROPBOX_REQUEST.length);
        if (!LOCAL_DROPBOX_ID.test(id) || box.active.has(id)) continue;
        this.scheduleSafetySweep(box, true);
        // Drain this directory listing as capacity becomes available. Retrying
        // the entire listing after every completion would spin forever on a
        // request the filesystem refuses to claim.
        while (!box.closed && box.active.size >= MAX_ACTIVE_PER_BOX) {
          await Promise.race(box.active.values());
        }
        if (box.closed || box.active.has(id)) continue;
        const serving = this.serve(box, id).catch(() => {
          // A disappearing directory is retried only on a new observation.
        }).finally(() => box.active.delete(id));
        box.active.set(id, serving);
      }
    } catch {
      /* A removed or redirected directory has no readable requests. */
    } finally {
      await directory.handle.close();
    }
  }

  private async serve(box: Box, id: string): Promise<void> {
    const directory = await this.directoryFor(box);
    if (!directory) return;
    try {
      await this.serveIn(box, id, directory.path);
    } finally {
      await directory.handle.close();
    }
  }

  private async serveIn(box: Box, id: string, directory: string): Promise<void> {
    const request = path.join(directory, id + LOCAL_DROPBOX_REQUEST);
    const work = path.join(directory, `${id}.work`);
    // The claim: whoever renames first owns it (the CLI withdraws the same way).
    try {
      await rename(request, work);
    } catch {
      return;
    }
    const meta = { engine: this.engineId() };
    let envelope: LocalEnvelope;
    try {
      envelope = await this.call(box, work, meta);
    } catch {
      envelope = {
        ok: false,
        protocol: LOCAL_ORCHESTRATION_PROTOCOL,
        error: { code: "INTERNAL", message: "Zeros could not complete the command.", retryable: false },
        meta,
      };
    } finally {
      await unlink(work).catch(() => {});
    }
    if (box.closed) return;
    const temporary = path.join(directory, `${id}.${randomUUID()}.res.tmp`);
    let created = false;
    try {
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      created = true;
      try {
        await handle.writeFile(JSON.stringify(envelope));
      } finally {
        await handle.close();
      }
      if (box.closed) return;
      await rename(temporary, path.join(directory, id + LOCAL_DROPBOX_RESPONSE));
      box.responses.set(id, Date.now());
      this.scheduleOrphanSweep(box);
    } catch {
      /* Publication cannot follow agent-created files or redirected parents. */
    } finally {
      if (created) await unlink(temporary).catch(() => {});
    }
  }

  private async call(box: Box, work: string, meta: { engine: string }): Promise<LocalEnvelope> {
    let parsed: unknown;
    const handle = await open(work, LOCAL_READ_FLAGS);
    try {
      const info = await handle.stat();
      const limit = LOCAL_MAX_REQUEST_BYTES + 64 * 1024;
      if (!info.isFile() || info.size > limit) return localFail("USAGE", "Request is too large.", { meta });
      const contents = await readLocalText(handle, limit);
      if (contents === null) return localFail("USAGE", "Request is too large.", { meta });
      parsed = JSON.parse(contents);
    } catch {
      return localFail("USAGE", "Request body is not JSON.", { meta });
    } finally {
      await handle.close();
    }
    const record = typeof parsed === "object" && parsed !== null ? (parsed as { token?: unknown; body?: unknown }) : {};
    const scope = this.registry.resolve(typeof record.token === "string" ? record.token : null);
    if (!scope || scope.executionId !== box.scope.executionId || scope.chatId !== box.scope.chatId) {
      return localFail(
        "NO_CAPABILITY",
        "This Zeros Local CLI access is not valid any more. It works only inside a running Zeros Local agent chat.",
        { meta },
      );
    }
    return this.handler({ ...scope, surface: "cli" }, record.body, box.controller.signal);
  }
}
