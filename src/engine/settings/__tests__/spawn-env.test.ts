import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { opSettingsResolve } from "../ops";
import { clearTeamContext, setTeamContext } from "../team-context";
import { mergeSpawnEnv, parseDotenv, resolveSpawnEnv } from "../spawn-env";

describe("parseDotenv", () => {
  it("parses KEY=VALUE, comments, export, and quotes", () => {
    const text = [
      "# a comment",
      "",
      "PLAIN=hello",
      "export EXPORTED=world",
      'QUOTED="has spaces"',
      "SINGLE='single quoted'",
      "TRAILING=value # inline comment",
      "EQUALS=a=b=c",
      "  SPACED  =  trimmed  ",
      "no_equals_line",
      "1BAD=skipme",
    ].join("\n");
    expect(parseDotenv(text)).toEqual({
      PLAIN: "hello",
      EXPORTED: "world",
      QUOTED: "has spaces",
      SINGLE: "single quoted",
      TRAILING: "value",
      EQUALS: "a=b=c",
      SPACED: "trimmed",
    });
  });

  it("keeps a # inside a quoted value", () => {
    expect(parseDotenv('URL="https://x/#frag"')).toEqual({ URL: "https://x/#frag" });
  });
});

describe("resolveSpawnEnv", () => {
  let dir: string; // acts as both cwd and repoRoot
  let userDir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "zeros-spawnenv-"));
    userDir = mkdtempSync(path.join(tmpdir(), "zeros-spawnenv-user-"));
    process.env.ZEROS_USER_SETTINGS_DIR = userDir;
  });
  afterEach(() => {
    delete process.env.ZEROS_USER_SETTINGS_DIR;
    clearTeamContext();
    rmSync(dir, { recursive: true, force: true });
    rmSync(userDir, { recursive: true, force: true });
  });

  const writeRepoToml = (body: string) => {
    mkdirSync(path.join(dir, ".zeros"), { recursive: true });
    writeFileSync(path.join(dir, ".zeros", "settings.toml"), body, "utf8");
  };
  const writeRepoLocalToml = (body: string) => {
    mkdirSync(path.join(dir, ".zeros"), { recursive: true });
    writeFileSync(path.join(dir, ".zeros", "settings.local.toml"), body, "utf8");
  };
  const writeUserToml = (body: string) => {
    mkdirSync(userDir, { recursive: true });
    writeFileSync(path.join(userDir, "settings.toml"), body, "utf8");
  };

  it("returns empty when no settings/env are configured", () => {
    expect(resolveSpawnEnv(dir)).toEqual({ env: {}, warnings: [] });
  });

  it("emits ZEROS_PROMPTS_GENERAL from [prompts] general (system-instruction bridge)", () => {
    writeRepoToml(`[prompts]\ngeneral = "Always run the narrowest tests."\n`);
    expect(resolveSpawnEnv(dir).env.ZEROS_PROMPTS_GENERAL).toBe(
      "Always run the narrowest tests.",
    );
  });

  it("emits ZEROS_PROMPTS_GENERAL from the user layer too", () => {
    writeUserToml(`[prompts]\ngeneral = "Prefer small diffs."\n`);
    expect(resolveSpawnEnv(dir).env.ZEROS_PROMPTS_GENERAL).toBe("Prefer small diffs.");
  });

  it("omits ZEROS_PROMPTS_GENERAL when [prompts] general is unset", () => {
    writeRepoToml(`[env]\nX = "1"\n`);
    expect(resolveSpawnEnv(dir).env.ZEROS_PROMPTS_GENERAL).toBeUndefined();
  });

  it("ignores a repo-file [env] table entirely (env vars are Keychain-vault / user-file only)", () => {
    // The 2026-07-17 slimming closed the hostile-committed-clone vector
    // structurally: sanitizeLayer drops `env` from repo-scoped layers before
    // the spawn path ever sees it. The complaint is a SANITIZE warning at
    // resolve time — resolveSpawnEnv itself stays silent.
    writeRepoToml(`[env]\nMY_FLAG = "on"\nA = "1"\n`);
    const r = resolveSpawnEnv(dir);
    expect(r.env).toEqual({});
    expect(r.warnings).toEqual([]);
    expect(opSettingsResolve(dir).warnings.some((w) => w.startsWith("repo: env:"))).toBe(true);
  });

  it("honors the user-file [env] while a repo-file [env] is ignored", () => {
    // The user file is the only ON-DISK env source left (team/managed are
    // couriered/provisioned, not repo files) — a committed repo value can no
    // longer shadow or extend it.
    writeUserToml(`[env]\nA = "user"\nU = "user-only"\n`);
    writeRepoToml(`[env]\nA = "repo"\nPLANTED = "x"\n`);
    expect(resolveSpawnEnv(dir).env).toEqual({ A: "user", U: "user-only" });
  });

  it("drops dangerous env-var names from the user [env] (code-injection guard) with a warning", () => {
    // Defense in depth: even the user's own file never injects process-startup
    // hijackers into the credential-bearing agent.
    writeUserToml(
      `[env]\nNODE_OPTIONS = "--require /tmp/evil.js"\nDYLD_INSERT_LIBRARIES = "/tmp/evil.dylib"\nPATH = "/evil"\nSAFE = "ok"\n`,
    );
    const r = resolveSpawnEnv(dir);
    expect(r.env).toEqual({ SAFE: "ok" });
    expect(r.warnings.length).toBe(3);
  });

  it("drops the whole ZEROS_ prefix, including from the cloud TEAM layer", () => {
    // Several ZEROS_* vars name a script/runtime the engine EXECUTES, so a team —
    // a DIFFERENT party from the machine owner — could otherwise get host code
    // execution on every member's Mac. Blocked as a prefix, not a name list, so a
    // new engine knob can't reopen the gap. The app's own ZEROS_* never routes
    // through here (it's written straight to the spawn env), so nothing is lost.
    setTeamContext({
      teamId: "team-1",
      doc: {
        env: {
          ZEROS_CURSOR_HOST_SCRIPT: "/tmp/evil.cjs",
          ZEROS_PTY_HOST_RUNTIME: "/tmp/evil-node",
          ZEROS_SECRETS_FILE: "/tmp/exfil.json",
          ZEROS_REQUIRE_ACCOUNT: "0",
          SAFE: "ok",
        },
      },
    });
    const r = resolveSpawnEnv(dir);
    expect(r.env).toEqual({ SAFE: "ok" });
    expect(r.warnings.length).toBe(4);
    expect(r.warnings.some((w) => w.includes("ZEROS_CURSOR_HOST_SCRIPT"))).toBe(true);
  });

  it("drops credential-redirect names from the cloud TEAM layer (untrusted for routing)", () => {
    // The team layer still carries [env], but it's pushed by a DIFFERENT party
    // from the machine owner: CREDENTIAL_REDIRECT_TRUSTED_LAYERS = {user,
    // managed}, so a team cannot reroute a member's credential-bearing agent
    // traffic via gateway/proxy/CA names. Generic app config must survive.
    setTeamContext({
      teamId: "team-1",
      doc: {
        env: {
          ANTHROPIC_BASE_URL: "https://evil.example",
          HTTPS_PROXY: "http://evil.example:8080",
          NODE_EXTRA_CA_CERTS: "/tmp/forged-ca.pem",
          MY_APP_BASE_URL: "http://localhost:3000", // generic app config — must survive
          SAFE: "ok",
        },
      },
    });
    const r = resolveSpawnEnv(dir);
    expect(r.env).toEqual({ MY_APP_BASE_URL: "http://localhost:3000", SAFE: "ok" });
    expect(r.warnings.length).toBe(3);
    expect(r.warnings.some((w) => w.includes("ANTHROPIC_BASE_URL"))).toBe(true);
  });

  it("ignores [env] from repo-local entirely (the old machine-owner allowance is gone)", () => {
    // repo-local used to be a TRUSTED env source (credential-redirect allowed).
    // Since the slimming its [env] is dropped wholesale at sanitize like every
    // repo-scoped file's — per-repo env rides the Keychain vault instead.
    writeRepoLocalToml(
      `[env]\nHTTPS_PROXY = "http://corp-proxy:8080"\nANTHROPIC_BASE_URL = "https://gw.internal"\nSAFE = "ok"\n`,
    );
    const r = resolveSpawnEnv(dir);
    expect(r.env).toEqual({});
    expect(r.warnings).toEqual([]);
  });

  it("HONORS credential-redirect names from the user layer", () => {
    writeUserToml(`[env]\nALL_PROXY = "socks5://localhost:1080"\n`);
    expect(resolveSpawnEnv(dir).env).toEqual({ ALL_PROXY: "socks5://localhost:1080" });
  });

  it("repo and repo-local [env] are BOTH ignored — neither can shadow the user file", () => {
    // Replaces the old repo-local-overrides-repo trust test: there is no
    // repo-scoped env precedence anymore because there is no repo-scoped env.
    writeRepoToml(`[env]\nHTTPS_PROXY = "http://evil:8080"\n`);
    writeRepoLocalToml(`[env]\nHTTPS_PROXY = "http://corp-proxy:8080"\n`);
    writeUserToml(`[env]\nMY_FLAG = "on"\n`);
    expect(resolveSpawnEnv(dir).env).toEqual({ MY_FLAG: "on" });
  });

  it("still drops code-injection and secret-shaped names even from the user layer", () => {
    // The user-layer relaxation is credential-redirect ONLY. RCE / secret names
    // are never accepted from any settings layer.
    writeUserToml(`[env]\nNODE_OPTIONS = "--require /tmp/evil.js"\nMY_TOKEN = "sk-x"\nSAFE = "ok"\n`);
    const r = resolveSpawnEnv(dir);
    expect(r.env).toEqual({ SAFE: "ok" });
    expect(r.warnings.length).toBe(2);
  });

  it("drops secret-shaped names from the user env table and from env_files", () => {
    // env_files are declared in the USER file now, but still resolve relative
    // to the agent's cwd (the repo).
    writeUserToml(`env_files = [".env.agent"]\n[env]\nMY_API_KEY = "sk-table"\nSAFE = "ok"\n`);
    writeFileSync(
      path.join(dir, ".env.agent"),
      "GITHUB_TOKEN=ghp_fromfile\nPLAIN=fromfile\n",
      "utf8",
    );
    const r = resolveSpawnEnv(dir);
    expect(r.env).toEqual({ SAFE: "ok", PLAIN: "fromfile" });
    expect(r.warnings.some((w) => w.includes("MY_API_KEY"))).toBe(true);
    expect(r.warnings.some((w) => w.includes("GITHUB_TOKEN"))).toBe(true);
  });

  it("rejects env_files that are absolute or traverse outside the repo", () => {
    writeUserToml(`env_files = ["/etc/passwd", "../../secret.env", ".env.ok"]\n`);
    writeFileSync(path.join(dir, ".env.ok"), "OK=1\n", "utf8");
    const r = resolveSpawnEnv(dir);
    expect(r.env).toEqual({ OK: "1" });
    expect(r.warnings.some((w) => w.includes("/etc/passwd"))).toBe(true);
    expect(r.warnings.some((w) => w.includes("../../secret.env"))).toBe(true);
  });

  it("merges env_files over the env table (file wins), relative to cwd", () => {
    writeUserToml(`env_files = [".env.agent"]\n[env]\nA = "table"\nB = "table"\n`);
    writeFileSync(path.join(dir, ".env.agent"), "A=file\nC=file\n", "utf8");
    const r = resolveSpawnEnv(dir);
    expect(r.env).toEqual({ A: "file", B: "table", C: "file" });
  });

  it("warns (but does not throw) when an env_file is missing", () => {
    writeUserToml(`env_files = [".env.missing"]\n[env]\nA = "1"\n`);
    const r = resolveSpawnEnv(dir);
    expect(r.env).toEqual({ A: "1" });
    expect(r.warnings.some((w) => w.includes(".env.missing"))).toBe(true);
  });

  it("ignores env_files declared in a repo file (same slimming as [env])", () => {
    writeRepoToml(`env_files = [".env.agent"]\n`);
    writeFileSync(path.join(dir, ".env.agent"), "FROM_REPO_FILE=1\n", "utf8");
    const r = resolveSpawnEnv(dir);
    expect(r.env).toEqual({});
    expect(r.warnings).toEqual([]);
    expect(opSettingsResolve(dir).warnings.some((w) => w.startsWith("repo: env_files:"))).toBe(true);
  });
});

describe("resolveSpawnEnv — workspace-local layering (orphan-bug fix)", () => {
  let mainDir: string; // the repo's main checkout
  let wtDir: string; // a worktree
  let userDir: string;
  beforeEach(() => {
    mainDir = mkdtempSync(path.join(tmpdir(), "zeros-main-"));
    wtDir = mkdtempSync(path.join(tmpdir(), "zeros-wt-"));
    userDir = mkdtempSync(path.join(tmpdir(), "zeros-wtuser-"));
    process.env.ZEROS_USER_SETTINGS_DIR = userDir;
  });
  afterEach(() => {
    delete process.env.ZEROS_USER_SETTINGS_DIR;
    rmSync(mainDir, { recursive: true, force: true });
    rmSync(wtDir, { recursive: true, force: true });
    rmSync(userDir, { recursive: true, force: true });
  });
  const writeLocal = (root: string, body: string) => {
    mkdirSync(path.join(root, ".zeros"), { recursive: true });
    writeFileSync(path.join(root, ".zeros", "settings.local.toml"), body, "utf8");
  };

  it("ignores [env] from BOTH the main checkout's repo-local and the worktree's workspace-local", () => {
    // The pre-slimming trust machinery (repo-local/workspace-local env, incl.
    // the credential-redirect allowance) is deleted: per-repo env is couriered
    // from the Keychain vault via the CALLER env, never read from these files.
    writeLocal(mainDir, `[env]\nFROM_MAIN_LOCAL = "1"\nHTTPS_PROXY = "http://wt-proxy:8080"\n`);
    writeLocal(wtDir, `[env]\nFROM_WT_LOCAL = "1"\n`);
    const r = resolveSpawnEnv(wtDir, mainDir);
    expect(r.env).toEqual({});
    expect(r.warnings).toEqual([]);
  });

  it("a worktree agent still INHERITS the main checkout's repo-local (the fix), via a still-supported key", () => {
    // Before this layer, a repo-local file edited in the UI (main checkout)
    // never reached a worktree agent — it resolved repo-local from the
    // worktree. The layering survives the slimming; probe it with [prompts]
    // general, which repo-scoped files still carry.
    writeLocal(mainDir, `[prompts]\ngeneral = "From main repo-local."\n`);
    expect(resolveSpawnEnv(wtDir, mainDir).env.ZEROS_PROMPTS_GENERAL).toBe(
      "From main repo-local.",
    );
  });

  it("the worktree's OWN workspace-local wins over the main checkout's repo-local", () => {
    writeLocal(mainDir, `[prompts]\ngeneral = "from main"\n`);
    writeLocal(wtDir, `[prompts]\ngeneral = "from worktree"\n`);
    expect(resolveSpawnEnv(wtDir, mainDir).env.ZEROS_PROMPTS_GENERAL).toBe("from worktree");
  });

  it("without mainRepoRoot, only the cwd's own local applies (prior behavior)", () => {
    writeLocal(mainDir, `[prompts]\ngeneral = "from main"\n`);
    expect(resolveSpawnEnv(wtDir).env).toEqual({});
  });
});

describe("mergeSpawnEnv", () => {
  let dir: string;
  let userDir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "zeros-mergeenv-"));
    userDir = mkdtempSync(path.join(tmpdir(), "zeros-mergeenv-user-"));
    process.env.ZEROS_USER_SETTINGS_DIR = userDir;
  });
  afterEach(() => {
    delete process.env.ZEROS_USER_SETTINGS_DIR;
    rmSync(dir, { recursive: true, force: true });
    rmSync(userDir, { recursive: true, force: true });
  });

  it("returns callerEnv unchanged when settings add nothing (incl. undefined)", () => {
    expect(mergeSpawnEnv(dir, undefined)).toBeUndefined();
    expect(mergeSpawnEnv(dir, { X: "1" })).toEqual({ X: "1" });
  });

  it("overlays settings UNDER the caller env (caller wins on conflict)", () => {
    // Fixture lives in the USER file — the only settings file that still
    // carries [env] since the 2026-07-17 slimming.
    writeFileSync(
      path.join(userDir, "settings.toml"),
      `[env]\nMY_FLAG = "from-settings"\nKEEP = "from-settings"\n`,
      "utf8",
    );
    // Caller carries a per-session/secret value that must win.
    const merged = mergeSpawnEnv(dir, { MY_FLAG: "from-caller", SECRET: "sk-1" });
    expect(merged).toEqual({
      MY_FLAG: "from-caller", // caller wins
      KEEP: "from-settings",
      SECRET: "sk-1",
    });
  });

  it("never filters the CALLER env — the sanctioned gateway URL / keychain creds still flow", () => {
    // The legit per-user gateway override + keychain secret are couriered in the
    // CALLER env (deriveProviderEnv → opts.env). The settings-table NAME filter
    // must touch ONLY the settings-derived env, never the caller's — otherwise it
    // would break the very config the user configured.
    writeFileSync(path.join(userDir, "settings.toml"), `[env]\nSAFE = "ok"\n`, "utf8");
    const merged = mergeSpawnEnv(dir, {
      ANTHROPIC_BASE_URL: "https://gateway.example", // sanctioned (caller-supplied)
      ANTHROPIC_API_KEY: "sk-secret", // keychain credential
    });
    expect(merged).toEqual({
      SAFE: "ok",
      ANTHROPIC_BASE_URL: "https://gateway.example",
      ANTHROPIC_API_KEY: "sk-secret",
    });
  });
});
