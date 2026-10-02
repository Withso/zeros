import {
  constants,
  createHash,
  generateKeyPairSync,
  privateEncrypt,
  sign,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const digestInfoError = /does not contain a valid RSASSA-PKCS1-v1_5 DigestInfo/;
const sha256 = (contents) =>
  createHash("sha256").update(contents).digest("hex");

function isMapping(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !Object.hasOwn(value, "<<")
  );
}

function readYamlMapping(filename, yaml) {
  let mapping;
  try {
    mapping = yaml.load(readFileSync(filename, "utf8"), {
      schema: yaml.CORE_SCHEMA,
      json: false,
    });
  } catch {
    throw new Error(`Forge patch guard: invalid YAML in ${basename(filename)}`);
  }
  if (!isMapping(mapping)) {
    throw new Error(`Forge patch guard: invalid YAML map in ${basename(filename)}`);
  }
  return mapping;
}

function forgeKeys(mapping) {
  return Object.keys(mapping).filter((key) => key.startsWith("node-forge@"));
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
  const rootRequire = createRequire(join(root, "package.json"));
  const yaml = rootRequire("js-yaml");
  const workspace = readYamlMapping(join(root, "pnpm-workspace.yaml"), yaml);
  if (
    !isMapping(workspace.patchedDependencies) ||
    workspace.patchedDependencies[packageKey] !== pin.patch
  ) {
    throw new Error("Forge patch guard: exact workspace patch binding missing");
  }
  const lock = readYamlMapping(join(root, "pnpm-lock.yaml"), yaml);
  const packageKeys = isMapping(lock.packages) ? forgeKeys(lock.packages) : [];
  const snapshotKeys = isMapping(lock.snapshots) ? forgeKeys(lock.snapshots) : [];
  const lockedPackage = lock.packages?.[packageKey];
  const lockedPatch = lock.patchedDependencies?.[packageKey];
  if (
    packageKeys.length !== 1 ||
    packageKeys[0] !== packageKey ||
    !isMapping(lockedPackage?.resolution) ||
    lockedPackage.resolution.integrity !== pin.tarballIntegrity ||
    snapshotKeys.length !== 1 ||
    snapshotKeys[0] !== `${packageKey}(patch_hash=${pin.patchSha256})` ||
    !isMapping(lock.patchedDependencies) ||
    !isMapping(lockedPatch) ||
    lockedPatch.hash !== pin.patchSha256 ||
    lockedPatch.path !== pin.patch
  ) {
    throw new Error(
      "Forge patch guard: lock contains an unreviewed Forge resolution",
    );
  }

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
