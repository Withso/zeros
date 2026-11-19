#!/usr/bin/env electron
"use strict";

// No-model native Cursor admission using the exact encrypted credential Zeros Dev
// uses. A plain Node process cannot decrypt Electron safeStorage, which made
// prior standalone smokes prove only key presence or a caller-exported key.
// This main-process harness keeps the plaintext in memory, passes it directly
// to the ordinary live-agent smoke child, and never prints or writes it.

const { app, safeStorage } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const MAX_SECRETS_FILE_BYTES = 1024 * 1024;
const CHILD_TIMEOUT_MS = 210_000;
const CURSOR_ACCOUNT = "cursor-api-key";

function readEncryptedCursorCredential(file) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  let fd;
  try {
    fd = fs.openSync(file, flags);
    const metadata = fs.fstatSync(fd);
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      metadata.size <= 0 ||
      metadata.size > MAX_SECRETS_FILE_BYTES ||
      (typeof process.getuid === "function" &&
        metadata.uid !== process.getuid()) ||
      (metadata.mode & 0o022) !== 0
    ) {
      throw new Error("the encrypted secret store has unsafe metadata");
    }
    const raw = fs.readFileSync(fd, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("the encrypted secret store is malformed");
    }
    const encoded = parsed[CURSOR_ACCOUNT];
    if (typeof encoded !== "string" || encoded.length === 0) {
      throw new Error("no Cursor API key is saved in Zeros Dev");
    }
    return encoded;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function runAdmission(apiKey, secretsFile) {
  return new Promise((resolve, reject) => {
    const childEnv = {
      ...process.env,
      CURSOR_API_KEY: apiKey,
      ZEROS_SECRETS_FILE: secretsFile,
    };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    const node = process.env.npm_node_execpath || "node";
    const child = spawn(
      node,
      [
        path.join(ROOT, "scripts", "agent-smoke.mjs"),
        "--admission-only",
        "--agents",
        "cursor",
        "--require",
        "cursor",
        "--admission-copies",
        "2",
      ],
      {
        cwd: ROOT,
        env: childEnv,
        stdio: "inherit",
        detached: true,
      },
    );
    let settled = false;
    let timeoutError;
    const finish = (error, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(forceKill);
      if (error) reject(error);
      else resolve(code ?? 1);
    };
    let forceKill;
    const timeout = setTimeout(() => {
      timeoutError = new Error("Cursor stored-credential admission timed out");
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // The child may have exited between the timer and signal.
      }
      forceKill = setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // Already gone.
        }
        finish(timeoutError);
      }, 5_000);
      forceKill.unref();
    }, CHILD_TIMEOUT_MS);
    timeout.unref();
    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => {
      if (timeoutError) {
        finish(timeoutError);
      } else if (signal) {
        finish(new Error(`Cursor admission child exited via ${signal}`));
      } else {
        finish(undefined, code ?? 1);
      }
    });
  });
}

if (process.platform !== "darwin") {
  console.error("✗ cursor:smoke:stored-admission requires macOS safeStorage");
  process.exit(1);
}

// safeStorage's macOS Keychain identity follows the channel-level app name.
// Match apps/desktop/electron/main.ts exactly; never use the worktree label.
app.setName("Zeros Dev");
app.setPath(
  "userData",
  fs.mkdtempSync(path.join(os.tmpdir(), "zeros-cursor-admission-electron-")),
);
app.disableHardwareAcceleration();

app
  .whenReady()
  .then(async () => {
    const temporaryUserData = app.getPath("userData");
    let exitCode = 1;
    try {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error("macOS Keychain encryption is unavailable");
      }
      const secretsFile =
        process.env.ZEROS_SECRETS_FILE ||
        path.join(
          os.homedir(),
          "Library",
          "Application Support",
          "com.zeros.dev",
          "secrets.json",
        );
      const encrypted = readEncryptedCursorCredential(secretsFile);
      let apiKey;
      try {
        apiKey = safeStorage
          .decryptString(Buffer.from(encrypted, "base64"))
          .trim();
      } catch {
        throw new Error("the saved Cursor API key could not be decrypted");
      }
      if (!apiKey || apiKey.includes("\0")) {
        throw new Error("the saved Cursor API key could not be decrypted");
      }
      console.log(
        "── Zeros Dev stored Cursor credential · no-model native admission ──",
      );
      exitCode = await runAdmission(apiKey, secretsFile);
    } catch (error) {
      console.error(
        `✗ ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      fs.rmSync(temporaryUserData, { recursive: true, force: true });
      app.exit(exitCode);
    }
  })
  .catch((error) => {
    console.error(
      `✗ Electron safeStorage startup failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    app.exit(1);
  });
