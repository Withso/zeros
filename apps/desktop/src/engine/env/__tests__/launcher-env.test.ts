// `pnpm electron:dev` (or any `npm start`-style launcher) exports its own
// invocation context, and the engine used to hand that whole blob to every
// shell, agent and script it spawned — inside OTHER projects' worktrees, where
// it is wrong. These cover both directions: the launcher's state must go, and
// the user's own configuration must not be mistaken for it.

import { describe, it, expect } from "vitest";
import path from "node:path";

import {
  hasLauncherScriptEnv,
  pruneLauncherScriptEnv,
  sanitizeProbedPath,
  stripLauncherBinFromPath,
  stripLauncherNodeOptions,
  TOOLCHAIN_ENV_NAMES,
} from "../launcher-env";

const ZEROS = "/Users/me/zeros";

/** What `pnpm electron:dev` actually leaves in the env. */
const LAUNCHER = {
  npm_execpath: "/usr/local/lib/pnpm.cjs",
  npm_lifecycle_event: "electron:dev",
  INIT_CWD: ZEROS,
  PNPM_SCRIPT_SRC_DIR: ZEROS,
  npm_config_verify_deps_before_run: "install",
  npm_config__jsr_registry: "https://npm.jsr.io",
  npm_config_registry: "https://registry.npmjs.org/",
  npm_package_name: "zeros",
};

const P = (...entries: string[]) => entries.join(path.delimiter);

describe("hasLauncherScriptEnv — only a real script run counts", () => {
  it("recognises the markers a package manager sets", () => {
    expect(hasLauncherScriptEnv({ npm_lifecycle_event: "dev" })).toBe(true);
    expect(hasLauncherScriptEnv({ npm_execpath: "/x/pnpm.cjs" })).toBe(true);
    expect(hasLauncherScriptEnv({ INIT_CWD: "/x" })).toBe(true);
  });

  it("npm_config_* alone is NOT proof — that is how users configure npm", () => {
    // A corporate registry is routinely exported from ~/.zshenv or a launchd
    // plist. Treating it as launcher state would delete it (and then strip the
    // PATH) in a packaged app no script ever started.
    expect(hasLauncherScriptEnv({ npm_config_registry: "https://x/" })).toBe(
      false,
    );
    expect(hasLauncherScriptEnv({ NPM_CONFIG_REGISTRY: "https://x/" })).toBe(
      false,
    );
    expect(hasLauncherScriptEnv({})).toBe(false);
  });
});

describe("pruneLauncherScriptEnv", () => {
  it("drops the launching script's whole context", () => {
    const env: Record<string, string> = { ...LAUNCHER, PATH: "/usr/bin" };
    pruneLauncherScriptEnv(env);
    for (const key of Object.keys(LAUNCHER)) expect(env[key]).toBeUndefined();
  });

  it("keeps the user's toolchain roots and uppercase NPM_CONFIG_* settings", () => {
    const env: Record<string, string> = {
      ...LAUNCHER,
      PNPM_HOME: "/Users/me/.pnpm",
      VOLTA_HOME: "/Users/me/.volta",
      // npm's documented USER-config spelling. `npm run` only ever exports the
      // lower-case form, so deleting this would break a private registry that
      // the identical command resolves fine in Terminal.app.
      NPM_CONFIG_REGISTRY: "https://artifactory.corp/api/npm/",
      PATH: "/usr/bin",
    };
    pruneLauncherScriptEnv(env);
    expect(env.PNPM_HOME).toBe("/Users/me/.pnpm");
    expect(env.VOLTA_HOME).toBe("/Users/me/.volta");
    expect(env.NPM_CONFIG_REGISTRY).toBe("https://artifactory.corp/api/npm/");
  });

  it("drops pnpm's SECOND spelling of its own config", () => {
    // pnpm exports every setting twice — `npm_config_x` AND `pnpm_config_x`.
    // Covering only the npm spelling left the header's own worked example
    // (verify-deps-before-run) reaching every child in another project.
    const env: Record<string, string> = {
      ...LAUNCHER,
      pnpm_config_verify_deps_before_run: "install",
      pnpm_config_node_linker: "hoisted",
      PATH: "/usr/bin",
    };
    pruneLauncherScriptEnv(env);
    expect(env.pnpm_config_verify_deps_before_run).toBeUndefined();
    expect(env.pnpm_config_node_linker).toBeUndefined();
  });

  it("drops YARN_* — berry reads those back OVER a project's own .yarnrc.yml", () => {
    const env: Record<string, string> = {
      npm_execpath: "/x/yarn.cjs",
      YARN_NODE_LINKER: "pnp",
      YARN_NPM_REGISTRY_SERVER: "https://internal/npm",
      PATH: "/usr/bin",
    };
    pruneLauncherScriptEnv(env);
    expect(env.YARN_NODE_LINKER).toBeUndefined();
    expect(env.YARN_NPM_REGISTRY_SERVER).toBeUndefined();
  });

  it("drops NODE — every manager exports the node that ran IT", () => {
    // Anything honouring $NODE (npm lifecycle scripts, node-gyp, Makefiles) would
    // otherwise get Zeros' node instead of the one the worktree's .nvmrc pins.
    const env: Record<string, string> = {
      ...LAUNCHER,
      NODE: "/opt/zeros-node/bin/node",
      PATH: "/usr/bin",
    };
    pruneLauncherScriptEnv(env);
    expect(env.NODE).toBeUndefined();
  });

  it("strips a bun launch's bin dirs — bun names its root only in npm_config_*", () => {
    // Bun sets npm_execpath &c. (so pruning ran) but no INIT_CWD/PROJECT_CWD, so
    // the launcher-root set came back EMPTY and the PATH rule silently did
    // nothing while the env pruning looked like it had worked.
    const env: Record<string, string> = {
      npm_execpath: "/usr/local/bin/bun",
      npm_lifecycle_event: "electron:dev",
      npm_config_local_prefix: ZEROS,
      PATH: P(`${ZEROS}/node_modules/.bin`, "/opt/homebrew/bin", "/usr/bin"),
    };
    pruneLauncherScriptEnv(env);
    expect(env.PATH).toBe(P("/opt/homebrew/bin", "/usr/bin"));
    expect(env.npm_config_local_prefix).toBeUndefined();
  });

  it("strips yarn's TEMP SHIM dir, which holds a `node` of its own", () => {
    // BERRY_BIN_FOLDER contains node/yarn/node-gyp wrappers and is prepended, so
    // leaving it means `node` in every terminal and run action is the LAUNCHER's
    // node — worse than a stale node_modules/.bin. It is a marker, so the var
    // itself was deleted, destroying the only handle on the directory.
    const shim = "/tmp/xfs-38135913";
    const env: Record<string, string> = {
      npm_execpath: "/x/yarn.cjs",
      BERRY_BIN_FOLDER: shim,
      PROJECT_CWD: ZEROS,
      PATH: P(shim, `${ZEROS}/node_modules/.bin`, "/usr/bin"),
    };
    pruneLauncherScriptEnv(env);
    expect(env.PATH).toBe("/usr/bin");
  });

  it("leaves a RELATIVE PATH entry alone — it means the CHILD's cwd", () => {
    // `path.resolve` would resolve it against the ENGINE's cwd, which under a
    // script launch IS the launcher's repo — so direnv's `layout node` and a
    // plain `PATH="node_modules/.bin:$PATH"` were resolved onto a launcher bin
    // dir and eaten, breaking per-project tools inside Zeros and nowhere else.
    const env: Record<string, string> = {
      ...LAUNCHER,
      PATH: P("node_modules/.bin", `${ZEROS}/node_modules/.bin`, "/usr/bin"),
    };
    pruneLauncherScriptEnv(env);
    expect(env.PATH).toBe(P("node_modules/.bin", "/usr/bin"));
  });

  it("removes the launcher's PnP loader from NODE_OPTIONS, keeping the rest", () => {
    // Yarn berry's DEFAULT linker exports
    // NODE_OPTIONS=--require <launcher>/.pnp.cjs, so every `node` the engine
    // spawns boots another project's PnP runtime and module resolution in the
    // user's worktree fails outright, naming a file in a repo they aren't in.
    const env: Record<string, string> = {
      npm_execpath: "/x/yarn.cjs",
      PROJECT_CWD: ZEROS,
      NODE_OPTIONS: `--require ${ZEROS}/.pnp.cjs --max-old-space-size=8192`,
      PATH: "/usr/bin",
    };
    pruneLauncherScriptEnv(env);
    expect(env.NODE_OPTIONS).toBe("--max-old-space-size=8192");
  });

  it("deletes NODE_OPTIONS entirely when only launcher flags were in it", () => {
    const env: Record<string, string> = {
      npm_execpath: "/x/yarn.cjs",
      PROJECT_CWD: ZEROS,
      NODE_OPTIONS: `--require ${ZEROS}/.pnp.cjs`,
      PATH: "/usr/bin",
    };
    pruneLauncherScriptEnv(env);
    expect(env.NODE_OPTIONS).toBeUndefined();
  });

  it("does nothing at all when no script launched us", () => {
    const env: Record<string, string> = {
      npm_config_registry: "https://nexus.corp/npm/",
      PATH: P("/Users/me/proj/node_modules/.bin", "/usr/bin"),
    };
    pruneLauncherScriptEnv(env);
    expect(env.npm_config_registry).toBe("https://nexus.corp/npm/");
    expect(env.PATH).toBe(P("/Users/me/proj/node_modules/.bin", "/usr/bin"));
  });

  it("strips the launcher's node_modules/.bin from PATH", () => {
    const env: Record<string, string> = {
      ...LAUNCHER,
      PATH: P(`${ZEROS}/node_modules/.bin`, "/opt/homebrew/bin", "/usr/bin"),
    };
    pruneLauncherScriptEnv(env);
    // Otherwise `vite` in the USER's worktree could resolve to Zeros' copy.
    expect(env.PATH).toBe(P("/opt/homebrew/bin", "/usr/bin"));
  });
});

describe("stripLauncherBinFromPath — the launcher's bins, and only those", () => {
  it("leaves a project bin dir the USER put on PATH (direnv, profile)", () => {
    const userBin = "/Users/me/other-project/node_modules/.bin";
    const out = stripLauncherBinFromPath(
      P(`${ZEROS}/node_modules/.bin`, userBin, "/usr/bin"),
      LAUNCHER,
    );
    expect(out).toBe(P(userBin, "/usr/bin"));
  });

  it("also strips a workspace ROOT's bin dir (an ancestor of INIT_CWD)", () => {
    // pnpm prepends both `<pkg>/node_modules/.bin` and the workspace root's,
    // but only the leaf directory is named in the env.
    const out = stripLauncherBinFromPath(
      P(
        "/Users/me/zeros/packages/protocol/node_modules/.bin",
        "/Users/me/zeros/node_modules/.bin",
        "/usr/bin",
      ),
      { INIT_CWD: "/Users/me/zeros/packages/protocol" },
    );
    expect(out).toBe("/usr/bin");
  });

  it("tolerates trailing slashes and leaves unrelated dirs alone", () => {
    const out = stripLauncherBinFromPath(
      P(`${ZEROS}/node_modules/.bin/`, "/Users/me/.bin", "/usr/bin"),
      LAUNCHER,
    );
    expect(out).toBe(P("/Users/me/.bin", "/usr/bin"));
  });

  it("never returns an empty PATH", () => {
    const only = `${ZEROS}/node_modules/.bin`;
    expect(stripLauncherBinFromPath(only, LAUNCHER)).toBe(only);
  });

  it("is a no-op with no launcher roots to compare against", () => {
    const p = P("/a/node_modules/.bin", "/usr/bin");
    expect(stripLauncherBinFromPath(p, {})).toBe(p);
  });
});

describe("sanitizeProbedPath", () => {
  it("cleans a `$SHELL -ilc` result, which inherits our polluted env", () => {
    const probed = P(`${ZEROS}/node_modules/.bin`, "/usr/bin");
    const restore = { ...process.env };
    try {
      Object.assign(process.env, LAUNCHER);
      expect(sanitizeProbedPath(probed)).toBe("/usr/bin");
    } finally {
      for (const k of Object.keys(LAUNCHER)) delete process.env[k];
      Object.assign(process.env, restore);
    }
  });
});

describe("stripLauncherNodeOptions — surgical, not wholesale", () => {
  const roots = [ZEROS];

  it("keeps a --require of the USER's own file", () => {
    const v = "--require /Users/me/instrument.js";
    expect(stripLauncherNodeOptions(v, roots)).toBe(v);
  });

  it("handles both --flag=value and --flag value", () => {
    expect(
      stripLauncherNodeOptions(
        `--require=${ZEROS}/.pnp.cjs --trace-warnings`,
        roots,
      ),
    ).toBe("--trace-warnings");
    expect(
      stripLauncherNodeOptions(
        `--experimental-loader ${ZEROS}/l.mjs -r ${ZEROS}/p.cjs`,
        roots,
      ),
    ).toBe("");
  });

  it("leaves everything alone with no launcher roots to compare against", () => {
    const v = `--require ${ZEROS}/.pnp.cjs`;
    expect(stripLauncherNodeOptions(v, [])).toBe(v);
  });

  it("does not eat a dangling flag's worth of value", () => {
    // A malformed NODE_OPTIONS must come back unchanged rather than half-parsed.
    expect(
      stripLauncherNodeOptions("--max-old-space-size=4096 --require", roots),
    ).toBe("--max-old-space-size=4096 --require");
  });
});

describe("TOOLCHAIN_ENV_NAMES", () => {
  it("carries only path-shaped roots — never a credential-bearing name", () => {
    // This list is spread into both the setup-script allowlist and the
    // remote-shell allowlist, so a token-shaped name landing here would leak
    // to a paired device. The regex catches name SHAPES; these explicit denials
    // cover path-shaped names that are nonetheless a capability, not a location.
    for (const name of TOOLCHAIN_ENV_NAMES) {
      expect(name).not.toMatch(/TOKEN|KEY|SECRET|PASSWORD|AUTH|CREDENTIAL/i);
    }
    for (const forbidden of [
      "SSH_AUTH_SOCK", // an agent socket signs as the user (see setup-hooks.ts)
      "GPG_AGENT_INFO",
      "DOCKER_HOST",
      "KUBECONFIG",
      "AWS_CONFIG_FILE",
      "NPM_CONFIG_USERCONFIG",
    ]) {
      expect(
        (TOOLCHAIN_ENV_NAMES as readonly string[]).includes(forbidden),
        `${forbidden} must not be in the shared toolchain list`,
      ).toBe(false);
    }
    expect(TOOLCHAIN_ENV_NAMES).toContain("PNPM_HOME");
    expect(TOOLCHAIN_ENV_NAMES).toContain("NVM_DIR");
  });
});
