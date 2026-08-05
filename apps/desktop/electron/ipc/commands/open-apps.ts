// ──────────────────────────────────────────────────────────
// IPC commands: "Open in…" — installed-app detection + launch
// ──────────────────────────────────────────────────────────
//
//   detect_open_apps — probe this Mac for supported editors and CLI tools,
//                      plus the always-present Finder/Terminal entries,
//                      returning each application with its real native
//                      icon (sips-extracted from the bundle .icns → PNG data
//                      URL — the user's own installed artwork, no vendored
//                      brand marks, and no crashing app.getFileIcon).
//                      The renderer calls this when a workspace is created
//                      (and once on a cold cache) and persists the result.
//   open_in_app      — open a directory as a project in a detected app.
//
// Security posture matches shell.ts: the renderer only ever sends
// an app ID from the fixed OPEN_APPS registry below — never an app path or
// binary. Launch targets are resolved HERE from this process's own probe,
// so a renderer XSS can't use open_in_app to execute arbitrary programs.
// ──────────────────────────────────────────────────────────

import { execFile, spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CommandHandler } from "../router";
import { APPLESCRIPT_ESC } from "./shell";

type OpenAppKind = "system" | "ide" | "cli";

interface OpenAppSpec {
  id: string;
  name: string;
  kind: OpenAppKind;
  /** .app bundle names probed under /Applications + ~/Applications. */
  bundleNames?: string[];
  /** Absolute .app paths probed as-is (system apps live outside /Applications). */
  fixedPaths?: string[];
  /** Spotlight fallback — bundle ids probed via mdfind when no name hit
   *  (covers apps installed to non-standard locations). */
  bundleIds?: string[];
  /** CLI binary name (kind "cli") — probed on PATH + well-known bin dirs.
   *  Launched inside Terminal.app at the target directory. */
  binary?: string;
}

/** Registry order == menu order: Finder first, IDEs in the middle,
 *  Terminal last (the renderer appends its own Copy-path row). */
const OPEN_APPS: OpenAppSpec[] = [
  {
    id: "finder",
    name: "Finder",
    kind: "system",
    fixedPaths: ["/System/Library/CoreServices/Finder.app"],
  },
  {
    id: "cursor",
    name: "Cursor",
    kind: "ide",
    bundleNames: ["Cursor.app"],
    bundleIds: ["com.todesktop.230313mzl4w4u92"],
  },
  {
    id: "vscode",
    name: "VS Code",
    kind: "ide",
    bundleNames: ["Visual Studio Code.app"],
    bundleIds: ["com.microsoft.VSCode"],
  },
  {
    id: "antigravity",
    name: "Antigravity",
    kind: "ide",
    bundleNames: ["Antigravity.app"],
    bundleIds: ["com.google.antigravity"],
  },
  {
    id: "zed",
    name: "Zed",
    kind: "ide",
    bundleNames: ["Zed.app", "Zed Preview.app"],
    bundleIds: ["dev.zed.Zed", "dev.zed.Zed-Preview"],
  },
  {
    id: "xcode",
    name: "Xcode",
    kind: "ide",
    bundleNames: ["Xcode.app", "Xcode-beta.app"],
    bundleIds: ["com.apple.dt.Xcode"],
  },
  {
    id: "devin",
    name: "Devin Desktop",
    kind: "ide",
    bundleNames: ["Devin.app", "Devin Desktop.app"],
    bundleIds: ["ai.cognition.devin", "com.cognition.devin"],
  },
  {
    id: "opencode",
    name: "opencode",
    kind: "cli",
    // A desktop build may exist on some machines; prefer it when present,
    // else fall back to the CLI-in-Terminal launch.
    bundleNames: ["OpenCode.app"],
    binary: "opencode",
  },
  {
    id: "terminal",
    name: "Terminal",
    kind: "system",
    fixedPaths: [
      "/System/Applications/Utilities/Terminal.app",
      "/Applications/Utilities/Terminal.app",
    ],
  },
];

const APP_SEARCH_DIRS = [
  "/Applications",
  path.join(os.homedir(), "Applications"),
];

/** Where agent-manager installers drop CLIs that may not be on this
 *  process's PATH (Electron launched from Dock inherits a minimal env). */
function cliSearchDirs(): string[] {
  const home = os.homedir();
  const known = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(home, ".local/bin"),
    path.join(home, ".opencode/bin"),
    path.join(home, "bin"),
  ];
  const fromPath = (process.env.PATH ?? "").split(":").filter(Boolean);
  return [...new Set([...fromPath, ...known])];
}

/** What a launch resolves to — a .app bundle (GUI) or a CLI binary. */
interface LaunchTarget {
  appPath?: string;
  binPath?: string;
}

/** Last-probe launch targets, keyed by app id. open_in_app resolves from
 *  here (re-probing on a stale entry) so the renderer never supplies paths. */
const launchTargets = new Map<string, LaunchTarget>();

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Spotlight lookup by bundle id. Resolves [] on any failure (Spotlight
 *  disabled, timeout, non-darwin) — detection then just reports "not found". */
function mdfind(bundleId: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      "mdfind",
      [`kMDItemCFBundleIdentifier == '${bundleId}'`],
      { timeout: 2000 },
      (err, stdout) => {
        if (err) return resolve([]);
        resolve(
          stdout
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean),
        );
      },
    );
  });
}

/** Probe one registry entry. Returns the launch target, or null when the
 *  app isn't installed. Never throws. */
async function probeApp(spec: OpenAppSpec): Promise<LaunchTarget | null> {
  for (const fixed of spec.fixedPaths ?? []) {
    if (existsSync(fixed)) return { appPath: fixed };
  }
  for (const dir of APP_SEARCH_DIRS) {
    for (const bundleName of spec.bundleNames ?? []) {
      const candidate = path.join(dir, bundleName);
      if (existsSync(candidate)) return { appPath: candidate };
    }
  }
  if (
    spec.bundleIds &&
    spec.bundleIds.length > 0 &&
    process.platform === "darwin"
  ) {
    const hits = await Promise.all(spec.bundleIds.map(mdfind));
    const appHit = hits
      .flat()
      .find((candidate) => candidate.endsWith(".app") && existsSync(candidate));
    if (appHit) return { appPath: appHit };
  }
  if (spec.binary) {
    for (const dir of cliSearchDirs()) {
      const candidate = path.join(dir, spec.binary);
      if (isFile(candidate)) return { binPath: candidate };
    }
  }
  return null;
}

/** Promisified execFile → stdout, with a tight timeout. Used by the icon
 *  helpers below (plutil/sips); rejects on non-zero exit / timeout. */
function execFileText(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, maxBuffer: 1 << 20 },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout))),
    );
  });
}

/** Locate an .app bundle's .icns icon file. Reads CFBundleIconFile via
 *  `plutil` (which parses BOTH xml and binary Info.plist — system apps like
 *  Finder ship binary plists), then falls back to the AppIcon / <bundle-name>
 *  / first .icns in Contents/Resources. Null when the bundle has none. */
async function resolveIcnsPath(appPath: string): Promise<string | null> {
  const resources = path.join(appPath, "Contents", "Resources");
  try {
    const raw = (
      await execFileText(
        "/usr/bin/plutil",
        [
          "-extract",
          "CFBundleIconFile",
          "raw",
          "-o",
          "-",
          path.join(appPath, "Contents", "Info.plist"),
        ],
        2000,
      )
    ).trim();
    if (raw) {
      const name = raw.toLowerCase().endsWith(".icns") ? raw : `${raw}.icns`;
      const p = path.join(resources, name);
      if (existsSync(p)) return p;
    }
  } catch {
    /* no CFBundleIconFile / unreadable plist — fall back to a directory scan */
  }
  try {
    const icns = readdirSync(resources).filter((f) =>
      f.toLowerCase().endsWith(".icns"),
    );
    const base = `${path.basename(appPath, ".app").toLowerCase()}.icns`;
    const pick =
      icns.find((f) => /appicon/i.test(f)) ??
      icns.find((f) => f.toLowerCase() === base) ??
      icns[0];
    return pick ? path.join(resources, pick) : null;
  } catch {
    return null;
  }
}

/** Monotonic suffix so parallel extractions never collide on the temp PNG. */
let iconTmpSeq = 0;

/** The user's actual installed artwork for an .app bundle, as a 48px PNG
 *  data URL — extracted with macOS `sips` from the bundle's .icns.
 *
 *  Deliberately NOT Electron's `app.getFileIcon`: a historical macOS 26
 *  regression in Electron 33 / Chrome 130 hit a fatal Chromium `NOTREACHED`
 *  (SIGTRAP) for every path. `sips`/`plutil` are plain macOS CLIs, so they can
 *  only ever fail soft. Null on any failure → the renderer falls back to a
 *  bundled/lucide mark. */
async function appIconDataUrl(appPath: string): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  const icns = await resolveIcnsPath(appPath);
  if (!icns) return null;
  const out = path.join(
    os.tmpdir(),
    `zeros-openin-icon-${process.pid}-${iconTmpSeq++}.png`,
  );
  try {
    await execFileText(
      "/usr/bin/sips",
      ["-s", "format", "png", "-Z", "48", icns, "--out", out],
      4000,
    );
    const png = await readFile(out);
    return png.length > 0
      ? `data:image/png;base64,${png.toString("base64")}`
      : null;
  } catch {
    return null;
  } finally {
    void unlink(out).catch(() => {});
  }
}

export interface DetectedOpenApp {
  id: string;
  name: string;
  kind: OpenAppKind;
  iconDataUrl: string | null;
}

/** Probe every registry entry (in parallel) and return the installed ones,
 *  in registry (== menu) order. `system` entries (Finder/Terminal) are
 *  always returned — they exist on every Mac and the menu always shows
 *  them — even if a probe hiccup leaves them icon-less. */
export const detectOpenApps: CommandHandler = async () => {
  if (process.platform !== "darwin") return [];
  const entries = await Promise.all(
    OPEN_APPS.map(async (spec): Promise<DetectedOpenApp | null> => {
      const target = await probeApp(spec);
      if (target) launchTargets.set(spec.id, target);
      if (!target && spec.kind !== "system") return null;
      const iconDataUrl = target?.appPath
        ? await appIconDataUrl(target.appPath)
        : null;
      return { id: spec.id, name: spec.name, kind: spec.kind, iconDataUrl };
    }),
  );
  return entries.filter((entry): entry is DetectedOpenApp => entry !== null);
};

/** POSIX single-quote so the path survives the Terminal shell verbatim. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** `open -a <App> <dir>` — hands the folder to the app as an open-file
 *  event (all the GUI IDEs treat a directory as "open as project").
 *  Waits for `open` to exit so a refusal surfaces as a real error. */
function openViaOpen(appPath: string, dir: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("open", ["-a", appPath, dir], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `open exited with code ${code}`));
    });
  });
}

/** CLI launch: a real Terminal window cd'd into the worktree and running the
 *  detected binary by absolute path — the same osascript route as
 *  shell.ts openInstallTerminal, so the user's login-shell env applies. */
function openCliInTerminal(binPath: string, dir: string): Promise<void> {
  const line = `cd ${shellQuote(dir)} && ${shellQuote(binPath)}`;
  const script = `tell application "Terminal"
    activate
    do script "${APPLESCRIPT_ESC(line)}"
end tell`;
  return new Promise<void>((resolve, reject) => {
    const child = spawn("osascript", ["-e", script], {
      stdio: "ignore",
      detached: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

/** Open a directory in a detected IDE. Finder/Terminal deliberately NOT
 *  routed here — the renderer keeps using reveal_in_finder /
 *  open_in_terminal for those, so this command's reachable surface stays
 *  "launch a registry IDE" and nothing else. */
export const openInApp: CommandHandler = async (args) => {
  const appId = typeof args.appId === "string" ? args.appId : "";
  const dir = typeof args.path === "string" ? args.path : "";
  if (!dir) throw new Error("open_in_app: missing path");
  if (!existsSync(dir)) throw new Error(`path does not exist: ${dir}`);
  if (!statSync(dir).isDirectory()) throw new Error(`not a directory: ${dir}`);

  const spec = OPEN_APPS.find((s) => s.id === appId && s.kind !== "system");
  if (!spec) throw new Error(`open_in_app: unknown app '${appId}'`);

  // Resolve from our own probe cache; re-probe when the cached target is
  // stale (app moved/uninstalled since detection) so a reinstall Just Works.
  let target = launchTargets.get(spec.id) ?? null;
  const targetPath = target?.appPath ?? target?.binPath;
  if (!target || !targetPath || !existsSync(targetPath)) {
    target = await probeApp(spec);
    if (target) launchTargets.set(spec.id, target);
  }
  if (!target) throw new Error(`${spec.name} doesn't appear to be installed`);

  if (target.appPath) return openViaOpen(target.appPath, dir);
  if (target.binPath) return openCliInTerminal(target.binPath, dir);
  throw new Error(`${spec.name} doesn't appear to be installed`);
};
