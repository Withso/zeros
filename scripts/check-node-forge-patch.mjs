import {
  constants,
  createHash,
  generateKeyPairSync,
  privateEncrypt,
  sign,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const digestInfoError = /does not contain a valid RSASSA-PKCS1-v1_5 DigestInfo/;
const sha256 = (contents) =>
  createHash("sha256").update(contents).digest("hex");

function lockSection(lock, name) {
  return lock.split(`\n${name}:\n`)[1]?.split(/\n\S/)[0] ?? "";
}

function forgeKeys(section) {
  return [...section.matchAll(/^ {2}(node-forge@[^\n:]+):/gm)].map(
    (match) => match[1],
  );
}

function verifyInstalledVerifier(forge) {
  const message = Buffer.from("installed Forge security self-test");
  const digest = createHash("sha256").update(message).digest();
  const keyPair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicExponent: 3,
  });
  const publicKey = forge.pki.publicKeyFromPem(
    keyPair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  );
  const sequence = (elements) => {
    const contents = Buffer.concat(elements);
    return Buffer.concat([Buffer.from([0x30, contents.length]), contents]);
  };
  const oid = Buffer.from("0609608648016503040201", "hex");
  const parameters = Buffer.from([0x05, 0x00]);
  const garbage = Buffer.from([0x04, 0x01, 0x00]);
  const signatureFor = (elements) =>
    privateEncrypt(
      { key: keyPair.privateKey, padding: constants.RSA_PKCS1_PADDING },
      sequence([
        sequence(elements),
        Buffer.concat([Buffer.from([0x04, digest.length]), digest]),
      ]),
    ).toString("binary");

  for (const signature of [
    sign("sha256", message, keyPair.privateKey).toString("binary"),
    signatureFor([oid]),
  ]) {
    if (publicKey.verify(digest.toString("binary"), signature) !== true) {
      throw new Error("Forge patch guard: valid RSA verification failed");
    }
  }

  for (const elements of [
    [oid, parameters, garbage],
    [oid, garbage],
    [oid, parameters, parameters],
    [oid, parameters, sequence([garbage])],
  ]) {
    let rejected = false;
    try {
      publicKey.verify(digest.toString("binary"), signatureFor(elements));
    } catch (error) {
      if (!digestInfoError.test(error.message)) throw error;
      rejected = true;
    }
    if (!rejected) {
      throw new Error(
        "Forge patch guard: extra DigestAlgorithm elements accepted",
      );
    }
  }
}

export function verifyNodeForgePatch({ root = ROOT } = {}) {
  const pin = JSON.parse(
    readFileSync(join(root, "scripts/node-forge-patch.json"), "utf8"),
  );
  if (
    pin.package !== "node-forge" ||
    pin.version !== "1.4.0" ||
    pin.selectedLicense !== "BSD-3-Clause" ||
    pin.advisory !== "GHSA-86w9-cpqp-85rv"
  ) {
    throw new Error("Forge patch guard: unreviewed provenance");
  }
  if (sha256(readFileSync(join(root, pin.patch))) !== pin.patchSha256) {
    throw new Error("Forge patch guard: reviewed patch digest changed");
  }
  const packageKey = `${pin.package}@${pin.version}`;
  const workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
  if (!workspace.includes(`\n  "${packageKey}": ${pin.patch}\n`)) {
    throw new Error("Forge patch guard: exact workspace patch binding missing");
  }
  const lock = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
  const packages = lockSection(lock, "packages");
  const snapshots = lockSection(lock, "snapshots");
  const packageKeys = forgeKeys(packages);
  const snapshotKeys = forgeKeys(snapshots);
  const packageBlock = packages.match(
    /^ {2}node-forge@[^\n:]+:\n(?: {4}[^\n]*\n)*/m,
  )?.[0];
  if (
    packageKeys.length !== 1 ||
    packageKeys[0] !== packageKey ||
    !packageBlock?.includes(
      `resolution: {integrity: ${pin.tarballIntegrity}}`,
    ) ||
    snapshotKeys.length !== 1 ||
    snapshotKeys[0] !== `${packageKey}(patch_hash=${pin.patchSha256})` ||
    !lockSection(lock, "patchedDependencies").includes(
      `  ${packageKey}:\n    hash: ${pin.patchSha256}\n    path: ${pin.patch}\n`,
    )
  ) {
    throw new Error(
      "Forge patch guard: lock contains an unreviewed Forge resolution",
    );
  }

  const rootRequire = createRequire(join(root, "package.json"));
  const sandboxRequire = createRequire(
    rootRequire.resolve("@anthropic-ai/sandbox-runtime"),
  );
  const installed = sandboxRequire("node-forge/package.json");
  if (installed.version !== pin.version || installed.license !== pin.license) {
    throw new Error("Forge patch guard: installed version or license differs");
  }
  if (
    sha256(readFileSync(sandboxRequire.resolve("node-forge/lib/rsa.js"))) !==
    pin.installedRsaSha256
  ) {
    throw new Error(
      "Forge patch guard: installed RSA verifier is not the reviewed backport",
    );
  }
  verifyInstalledVerifier(sandboxRequire("node-forge"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  verifyNodeForgePatch();
  console.log(
    "✓ node-forge backport — provenance, installed bytes and RSA regression verified",
  );
}
