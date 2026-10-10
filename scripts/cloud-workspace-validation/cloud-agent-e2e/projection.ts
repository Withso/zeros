import { closeSync, constants, cpSync, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { HarnessFailure } from "./assertions";

/** One non-root identity shared by the engine and its owned work. */
export const FIXTURE_ENGINE_ID_MAP = Object.freeze([
  Object.freeze([10003, 10003, 1] as const),
] as const);
const EMPTY_CAPABILITIES = Object.freeze({ inheritable: 0, permitted: 0, effective: 0, bounding: 0, ambient: 0 } as const);

export interface FixtureEngineIdentity {
  readonly identityObserved: true;
  /** IDs observed from this fixture's parent (VM) view, not inside the engine. */
  readonly engineUid: 10003;
  readonly engineGid: 10003;
  readonly uidMap: typeof FIXTURE_ENGINE_ID_MAP;
  readonly gidMap: typeof FIXTURE_ENGINE_ID_MAP;
  readonly capabilities: typeof EMPTY_CAPABILITIES;
  readonly noNewPrivileges: true;
  readonly seccomp: 2;
}

/** Require numeric kernel observations; archived root/worker maps remain
 * readable in old evidence but cannot qualify the current runtime. */
export function requireFixtureEngineIdentity(value: unknown): FixtureEngineIdentity {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new HarnessFailure("engine_identity_missing");
  const observed = value as Record<string, unknown>;
  const exactMap = (input: unknown) => Array.isArray(input) && input.length === FIXTURE_ENGINE_ID_MAP.length &&
    FIXTURE_ENGINE_ID_MAP.every((row, index) => Array.isArray(input[index]) && input[index].length === row.length &&
      row.every((id, column) => input[index][column] === id));
  if (observed.identityObserved !== true || observed.engineUid !== 10003 || observed.engineGid !== 10003 ||
    !exactMap(observed.uidMap) || !exactMap(observed.gidMap) ||
    observed.capabilities === null || typeof observed.capabilities !== "object" || Array.isArray(observed.capabilities) ||
    !Object.keys(EMPTY_CAPABILITIES).every(name => (observed.capabilities as Record<string, unknown>)[name] === 0) ||
    observed.noNewPrivileges !== true || observed.seccomp !== 2)
    throw new HarnessFailure("engine_identity_missing");
  return Object.freeze({ identityObserved: true, engineUid: 10003, engineGid: 10003,
    uidMap: FIXTURE_ENGINE_ID_MAP, gidMap: FIXTURE_ENGINE_ID_MAP,
    capabilities: EMPTY_CAPABILITIES, noNewPrivileges: true, seccomp: 2 });
}

/** Snapshot a public installed tool before the private etc overlay hides its
 * alternatives link. Caller writes only inside its guarded private OS view. */
export function snapshotSystemExecutable(file: string): Buffer {
  // Check and read through one descriptor so the file cannot change between them.
  const fd = openSync(realpathSync(file), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = fstatSync(fd);
    if (!metadata.isFile() || !(metadata.mode & 0o111) || metadata.size > 1024 * 1024)
      throw new HarnessFailure("fixture_contract_invalid");
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Caller must first guard its private mount namespace and fresh fixture root. */
export function copyRuntimeFixture(source: string, target: string): void {
  // Relative pnpm links must resolve inside the new R, never the original
  // sandbox tree that the real engine view intentionally does not expose.
  cpSync(source, target, { recursive: true, dereference: false, verbatimSymlinks: true });
}

/** Only a new disposable fixture checkout, never the working source repo. */
export function initializeFixtureCheckout(directory: string,
  execute: (args: string[]) => void = args => { execFileSync("/usr/bin/git", args, { stdio: "pipe" }); }): void {
  const git = (args: string[]) => execute(["-C", directory, "-c", "init.templateDir=", "-c", "user.name=Source Fixture",
    "-c", "user.email=source-fixture@example.invalid", "-c", "commit.gpgSign=false", ...args]);
  git(["init", "-b", "main"]);
  git(["add", "--", "tool-input.txt"]);
  git(["commit", "-m", "Initialize disposable fixture"]);
  // A real cloud primary workspace requires origin metadata to derive its
  // stable slug. This reserved domain is never fetched by fixture setup.
  git(["remote", "add", "origin", "https://source-fixture.invalid/fixture/repo.git"]);
}
