#!/usr/bin/env node
// ──────────────────────────────────────────────────────────
// check-runtime-pins — prove a FORWARD bundled-runtime bump is safe
// ──────────────────────────────────────────────────────────
//
// The three bundled agent runtimes are shipped artifacts, not ordinary
// libraries: @anthropic-ai/claude-agent-sdk carries the actual claude-code
// executable, @openai/codex the codex one, @cursor/sdk the entire Cursor
// backend. Renovate's weekly "agent CLIs" PR is the only thing that moves
// them, and it only ever moves them FORWARD.
//
// WHY THIS EXISTS: every pre-existing gate is blind in exactly that direction.
//   • `models:verify --strict` fails only when the bundled CLI is OLDER than a
//     curated model needs (models-verify.mjs `checkCliVersionGate`). A bump
//     RAISES the version, so `versionGte` is trivially satisfied and the check
//     is green by construction — for the one direction Renovate ever moves.
//   • `test:adapters` replays committed fixtures through unchanged translator
//     source, so its output is identical before and after any version bump.
//   • `check:codex-pin` genuinely does gate Codex. Nothing gated Claude or
//     Cursor at all.
// Net effect before this script: a claude-agent-sdk bump could rename its
// platform package, ship a CLI that no longer matches its own manifest, or
// drop the binary entirely, and preflight stayed green. The first thing to
// notice would be `release-alpha` (post-merge) or the weekly cron — up to
// seven days later, on main.
//
// WHAT IT PROVES — all offline, no secrets, runs on any OS CI:
//   1. EXACT PINS. A range on a shipped executable lets a lockfile refresh
//      swap the binary with no reviewed diff, and silently desyncs the
//      `codexProtocolVersion` triple that check:codex-pin compares by equality.
//   2. DECLARED === INSTALLED for all three.
//   3. THE REAL ARTIFACT. Resolve Claude's platform binary and exec its own
//      `--version`, then assert it equals the SDK's declared claudeCodeVersion.
//      This is the only check in the repo that touches the shipped executable;
//      it catches a renamed/dropped/corrupt platform package at PR time.
//   4. SELF-AGREEMENT. claudeCodeVersion === manifest.json `version`. Four call
//      sites read these two fields in two different precedence orders
//      (registry.ts and sidecar.ts check manifest first, models-verify.mjs
//      checks claudeCodeVersion first) — if they ever disagree, the CI gate and
//      the shipped UI report different versions and both look correct.
//   5. VENDOR COMPAT. The wrapper version against the CLI's own
//      `manifest.sdkCompat.testedWrapperVersions`. Anthropic ships this
//      compatibility list inside the package and nothing here read it.
//
// `--drift` additionally queries the npm registry and reports how far behind
// `latest` each pin is. Network-only and NEVER fails the build — it is the
// staleness signal for the weekly scheduled run, not a merge gate.
//
// NOTE ON READING package.json: these packages ship an `exports` map that does
// NOT expose "./package.json", so `require("<pkg>/package.json")` throws
// ERR_PACKAGE_PATH_NOT_EXPORTED. Every read here goes through the filesystem
// path instead. (check-codex-pin.mjs still uses the require() form; it works
// only because @openai/codex happens to have no exports map today.)
//
// Run: `pnpm check:runtime-pins` — offline gate.
//      `pnpm check:runtime-pins --drift` — + staleness report.
// Exit 0 = every pin is exact, installed, and provable. 1 = it is not.
// ──────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  readClaudeCodeVersion,
  resolveClaudeCliSource,
} from "./stage-claude-cli.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CLAUDE_SDK = "@anthropic-ai/claude-agent-sdk";
const CODEX = "@openai/codex";
const CURSOR_SDK = "@cursor/sdk";
const SANDBOX_RUNTIME = "@anthropic-ai/sandbox-runtime";
// Claude's built-in Write tool began consulting Edit(path) rules at this
// version. The command sandbox alone cannot protect an in-process file tool, so
// this is a release requirement for Zeros' all-tool Design containment claim.
const CLAUDE_DESIGN_CONTAINMENT_MIN_VERSION = "2.1.228";

/** The runtimes this gate owns. Keep in lockstep with renovate.json's
 *  "agent CLIs" packageRule — that rule is what opens the PRs this checks. */
const BUNDLED_RUNTIMES = [CLAUDE_SDK, CODEX, CURSOR_SDK, SANDBOX_RUNTIME];

const errors = [];
const warnings = [];
const notes = [];

const fail = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

// ── helpers ───────────────────────────────────────────────

/** Read an installed package's package.json BY PATH. `require(pkg +
 *  "/package.json")` is not usable here — see the exports-map note above. */
function installedManifest(name) {
  const p = join(ROOT, "node_modules", ...name.split("/"), "package.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    fail(
      `${name}: node_modules copy has unreadable package.json — ${e.message}`,
    );
    return null;
  }
}

/** An exact pin is a bare semver: no ^ ~ > < = || x * or whitespace. Anything
 *  else lets the resolved artifact move without a reviewed diff. */
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function parseVersion(v) {
  return String(v)
    .split("-")[0]
    .split(".")
    .map((n) => Number.parseInt(n, 10) || 0);
}

/** -1 | 0 | 1 — numeric semver compare on the release triple. */
function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

// ── 1 + 2. pins are exact, and match what is installed ────

function checkPins() {
  const rootPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const deps = { ...rootPkg.dependencies, ...rootPkg.devDependencies };
  const resolved = {};

  for (const name of BUNDLED_RUNTIMES) {
    const declared = deps[name];
    if (!declared) {
      fail(
        `${name} is not a dependency of package.json, but renovate.json's ` +
          `"agent CLIs" rule and this gate both expect it. Either add it back ` +
          `or drop it from BUNDLED_RUNTIMES here and from that rule.`,
      );
      continue;
    }

    if (!EXACT.test(declared)) {
      fail(
        `${name} is pinned as "${declared}" — bundled runtimes must be pinned ` +
          `EXACTLY (no range operator). These are shipped executables: a range ` +
          `lets a lockfile refresh swap the binary with no reviewed diff, and ` +
          `for ${CODEX} it silently breaks check:codex-pin, which compares the ` +
          `installed version to package.json#codexProtocolVersion by equality. ` +
          `Renovate bumps exact pins exactly as well as ranges.`,
      );
    }

    const installed = installedManifest(name);
    if (!installed) {
      fail(
        `${name} is declared ("${declared}") but not installed under ` +
          `node_modules. Run \`pnpm install\`.`,
      );
      continue;
    }

    resolved[name] = installed.version;

    // Only meaningful once the pin is exact; a range legitimately resolves
    // to something else, and we have already failed that above.
    if (EXACT.test(declared) && installed.version !== declared) {
      fail(
        `${name}: package.json pins ${declared} but node_modules has ` +
          `${installed.version}. The lockfile and the manifest disagree — ` +
          `run \`pnpm install\` and commit pnpm-lock.yaml.`,
      );
    }
  }

  return resolved;
}

// ── 3 + 4 + 5. Claude: the artifact, and its self-agreement ──

function checkClaudeArtifact(installedWrapperVersion) {
  const sdkPkg = installedManifest(CLAUDE_SDK);
  if (!sdkPkg) return;

  const declaredCodeVersion = sdkPkg.claudeCodeVersion;
  if (typeof declaredCodeVersion !== "string") {
    fail(
      `${CLAUDE_SDK}@${sdkPkg.version} has no \`claudeCodeVersion\` field. ` +
        `registry.ts, sidecar.ts, models-verify.mjs and stage-claude-cli.mjs ` +
        `all read it to decide which claude-code version the app reports and ` +
        `stages; without it the version surface degrades to null.`,
    );
    return;
  }

  // 3. Resolve the real platform binary and ask IT what version it is.
  //    resolveClaudeCliSource() is stage-claude-cli.mjs's own resolver — the
  //    same one electron-builder's beforePack hook uses — so a pass here means
  //    packaging will find the binary too. Reusing it (rather than a fifth copy
  //    of the platform-package walk) is deliberate: the candidate list must
  //    stay in lockstep with the SDK's resolver, and one implementation cannot
  //    drift from itself.
  let source;
  try {
    source = resolveClaudeCliSource();
  } catch (e) {
    fail(
      `Claude platform binary did not resolve for ${process.platform}-${process.arch}. ` +
        `This is what breaks \`electron-builder\` at pack time, and until now it ` +
        `surfaced only AFTER merge (release-alpha) or in the weekly cron.\n    ` +
        e.message.replace(/\n/g, "\n    "),
    );
    return;
  }

  notes.push(`claude binary → ${source.pkg}`);

  let execVersion = null;
  try {
    const out = execFileSync(source.path, ["--version"], {
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    execVersion = out.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/)?.[1] ?? null;
    if (!execVersion) {
      warn(
        `\`claude --version\` returned ${JSON.stringify(out.trim().slice(0, 80))}, ` +
          `which has no parseable version. Not failing the build — the binary ` +
          `did execute — but the output format may have changed.`,
      );
    }
  } catch (e) {
    // A binary that resolves but cannot execute is worse than a missing one:
    // staging succeeds and the app ships something it cannot run. The one
    // legitimate reason to land here is a cross-arch runner.
    fail(
      `Claude platform binary at ${source.path} resolved but failed to execute ` +
        `\`--version\` — ${e.message.split("\n")[0]}. A binary that stages but ` +
        `cannot run ships a broken Claude runtime.`,
    );
    return;
  }

  if (execVersion && execVersion !== declaredCodeVersion) {
    fail(
      `Claude version skew: the SDK declares claudeCodeVersion ` +
        `${declaredCodeVersion}, but the binary it ships reports ${execVersion}. ` +
        `The app stages the binary and displays the DECLARED value ` +
        `(binaries/claude-cli-version.txt), so users would see ` +
        `${declaredCodeVersion} while running ${execVersion}.`,
    );
  }

  if (
    compareVersions(
      declaredCodeVersion,
      CLAUDE_DESIGN_CONTAINMENT_MIN_VERSION,
    ) < 0
  ) {
    fail(
      `Claude Code ${declaredCodeVersion} is below the Design-containment ` +
        `minimum ${CLAUDE_DESIGN_CONTAINMENT_MIN_VERSION}. Older runtimes do ` +
        `not apply Edit(path) rules to the built-in Write tool, so shell ` +
        `sandboxing alone cannot support the advertised all-tool boundary.`,
    );
  }

  // 4. The two version fields the repo reads in two different orders.
  const manifestVersion = readClaudeCodeVersion(source.sdkMain);
  if (manifestVersion && manifestVersion !== declaredCodeVersion) {
    fail(
      `Claude self-disagreement: manifest.json says ${manifestVersion}, ` +
        `package.json#claudeCodeVersion says ${declaredCodeVersion}. ` +
        `registry.ts/sidecar.ts/stage-claude-cli.mjs prefer manifest.json; ` +
        `models-verify.mjs prefers claudeCodeVersion. While these agree the ` +
        `inverted precedence is harmless — the moment they diverge, the CI ` +
        `gate and the shipped UI silently report different versions.`,
    );
  }

  // 5. The vendor's own tested-pairing list.
  const manifestPath = join(dirname(source.sdkMain), "manifest.json");
  if (!existsSync(manifestPath)) return;
  let tested;
  try {
    tested = JSON.parse(readFileSync(manifestPath, "utf8"))?.sdkCompat
      ?.testedWrapperVersions;
  } catch {
    return;
  }
  if (!Array.isArray(tested) || tested.length === 0) return;

  if (!tested.includes(installedWrapperVersion)) {
    const newest = tested.reduce((a, b) =>
      compareVersions(a, b) >= 0 ? a : b,
    );
    const oldest = tested.reduce((a, b) =>
      compareVersions(a, b) <= 0 ? a : b,
    );

    if (compareVersions(installedWrapperVersion, oldest) < 0) {
      // Older than anything the shipped CLI was tested against — the vendor
      // has actively dropped support for this pairing.
      fail(
        `${CLAUDE_SDK}@${installedWrapperVersion} is OLDER than every wrapper ` +
          `version claude-code ${declaredCodeVersion} was tested against ` +
          `(oldest tested: ${oldest}). This pairing is unsupported by the vendor. ` +
          `Bump the SDK.`,
      );
    } else {
      // Newer than the list: normal — the manifest is built before the wrapper
      // publishes. Worth surfacing, never worth blocking on.
      warn(
        `${CLAUDE_SDK}@${installedWrapperVersion} is not in claude-code ` +
          `${declaredCodeVersion}'s own sdkCompat.testedWrapperVersions ` +
          `(newest tested: ${newest}). Expected for a fresh release — the CLI's ` +
          `manifest is built before the wrapper publishes — but if this persists ` +
          `across several bumps, the pairing is drifting untested.`,
      );
    }
  }
}

// ── codex: the triple check:codex-pin owns, minus the crash ──

function checkCodexTriple(installedCodexVersion) {
  const rootPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const pinned = rootPkg.codexProtocolVersion;
  if (typeof pinned !== "string") {
    fail(
      `package.json#codexProtocolVersion is missing. check:codex-pin compares ` +
        `it against the installed ${CODEX} and the committed bindings; without ` +
        `it the app can talk a stale protocol to a newer Codex binary.`,
    );
    return;
  }
  // check:codex-pin already compares installed/pin/bindings and prints the fix.
  // Repeating that would double the failure output for one cause. What it does
  // NOT cover is the dependency-declaration side, which is this gate's job:
  // `codexProtocolVersion` is a bare string with no Renovate customManager, so
  // it can only ever be moved by hand.
  if (installedCodexVersion && installedCodexVersion !== pinned) {
    notes.push(
      `codex ${installedCodexVersion} vs protocol pin ${pinned} — ` +
        `check:codex-pin owns this failure; run \`pnpm codegen:codex\``,
    );
  }
}

// ── ZSR component: provenance, reviewed patch, and opt-in defaults ──

async function checkSandboxRuntime(installedVersion) {
  const pinPath = join(ROOT, "scripts", "zsr-qualification", "pin.json");
  const workspacePath = join(ROOT, "pnpm-workspace.yaml");
  if (!existsSync(pinPath)) {
    fail(
      "ZSR provenance manifest scripts/zsr-qualification/pin.json is missing.",
    );
    return;
  }
  const pin = JSON.parse(readFileSync(pinPath, "utf8"));
  if (pin.package !== SANDBOX_RUNTIME || pin.version !== installedVersion) {
    fail(
      `ZSR provenance says ${pin.package}@${pin.version}, installed is ` +
        `${SANDBOX_RUNTIME}@${installedVersion ?? "missing"}.`,
    );
    return;
  }
  if (!/^[0-9a-f]{40}$/.test(pin.upstreamCommit ?? "")) {
    fail(
      "ZSR provenance must pin the upstream tag to one full Git commit SHA.",
    );
  }
  const installed = installedManifest(SANDBOX_RUNTIME);
  if (installed?.license !== pin.license || pin.license !== "Apache-2.0") {
    fail(
      `ZSR license mismatch: provenance=${pin.license}, ` +
        `installed=${installed?.license ?? "missing"}.`,
    );
  }
  const patch = join(
    ROOT,
    "patches",
    `@anthropic-ai__sandbox-runtime@${pin.version}.patch`,
  );
  if (!existsSync(patch)) {
    fail(`ZSR reviewed patch is missing: ${patch}`);
    return;
  }
  const digest = createHash("sha256").update(readFileSync(patch)).digest("hex");
  if (digest !== pin.patchSha256) {
    fail(
      `ZSR patch digest changed (${digest}); audit the diff and update ` +
        `pin.json only after the qualification matrix passes.`,
    );
  }
  const workspace = readFileSync(workspacePath, "utf8");
  if (
    !workspace.includes(
      `"${SANDBOX_RUNTIME}@${pin.version}": patches/@anthropic-ai__sandbox-runtime@${pin.version}.patch`,
    )
  ) {
    fail(
      "pnpm-workspace.yaml does not bind the exact ZSR version to its patch.",
    );
  }
  const lock = readFileSync(join(ROOT, "pnpm-lock.yaml"), "utf8");
  if (!lock.includes(`resolution: {integrity: ${pin.tarballIntegrity}}`)) {
    fail("ZSR lockfile tarball integrity differs from the audited provenance.");
  }

  try {
    const { FilesystemConfigSchema, SandboxRuntimeConfigSchema } =
      await import("@anthropic-ai/sandbox-runtime");
    const fsBase = {
      denyRead: [],
      allowRead: [],
      allowWrite: [],
      denyWrite: [],
    };
    const fsDefault = FilesystemConfigSchema.parse(fsBase);
    const fsOptIn = FilesystemConfigSchema.parse({
      ...fsBase,
      disableMandatoryWriteProtection: true,
      allowWriteWithinDeny: ["/private/session"],
    });
    const hostParity = SandboxRuntimeConfigSchema.parse({
      hostParity: true,
      linuxPrivilegedWorker: {
        uid: 1000,
        gid: 1000,
        setprivPath: "/usr/bin/setpriv",
      },
      filesystem: fsBase,
      network: { allowedDomains: [], deniedDomains: [] },
    });
    if (
      fsDefault.disableMandatoryWriteProtection !== undefined ||
      fsDefault.allowWriteWithinDeny !== undefined ||
      fsOptIn.disableMandatoryWriteProtection !== true ||
      fsOptIn.allowWriteWithinDeny?.[0] !== "/private/session" ||
      hostParity.hostParity !== true ||
      hostParity.linuxPrivilegedWorker?.uid !== 1000
    ) {
      fail(
        "ZSR patch contract drifted: host-parity filesystem and worker " +
          "switches must remain explicit opt-ins.",
      );
    }
  } catch (error) {
    fail(
      `ZSR patched schema could not be validated: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

// ── --drift: how far behind latest are we? (never fails) ──

async function reportDrift(resolved) {
  const rows = [];
  for (const name of BUNDLED_RUNTIMES) {
    const current = resolved[name];
    if (!current) continue;
    try {
      // The scope separator must be percent-encoded or the registry reads
      // `@scope/name` as two path segments. replaceAll, not replace: a plain
      // string pattern substitutes only the FIRST match, which is correct for
      // every valid npm name (at most one slash) but is the kind of latent
      // half-escape that CodeQL's js/incomplete-sanitization rightly rejects.
      const res = await fetch(
        `https://registry.npmjs.org/${name.replaceAll("/", "%2F")}/latest`,
        {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!res.ok) {
        rows.push([name, current, `? (registry HTTP ${res.status})`, ""]);
        continue;
      }
      const latest = (await res.json())?.version ?? null;
      if (!latest) {
        rows.push([name, current, "?", ""]);
        continue;
      }
      const behind = compareVersions(current, latest) < 0;
      rows.push([name, current, latest, behind ? "BEHIND" : "up to date"]);
    } catch (e) {
      rows.push([name, current, `? (${e.name})`, ""]);
    }
  }

  const w = Math.max(...rows.map((r) => r[0].length));
  console.log("\n── bundled runtime drift ──────────────────────────────");
  for (const [name, cur, latest, state] of rows) {
    console.log(
      `  ${name.padEnd(w)}  ${cur.padEnd(12)} → ${String(latest).padEnd(12)} ${state}`,
    );
  }
  const behind = rows.filter((r) => r[3] === "BEHIND");
  console.log(
    behind.length
      ? `\n  ${behind.length} of ${rows.length} runtime pins are behind latest. ` +
          `Renovate opens the "agent CLIs" PR before 6am Monday; this is only a report.`
      : `\n  All ${rows.length} runtime pins are at latest.`,
  );
}

// ── main ──────────────────────────────────────────────────

const drift = process.argv.includes("--drift");

const resolved = checkPins();
checkClaudeArtifact(resolved[CLAUDE_SDK]);
checkCodexTriple(resolved[CODEX]);
await checkSandboxRuntime(resolved[SANDBOX_RUNTIME]);

for (const n of notes) console.log(`  · ${n}`);
for (const w of warnings) console.warn(`⚠ ${w}`);

if (errors.length) {
  for (const e of errors) console.error(`✗ ${e}`);
  console.error(
    `\n✗ check:runtime-pins FAILED — ${errors.length} problem(s) with the ` +
      `bundled agent runtime pins.`,
  );
  process.exit(1);
}

console.log(
  `✓ check:runtime-pins — ${BUNDLED_RUNTIMES.length} runtimes pinned exactly, ` +
    `installed, and the Claude binary self-reports its declared version` +
    (warnings.length ? ` (${warnings.length} warning(s))` : ""),
);

if (drift) await reportDrift(resolved);
