// Main-process side of the Design recorder (design-recorder-host.ts): starts
// the recorder process on first use, stops it when idle, and checks that each
// recording it names is a layer file inside its own private folder.
//
// Available only when explicitly enabled (ZEROS_DESIGN_RECORDER=1) in an
// unpackaged build while the recorded canvas is an internal experiment: the
// recorder runs unsandboxed renderers (see the host), which ships only once
// approved. A packaged app also needs a role switch in main to start it.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DESIGN_BATCH_CAPTURE_TIMEOUT_MS,
  DESIGN_RECORDER_FOLDER_PREFIX,
  type DesignBatchRecordReply,
  type DesignBatchRecordRequest,
} from "@zeros/protocol/design-capture";
import type { DesignBatchRecordHost } from "../src/engine/design/capture-service";

export const DESIGN_RECORDER_IDLE_MS = 30_000;
const HANDSHAKE_MS = 20_000;
const MAX_REPLY_BYTES = 4 * 1024 * 1024;
/** What the recorder process may inherit: no credential or service bearer. */
const INHERITED_ENV = ["HOME", "PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "USER", "LOGNAME", "SHELL",
  "__CF_USER_TEXT_ENCODING", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "SYSTEMROOT"] as const;

export function designRecorderEnvironment(source: NodeJS.ProcessEnv, token: string, identity: string, windows?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of INHERITED_ENV) if (source[key] !== undefined) env[key] = source[key];
  env.ZEROS_DESIGN_RECORDER_TOKEN = token;
  env.ZEROS_DESIGN_RECORDER_IDENTITY = identity;
  if (windows) env.ZEROS_DESIGN_RECORDER_WINDOWS = windows;
  // Diagnostics only: where the recorder logs per-frame step durations.
  if (source.ZEROS_DESIGN_RECORDER_TIMINGS) env.ZEROS_DESIGN_RECORDER_TIMINGS = source.ZEROS_DESIGN_RECORDER_TIMINGS;
  return env;
}

/** A file the recorder named, a layer picture or a typeface's font data,
 * must sit inside its own folder. */
export async function assertRecorderLayerPath(root: string, file: string, name: RegExp = /^layer_\d+\.skp$/): Promise<void> {
  const outside = new Error("The recorder named a recording outside its folder.");
  const [base, resolved] = await Promise.all([realpath(root), realpath(file)]).catch(() => { throw outside; });
  const relative = path.relative(base, resolved);
  if (!path.basename(base).startsWith(DESIGN_RECORDER_FOLDER_PREFIX) || relative.startsWith("..") || path.isAbsolute(relative) ||
    !name.test(path.basename(resolved)))
    throw outside;
}

export interface DesignRecorder {
  readonly identity: string;
  readonly record: DesignBatchRecordHost;
  stop(): Promise<void>;
}

export function createDesignRecorder(options: {
  identity: string;
  /** The recorder host bundle. */
  entry: string;
  execPath?: string;
  idleMs?: number;
  env?: NodeJS.ProcessEnv;
  spawnImpl?: typeof spawn;
  fetchImpl?: typeof fetch;
}): DesignRecorder {
  const idleMs = options.idleMs ?? DESIGN_RECORDER_IDLE_MS;
  const run = options.spawnImpl ?? spawn;
  const fetchImpl = options.fetchImpl ?? fetch;
  let child: ChildProcess | null = null;
  let ready: Promise<{ url: string; root: string; token: string }> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let profile: string | null = null;

  const retire = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    const current = child;
    child = null;
    ready = null;
    if (current && current.exitCode === null) {
      current.stdin?.end();
      const kill = setTimeout(() => current.kill("SIGKILL"), 5_000);
      kill.unref?.();
      current.once("exit", () => clearTimeout(kill));
    }
    if (profile) { void rm(profile, { recursive: true, force: true }); profile = null; }
  };
  const start = () => {
    const token = randomBytes(32).toString("hex");
    profile = path.join(os.tmpdir(), `zeros-design-recorder-profile-${randomBytes(8).toString("hex")}`);
    const spawned = run(options.execPath ?? process.execPath, [options.entry, `--user-data-dir=${profile}`], {
      env: designRecorderEnvironment(options.env ?? process.env, token, options.identity, process.env.ZEROS_DESIGN_RECORDER_WINDOWS),
      stdio: ["pipe", "pipe", "ignore"],
    });
    child = spawned;
    return new Promise<{ url: string; root: string; token: string }>((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => { reject(new Error("The Design recorder did not start.")); retire(); }, HANDSHAKE_MS);
      spawned.stdout?.setEncoding("utf8");
      spawned.stdout?.on("data", (text: string) => {
        buffer += text;
        const line = buffer.split("\n").find((entry) => entry.startsWith("ZEROS_DESIGN_RECORDER "));
        if (!line) { if (buffer.length > 64 * 1024) buffer = buffer.slice(-1024); return; }
        clearTimeout(timer);
        try {
          const value = JSON.parse(line.slice("ZEROS_DESIGN_RECORDER ".length)) as { url?: unknown; root?: unknown };
          const url = typeof value.url === "string" ? new URL(value.url) : null;
          if (!url || url.protocol !== "http:" || url.hostname !== "127.0.0.1" || typeof value.root !== "string" ||
            !path.basename(value.root).startsWith(DESIGN_RECORDER_FOLDER_PREFIX))
            throw new Error("The Design recorder announced an invalid address.");
          resolve({ url: url.origin, root: value.root, token });
        } catch (error) {
          reject(error);
          retire();
        }
      });
      spawned.once("error", (error) => { clearTimeout(timer); reject(error); if (child === spawned) retire(); });
      spawned.once("exit", () => { clearTimeout(timer); reject(new Error("The Design recorder exited.")); if (child === spawned) { child = null; ready = null; } });
    });
  };
  const record: DesignBatchRecordHost = async (input: DesignBatchRecordRequest, signal: AbortSignal) => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    ready ??= start();
    try {
      const host = await ready;
      const response = await fetchImpl(`${host.url}/record`, {
        method: "POST",
        headers: { Authorization: `Bearer ${host.token}`, "Content-Type": "application/json" },
        redirect: "error",
        body: JSON.stringify(input),
        signal: AbortSignal.any([signal, AbortSignal.timeout(DESIGN_BATCH_CAPTURE_TIMEOUT_MS + 5_000)]),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(response.status === 429 ? "The Design recorder is busy." : "The Design recorder could not record these frames.");
      }
      const text = await response.text();
      if (text.length > MAX_REPLY_BYTES) throw new Error("The Design recorder returned too much data.");
      const reply = JSON.parse(text) as { items?: DesignBatchRecordReply["items"] };
      const items: DesignBatchRecordReply["items"] = [];
      for (const item of Array.isArray(reply.items) ? reply.items : []) {
        if (item && "layers" in item && Array.isArray(item.layers)) {
          try {
            for (const layer of item.layers) {
              await assertRecorderLayerPath(host.root, layer.path);
              for (const typeface of layer.typefaces ?? []) await assertRecorderLayerPath(host.root, typeface.path, /^[a-f0-9]{32}\.font$/);
            }
            items.push(item);
          } catch (error) {
            items.push({ id: item.id, error: (error as Error).message });
          }
        } else if (item) items.push(item);
      }
      return { recorder: options.identity, items };
    } finally {
      if (child) { idleTimer = setTimeout(retire, idleMs); idleTimer.unref?.(); }
    }
  };
  return { identity: options.identity, record, async stop() { retire(); } };
}

/** Whether this launch may start the recorder: explicitly enabled, and an
 * unpackaged build, where the recorder bundle runs as its own app. */
export function designRecorderEnabled(env: NodeJS.ProcessEnv, packaged: boolean): boolean {
  return env.ZEROS_DESIGN_RECORDER === "1" && !packaged;
}
