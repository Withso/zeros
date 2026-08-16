// Tests for the CLI auth probes — specifically the OAuth
// refresh-token-presence path for OAuth-credential-file sign-in detection.
//
// Regression context (2026-05-31): an OAuth-credential-file probe used to be
// a bare `file-with-expiry` on ~/.gemini/oauth_creds.json's
// `expiry_date`. But `expiry_date` is the SHORT-LIVED access-token
// expiry (~1h), not the sign-in lifetime — the CLI refreshes the access
// token from the long-lived `refresh_token` on demand. So the probe
// reported "signed out" every hour even though the user was fully
// authenticated, forcing a needless re-sign-in on each app open. The
// fix: treat a non-empty `refresh_token` as the durable signed-in
// signal (new `file-with-field` probe kind), with the expiry check kept
// only as a defensive fast path. These tests pin that behaviour so a
// future refactor breaks the suite, not the user's sign-in.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  clearVersionCache,
  evaluateAuthProbe,
  isOnPath,
  latestAuthFileMtimeMs,
  probeCliVersion,
  type ProbeCommandRunner,
} from "../probes";
import { findAgent, type AuthProbe } from "../registry";

const HOUR_MS = 60 * 60_000;

let dir = "";
let credPath = "";

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "zeros-probes-"));
  credPath = path.join(dir, "oauth_creds.json");
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function writeCreds(obj: unknown): Promise<void> {
  await writeFile(credPath, JSON.stringify(obj), "utf-8");
}

describe("CLI executable discovery", () => {
  it("accepts an explicit absolute executable outside PATH", async () => {
    const binary = path.join(dir, "custom-provider");
    await writeFile(binary, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(binary, 0o755);
    await expect(isOnPath(binary)).resolves.toBe(true);
  });
});

/** An any-of OAuth-credential-file probe (refresh-token presence OR expiry),
 *  pointed at a temp file instead of a real credentials path. */
function oauthCredentialProbe(): AuthProbe {
  return {
    kind: "any-of",
    probes: [
      { kind: "file-with-field", path: credPath, fieldPath: ["refresh_token"] },
      {
        kind: "file-with-expiry",
        path: credPath,
        expiryFieldPath: ["expiry_date"],
        expiryUnit: "ms",
      },
    ],
  };
}

describe("file-with-field probe", () => {
  it("is authenticated when the field is a non-empty string", async () => {
    await writeCreds({ refresh_token: "1//long-lived-refresh-token" });
    const probe: AuthProbe = {
      kind: "file-with-field",
      path: credPath,
      fieldPath: ["refresh_token"],
    };
    expect(await evaluateAuthProbe(probe)).toBe(true);
  });

  it("is NOT authenticated when the field is an empty string", async () => {
    await writeCreds({ refresh_token: "" });
    const probe: AuthProbe = {
      kind: "file-with-field",
      path: credPath,
      fieldPath: ["refresh_token"],
    };
    expect(await evaluateAuthProbe(probe)).toBe(false);
  });

  it("is NOT authenticated when the field is missing", async () => {
    await writeCreds({ access_token: "abc" });
    const probe: AuthProbe = {
      kind: "file-with-field",
      path: credPath,
      fieldPath: ["refresh_token"],
    };
    expect(await evaluateAuthProbe(probe)).toBe(false);
  });

  it("is NOT authenticated when the file is missing", async () => {
    const probe: AuthProbe = {
      kind: "file-with-field",
      path: path.join(dir, "does-not-exist.json"),
      fieldPath: ["refresh_token"],
    };
    expect(await evaluateAuthProbe(probe)).toBe(false);
  });

  it("is NOT authenticated when the JSON is malformed", async () => {
    await writeFile(credPath, "{ not valid json", "utf-8");
    const probe: AuthProbe = {
      kind: "file-with-field",
      path: credPath,
      fieldPath: ["refresh_token"],
    };
    expect(await evaluateAuthProbe(probe)).toBe(false);
  });

  it("walks a nested field path", async () => {
    await writeCreds({ tokens: { refresh: "present" } });
    const probe: AuthProbe = {
      kind: "file-with-field",
      path: credPath,
      fieldPath: ["tokens", "refresh"],
    };
    expect(await evaluateAuthProbe(probe)).toBe(true);
  });
});

describe("OAuth credential-file sign-in detection (regression)", () => {
  it("stays signed in with an EXPIRED access token but present refresh_token", async () => {
    // This is the exact failing case: the CLI minted an access token an hour
    // ago, it has since lapsed, but the refresh_token is still on disk —
    // the user is signed in. The old bare-expiry probe returned false
    // here, which is the bug.
    await writeCreds({
      access_token: "stale",
      refresh_token: "1//still-valid-refresh-token",
      expiry_date: Date.now() - HOUR_MS, // expired an hour ago
    });
    expect(await evaluateAuthProbe(oauthCredentialProbe())).toBe(true);
  });

  it("is signed in with an unexpired access token (defensive fast path)", async () => {
    await writeCreds({
      access_token: "fresh",
      expiry_date: Date.now() + HOUR_MS, // valid for another hour
      // no refresh_token — exercises the expiry fallback branch
    });
    expect(await evaluateAuthProbe(oauthCredentialProbe())).toBe(true);
  });

  it("is signed OUT when there is no refresh_token and the access token expired", async () => {
    await writeCreds({
      access_token: "stale",
      expiry_date: Date.now() - HOUR_MS,
    });
    expect(await evaluateAuthProbe(oauthCredentialProbe())).toBe(false);
  });

  it("is signed OUT when the credentials file is absent", async () => {
    // credPath never written
    expect(await evaluateAuthProbe(oauthCredentialProbe())).toBe(false);
  });
});

describe("latestAuthFileMtimeMs", () => {
  it("returns the credential file mtime for a file-with-field probe", async () => {
    await writeCreds({ refresh_token: "present" });
    const probe: AuthProbe = {
      kind: "file-with-field",
      path: credPath,
      fieldPath: ["refresh_token"],
    };
    const mtime = await latestAuthFileMtimeMs(probe);
    expect(mtime).toBeGreaterThan(0);
  });

  it("returns 0 when the file-with-field credential file is missing", async () => {
    const probe: AuthProbe = {
      kind: "file-with-field",
      path: path.join(dir, "nope.json"),
      fieldPath: ["refresh_token"],
    };
    expect(await latestAuthFileMtimeMs(probe)).toBe(0);
  });
});

// secret-account backs API-key agents (Cursor's @cursor/sdk authenticates
// via CURSOR_API_KEY in the encrypted secret store, never a CLI dotfile).
// Regression context (2026-05-31): Cursor defaulted to API-key auth but its
// probe only checked CLI OAuth artifacts, so the default user's Agents-panel
// dot stayed gray "Not signed in" even when fully configured. The fix points
// the probe at the secret store the Electron shell hands over via
// ZEROS_SECRETS_FILE — checking KEY-PRESENCE only, never decrypting.
describe("secret-account probe", () => {
  let sdir = "";
  let secretsPath = "";
  const ORIGINAL_ENV = process.env.ZEROS_SECRETS_FILE;

  beforeEach(async () => {
    sdir = await mkdtemp(path.join(tmpdir(), "zeros-secrets-"));
    secretsPath = path.join(sdir, "secrets.json");
  });

  afterEach(async () => {
    if (ORIGINAL_ENV === undefined) delete process.env.ZEROS_SECRETS_FILE;
    else process.env.ZEROS_SECRETS_FILE = ORIGINAL_ENV;
    if (sdir) await rm(sdir, { recursive: true, force: true });
  });

  const probe: AuthProbe = {
    kind: "secret-account",
    account: "cursor-api-key",
  };

  async function writeSecrets(obj: unknown): Promise<void> {
    await writeFile(secretsPath, JSON.stringify(obj), "utf-8");
  }

  it("is authenticated when the account has a non-empty value", async () => {
    // Base64 of the literal string "encrypted-blob".
    await writeSecrets({ "cursor-api-key": "ZW5jcnlwdGVkLWJsb2I=" }); // gitleaks:allow
    process.env.ZEROS_SECRETS_FILE = secretsPath;
    expect(await evaluateAuthProbe(probe)).toBe(true);
  });

  it("checks key-presence only — never decodes the stored value", async () => {
    // The real store holds an encrypted base64 blob; the probe must accept
    // any non-empty string without decrypting it.
    await writeSecrets({ "cursor-api-key": "not-real-base64-or-cipher" });
    process.env.ZEROS_SECRETS_FILE = secretsPath;
    expect(await evaluateAuthProbe(probe)).toBe(true);
  });

  it("is NOT authenticated when the account is absent", async () => {
    await writeSecrets({ "openai-api-key": "x" });
    process.env.ZEROS_SECRETS_FILE = secretsPath;
    expect(await evaluateAuthProbe(probe)).toBe(false);
  });

  it("is NOT authenticated when the account value is an empty string", async () => {
    await writeSecrets({ "cursor-api-key": "" });
    process.env.ZEROS_SECRETS_FILE = secretsPath;
    expect(await evaluateAuthProbe(probe)).toBe(false);
  });

  it("is NOT authenticated when ZEROS_SECRETS_FILE is unset", async () => {
    await writeSecrets({ "cursor-api-key": "present" });
    delete process.env.ZEROS_SECRETS_FILE;
    expect(await evaluateAuthProbe(probe)).toBe(false);
  });

  it("is NOT authenticated when the secrets file is missing", async () => {
    process.env.ZEROS_SECRETS_FILE = path.join(sdir, "nope.json");
    expect(await evaluateAuthProbe(probe)).toBe(false);
  });

  it("is NOT authenticated when the secrets JSON is malformed", async () => {
    await writeFile(secretsPath, "{ not valid json", "utf-8");
    process.env.ZEROS_SECRETS_FILE = secretsPath;
    expect(await evaluateAuthProbe(probe)).toBe(false);
  });

  it("latestAuthFileMtimeMs returns 0 (TTL-only invalidation)", async () => {
    await writeSecrets({ "cursor-api-key": "present" });
    process.env.ZEROS_SECRETS_FILE = secretsPath;
    expect(await latestAuthFileMtimeMs(probe)).toBe(0);
  });

  it("any-of short-circuits true on the secret even if CLI probes fail", async () => {
    await writeSecrets({ "cursor-api-key": "present" });
    process.env.ZEROS_SECRETS_FILE = secretsPath;
    const anyOf: AuthProbe = {
      kind: "any-of",
      probes: [
        { kind: "secret-account", account: "cursor-api-key" },
        { kind: "file", paths: [path.join(sdir, "does-not-exist")] },
        { kind: "command", binary: "definitely-not-a-real-binary", args: [] },
      ],
    };
    expect(await evaluateAuthProbe(anyOf)).toBe(true);
  });
});

describe("Cursor manifest entry shape", () => {
  // Cursor runs on the bundled @cursor/sdk, which authenticates via the
  // Cursor API key only (cursor-api-key secret / CURSOR_API_KEY). There is no
  // `cursor-agent login` session in the run path, so the probe is a single
  // secret-account check — no file or subprocess probes.
  it("uses an API-key-only secret-account probe", () => {
    const entry = findAgent("cursor");
    expect(entry).toBeTruthy();
    const probe = entry!.authProbe;
    expect(probe.kind).toBe("secret-account");
    if (probe.kind !== "secret-account") throw new Error("expected secret-account");
    expect(probe.account).toBe("cursor-api-key");
  });
});

describe("contained command probes", () => {
  it("delegates command auth and version execution to the supplied runner", async () => {
    const run = vi
      .fn<ProbeCommandRunner["run"]>()
      .mockResolvedValueOnce({ exitCode: 0, stdout: "signed in\n" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "probe 9.8.7\n" });
    const runner: ProbeCommandRunner = {
      cacheKey: "contained-test",
      run,
    };
    const binary = "definitely-not-on-the-host-path-contained-probe";
    clearVersionCache();

    expect(
      await evaluateAuthProbe(
        { kind: "command", binary, args: ["login", "status"] },
        runner,
      ),
    ).toBe(true);
    expect(await probeCliVersion(binary, runner)).toBe("9.8.7");
    expect(run).toHaveBeenNthCalledWith(1, binary, ["login", "status"], {
      timeoutMs: 5_000,
    });
    expect(run).toHaveBeenNthCalledWith(2, binary, ["--version"], {
      timeoutMs: 8_000,
    });
  });
});
