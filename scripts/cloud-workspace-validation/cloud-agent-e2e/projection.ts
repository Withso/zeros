import { cpSync, readFileSync, realpathSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { HarnessFailure } from "./assertions";

/** Snapshot a public installed tool before the private etc overlay hides its
 * alternatives link. Caller writes only inside its guarded private OS view. */
export function snapshotSystemExecutable(file: string): Buffer {
  const canonical = realpathSync(file), metadata = statSync(canonical);
  if (!metadata.isFile() || !(metadata.mode & 0o111) || metadata.size > 1024 * 1024)
    throw new HarnessFailure("fixture_contract_invalid");
  return readFileSync(canonical);
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
