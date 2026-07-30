import { describe, it, expect, afterEach } from "vitest";
import { buildOneShotArgs, buildPtyEnv } from "../shell-setup";

// Secrets that must NEVER reach a shell spawned for a remote client — including
// the URL/connection-string/agent forms whose KEY carries no secret marker (the
// reason a denylist is insufficient and we use an allowlist).
const PLANTED = [
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GITHUB_TOKEN", "GH_TOKEN", "GH_PAT",
  "MY_DB_PASSWORD", "ZEROS_RELAY_URL", "ZEROS_SECRETS_FILE", "AWS_SECRET_ACCESS_KEY",
  "NPM_TOKEN", "DATABASE_URL", "REDIS_URL", "MONGODB_URI", "SENTRY_DSN",
  "CLOUD_API_URL", "SLACK_WEBHOOK_URL", "SSH_AUTH_SOCK", "KUBECONFIG", "MYSQL_PWD",
  "npm_config__authToken",
];

describe("buildPtyEnv env scrubbing (remote = allowlist)", () => {
  afterEach(() => {
    for (const k of [...PLANTED, "MY_SAFE_VAR"]) delete process.env[k];
  });

  it("remote shells get ONLY allowlisted vars — every secret is dropped (incl. URL/agent forms)", () => {
    for (const k of PLANTED) process.env[k] = "sensitive";
    process.env.MY_SAFE_VAR = "nope"; // not on the allowlist
    const env = buildPtyEnv({ scrub: true });
    for (const k of PLANTED) expect(env[k], `${k} must be scrubbed`).toBeUndefined();
    // Allowlist semantics: even an innocuous unknown var is dropped — that's
    // what makes it robust against secret-bearing names we never anticipated.
    expect(env.MY_SAFE_VAR).toBeUndefined();
    // Core vars the shell needs survive, and the Zeros overrides apply.
    expect(env.PATH).toBeDefined();
    expect(env.HOME).toBeDefined();
    expect(env.TERM).toBe("xterm-256color");
    expect(env.ZEROS_TERMINAL).toBe("1");
  });

  it("local shells keep the full env (desktop parity)", () => {
    process.env.ANTHROPIC_API_KEY = "local-key";
    process.env.MY_SAFE_VAR = "keep";
    const env = buildPtyEnv();
    expect(env.ANTHROPIC_API_KEY).toBe("local-key");
    expect(env.MY_SAFE_VAR).toBe("keep");
    expect(buildPtyEnv({ scrub: false }).ANTHROPIC_API_KEY).toBe("local-key");
  });

  it("both local and remote shells shed the launching `pnpm run` context", () => {
    // The engine is a long-lived app, not a continuation of the script that
    // started it — so no shell it spawns should inherit that script's config.
    // (Full behaviour incl. the PATH rule: env/__tests__/launcher-env.test.ts.)
    const launcher = {
      npm_execpath: "/usr/local/lib/pnpm.cjs",
      npm_lifecycle_event: "electron:dev",
      npm_config_verify_deps_before_run: "install",
      INIT_CWD: "/Users/me/zeros",
    };
    Object.assign(process.env, launcher);
    try {
      for (const env of [buildPtyEnv(), buildPtyEnv({ scrub: true })]) {
        for (const key of Object.keys(launcher)) {
          expect(
            env[key],
            `${key} must not follow the app into a shell`,
          ).toBeUndefined();
        }
      }
    } finally {
      for (const key of Object.keys(launcher)) delete process.env[key];
    }
  });
});

// A one-shot shell runs a command and exits. `interactive` is what makes it
// read the SAME startup files the Terminal tab's shell does — where
// nvm/fnm/mise/pnpm put their PATH setup — without re-enabling the job control
// that would move a backgrounded grandchild out of the process group we
// SIGKILL on stop.
describe("buildOneShotArgs — terminal parity without leaking processes", () => {
  it("stays NON-interactive by default — the setup script must not source .zshrc", () => {
    // `scripts.setup` is repo-resident and can arrive with a branch, so it runs
    // under a narrow allowlist (H6). Sourcing the user's .zshrc would route
    // straight around that: `export ANTHROPIC_API_KEY=…` lives there. Setup
    // gets its toolchain from the out-of-band PATH probe instead.
    expect(buildOneShotArgs("/bin/zsh", "pnpm install")).toEqual([
      "-l",
      "-c",
      "pnpm install",
    ]);
    expect(buildOneShotArgs("/bin/bash", "pnpm install")).toEqual([
      "-l",
      "-c",
      "pnpm install",
    ]);
  });

  it("zsh + interactive: sources ~/.zshrc, with job control off", () => {
    const args = buildOneShotArgs("/bin/zsh", "pnpm dev", true);
    expect(args.slice(0, 4)).toEqual(["-l", "-i", "+m", "-c"]);
    // -i is the whole point: `zsh -l -c` skips .zshrc, so a run action saw a
    // different toolchain (often no pnpm/node at all) than the terminal.
    expect(args).toContain("-i");
    // +m keeps children in the shell's process group so pty-host's
    // `kill(-pid)` still reaps a dev server started with `&`.
    expect(args).toContain("+m");
    // …and the login flag is dropped before the command runs, so the logout
    // files (stock /etc/zlogout is `clear`) can't erase the run log on exit.
    expect(args.at(-1)).toMatch(/^unsetopt login /);
    expect(args.at(-1)).toMatch(/pnpm dev$/);
  });

  it("disables oh-my-zsh's updater in the PROLOGUE, not just via env", () => {
    // The env var alone is ignored whenever the user configured the updater the
    // modern, documented way (`zstyle ':omz:update' mode …`): upstream reads
    // DISABLE_AUTO_UPDATE inside a `zstyle -s … || { … }` fallback block. The run
    // then hits "Would you like to update? [Y/n]" and blocks on a stdin nobody is
    // watching — and its `[[ ! -t 1 ]]` bail-out doesn't help, because a run
    // action HAS a real PTY. Setting the zstyle after .zshrc wins either way.
    const prologue = buildOneShotArgs("/bin/zsh", "pnpm dev", true).at(-1)!;
    expect(prologue).toContain("zstyle ':omz:update' mode disabled");
    // Every prologue statement must be survivable on a shell that lacks it.
    for (const stmt of prologue.split(";").slice(0, -1)) {
      expect(stmt, stmt).toContain("2>/dev/null");
    }
  });

  it("zsh: recognized through a full path, a login-dash, or a version suffix", () => {
    expect(buildOneShotArgs("/opt/homebrew/bin/zsh", "x", true)).toContain("-i");
    expect(buildOneShotArgs("-zsh", "x", true)).toContain("-i");
    // A versioned name fell out of the parity fix entirely, with nothing in the
    // log to say the run got a different shell than the terminal did.
    expect(buildOneShotArgs("/usr/local/bin/zsh-5.9", "x", true)).toContain("-i");
    expect(buildOneShotArgs("/usr/bin/zsh5", "x", true)).toContain("-i");
    expect(buildOneShotArgs("/usr/local/bin/bash5", "x", true)).toContain("-i");
    // …but a shell that merely starts with those letters is not one of them.
    expect(buildOneShotArgs("/usr/bin/zshfoo", "x", true)).not.toContain("-i");
  });

  it("bash + interactive: job control disabled in-band", () => {
    // bash ignores a `+m` argv entry here, so it has to be `set +m` inside the
    // command string — verified against a real PTY (children kept the shell's
    // pgid; without it a backgrounded child survived the group kill).
    expect(buildOneShotArgs("/bin/bash", "pnpm dev", true)).toEqual([
      "-l",
      "-i",
      "-c",
      "set +m 2>/dev/null; pnpm dev",
    ]);
  });

  it("an unrecognized shell keeps the plain login form even when interactive", () => {
    // We have no verified no-leak recipe for fish/sh — never guess with a flag
    // that could strand processes.
    expect(buildOneShotArgs("/usr/bin/fish", "pnpm dev", true)).toEqual([
      "-l",
      "-c",
      "pnpm dev",
    ]);
  });

  it("the user's command stays LAST, so the shell's exit code is the command's", () => {
    for (const shell of ["/bin/zsh", "/bin/bash", "/usr/bin/fish"]) {
      for (const interactive of [false, true]) {
        expect(
          buildOneShotArgs(shell, "pnpm build", interactive).at(-1),
        ).toMatch(/pnpm build$/);
      }
    }
  });
});
