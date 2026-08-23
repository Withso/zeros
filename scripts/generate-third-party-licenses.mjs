#!/usr/bin/env node
// Generate the distributable third-party package inventory and license bundle.
//
// `pnpm licenses list` supplies the locked production graph. This script then
// normalizes host-specific optional packages to the macOS arm64 release target,
// reads the license and NOTICE files from the installed package archives,
// deduplicates identical documents, and includes a deterministic inventory for
// every resolved version. Run with `--check` in CI to reject lockfile changes
// that were not accompanied by a refreshed bundle.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = join(ROOT, "THIRD-PARTY-LICENSES.txt");
const CHECK = process.argv.includes("--check");
const ROOT_LOCKFILE = readFileSync(join(ROOT, "pnpm-lock.yaml"), "utf8");

// electron-builder.yml currently emits macOS arm64 artifacts only. pnpm
// installs optional native packages for the CI host, so a raw inventory would
// describe Linux on preflight and macOS on release. Replace every recognized
// host variant with the exact optional packages that enter the shipped app.
// Codex's platform package IS one of them: scripts/stage-codex-cli.mjs copies
// its whole vendor target into binaries/codex-runtime and electron-builder
// ships that through extraResources, so its native binaries are redistributed
// and must carry their terms.
const PACKAGED_DESKTOP_PLATFORM = "macOS arm64";
const PACKAGED_PLATFORM_PACKAGES = [
  {
    parentName: "@anthropic-ai/claude-agent-sdk",
    packageName: "@anthropic-ai/claude-agent-sdk-darwin-arm64",
    license: "SEE LICENSE IN LICENSE.md",
  },
  {
    parentName: "@cursor/sdk",
    packageName: "@cursor/sdk-darwin-arm64",
    license: "SEE LICENSE IN LICENSE.md",
  },
  {
    // Declared as an npm ALIAS (`npm:@openai/codex@<version>-darwin-arm64`),
    // so the dependency key is not the published package name — the resolver
    // below records the real `@openai/codex@…-darwin-arm64` identity.
    parentName: "@openai/codex",
    packageName: "@openai/codex-darwin-arm64",
    license: "Apache-2.0",
  },
  {
    parentName: "@vscode/ripgrep",
    packageName: "@vscode/ripgrep-darwin-arm64",
    license: "MIT",
  },
];

/** Version suffix npm's Codex platform aliases carry (`0.146.0-darwin-arm64`).
 *  Their package NAME stays `@openai/codex`, so the platform variant can only
 *  be told apart from the JS wrapper by this suffix. */
const CODEX_PLATFORM_VERSION = /-(?:darwin|linux|win32)-(?:arm64|x64|ia32)$/;

// These packages intentionally publish terms-governed license files instead
// of an SPDX identifier. New Unknown entries fail closed until reviewed.
const TERMS_GOVERNED_PACKAGES = new Map([
  [
    "@anthropic-ai/claude-agent-sdk",
    "Proprietary/terms-governed; redistribution and authentication flows require an explicit vendor/legal review.",
  ],
  [
    "@cursor/sdk",
    "Proprietary/terms-governed; redistribution and authentication flows require an explicit vendor/legal review.",
  ],
]);

const isTermsGovernedPackage = (name) =>
  TERMS_GOVERNED_PACKAGES.has(name) ||
  name.startsWith("@anthropic-ai/claude-agent-sdk-") ||
  name.startsWith("@cursor/sdk-");

// SPDX cannot express an npm `SEE LICENSE IN …` pointer. These references were
// reviewed and resolve to an open-source license file in the exact package
// archive. Keep this allowlist separate from proprietary vendor terms.
const REVIEWED_LICENSE_REFERENCES = new Map([
  ["posthog-js", "Apache-2.0 (exact package LICENSE file)"],
]);

const LICENSE_FILE =
  /^(?:licen[cs]e|copying|copyright|notice|ofl)(?:[-._].*)?$/i;

const normalizeText = (value) =>
  value
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t ]+$/g, ""))
    .join("\n")
    .trimEnd() + "\n";

const displayAuthor = (author) => {
  if (typeof author === "string") return author.trim();
  if (!author || typeof author !== "object") return "";
  return [author.name, author.email && `<${author.email}>`, author.url]
    .filter(Boolean)
    .join(" ");
};

const repositoryUrl = (pkg) => {
  const repository =
    typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  if (!repository) return pkg.homepage || "";
  let value = repository
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/^github:/, "https://github.com/")
    .replace(/^([\w.-]+\/[\w.-]+)$/, "https://github.com/$1")
    .replace(/\.git(?:#.*)?$/, "");
  if (/^https?:\/\/github\.com\//i.test(value)) {
    value = value.replace(/\/(?:tree|blob)\/[^/]+\/.*$/i, "");
  }
  return value;
};

const repositoryKey = (pkg) => repositoryUrl(pkg).toLowerCase();
const licenseKey = (license) => license.toLowerCase().replace(/\s+/g, "");

function runPnpmLicenseInventory(cwd, surface, { standalone = false } = {}) {
  const args = ["licenses", "list", "--prod", "--json"];
  if (standalone) args.unshift("--ignore-workspace");
  const stdout = execFileSync("pnpm", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const grouped = JSON.parse(stdout);
  const records = new Map();

  for (const packages of Object.values(grouped)) {
    for (const summary of packages) {
      for (const packagePath of summary.paths) {
        const manifestPath = join(packagePath, "package.json");
        if (!existsSync(manifestPath)) {
          throw new Error(
            `${summary.name}: package manifest is missing at ${manifestPath}`,
          );
        }
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        const version = String(manifest.version || "");
        if (!version) {
          throw new Error(`${summary.name}: installed package has no version`);
        }
        const key = `${manifest.name || summary.name}@${version}`;
        const previous = records.get(key);
        if (previous) {
          previous.surfaces.add(surface);
          continue;
        }
        records.set(key, {
          name: manifest.name || summary.name,
          version,
          license: String(manifest.license || summary.license || "Unknown"),
          author: displayAuthor(manifest.author || summary.author),
          homepage: String(manifest.homepage || summary.homepage || ""),
          repository: repositoryUrl(manifest),
          repositoryKey: repositoryKey(manifest),
          packagePath,
          surfaces: new Set([surface]),
          documentIds: [],
        });
      }
    }
  }
  return [...records.values()];
}

/** The Cloudflare web/auth deployment is intentionally an independent npm
 * root. npm lockfile v3 marks dev-only entries, so its installed production
 * graph can join the same exact package/license inventory without asking pnpm
 * to interpret a foreign lockfile. */
function runNpmLicenseInventory(cwd, surface) {
  const lockPath = join(cwd, "package-lock.json");
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  if (!lock.packages || typeof lock.packages !== "object") {
    throw new Error(`${lockPath}: expected an npm lockfile with package records`);
  }
  const records = new Map();
  for (const [relativePath, locked] of Object.entries(lock.packages)) {
    if (!relativePath || locked.dev === true) continue;
    const packagePath = join(cwd, relativePath);
    const manifestPath = join(packagePath, "package.json");
    if (!existsSync(manifestPath)) {
      throw new Error(
        `${relativePath}: production npm package is not installed at ${packagePath}`,
      );
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const name = String(manifest.name || locked.name || "");
    const version = String(manifest.version || locked.version || "");
    if (!name || !version) {
      throw new Error(`${relativePath}: installed npm package has no name/version`);
    }
    const key = `${name}@${version}`;
    const previous = records.get(key);
    if (previous) {
      previous.surfaces.add(surface);
      continue;
    }
    records.set(key, {
      name,
      version,
      license: String(manifest.license || locked.license || "Unknown"),
      author: displayAuthor(manifest.author),
      homepage: String(manifest.homepage || ""),
      repository: repositoryUrl(manifest),
      repositoryKey: repositoryKey(manifest),
      packagePath,
      surfaces: new Set([surface]),
      documentIds: [],
    });
  }
  return [...records.values()];
}

const isHostPlatformRecord = (record) =>
  record.name.startsWith("@anthropic-ai/claude-agent-sdk-") ||
  record.name.startsWith("@cursor/sdk-") ||
  record.name.startsWith("@vscode/ripgrep-") ||
  (record.name === "@openai/codex" &&
    CODEX_PLATFORM_VERSION.test(record.version));

/** Resolve an optionalDependencies entry to the identity it is PUBLISHED
 *  under. Most are plain versions, but Codex declares npm aliases
 *  (`@openai/codex-darwin-arm64: npm:@openai/codex@0.146.0-darwin-arm64`),
 *  where the dependency key names no real package — recording the key would
 *  put a name in the inventory that does not exist on the registry and cannot
 *  be matched against the lockfile. */
function resolvePlatformIdentity(target, spec) {
  const alias = /^npm:(@[^/]+\/[^@]+|[^@]+)@(.+)$/.exec(spec ?? "");
  return {
    name: alias ? alias[1] : target.packageName,
    version: alias ? alias[2] : spec,
  };
}

function normalizePackagedPlatformRecords(records) {
  const normalized = records.filter((record) => !isHostPlatformRecord(record));

  for (const target of PACKAGED_PLATFORM_PACKAGES) {
    const parent = normalized.find(
      (record) => record.name === target.parentName,
    );
    if (!parent) {
      throw new Error(
        `${target.parentName}: parent package is missing from the production inventory`,
      );
    }

    const manifest = JSON.parse(
      readFileSync(join(parent.packagePath, "package.json"), "utf8"),
    );
    const { name, version } = resolvePlatformIdentity(
      target,
      manifest.optionalDependencies?.[target.packageName],
    );
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+/.test(version)) {
      throw new Error(
        `${target.packageName}: exact optional dependency is missing from ${target.parentName}`,
      );
    }
    if (!ROOT_LOCKFILE.includes(`  '${name}@${version}':`)) {
      throw new Error(
        `${name}@${version}: release target is missing from pnpm-lock.yaml`,
      );
    }

    normalized.push({
      ...parent,
      name,
      version,
      license: target.license,
      surfaces: new Set([
        `desktop packaged runtime (${PACKAGED_DESKTOP_PLATFORM})`,
      ]),
      documentIds: [],
      documentSourceLabel: `${name}@${version} — terms supplied by ${parent.name}@${parent.version}`,
    });
  }

  return normalized;
}

function electronRuntimeRecord() {
  const packagePath = join(ROOT, "node_modules", "electron");
  const manifestPath = join(packagePath, "package.json");
  if (!existsSync(manifestPath)) {
    throw new Error(
      "Electron is not installed; run `pnpm install --frozen-lockfile` first.",
    );
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  return {
    name: manifest.name,
    version: String(manifest.version),
    license: String(manifest.license || "MIT"),
    author: displayAuthor(manifest.author),
    homepage: String(manifest.homepage || ""),
    repository: repositoryUrl(manifest),
    repositoryKey: repositoryKey(manifest),
    packagePath,
    surfaces: new Set(["desktop runtime"]),
    documentIds: [],
  };
}

function packageDocuments(record) {
  const files = readdirSync(record.packagePath)
    .filter((name) => LICENSE_FILE.test(name))
    .sort((a, b) => a.localeCompare(b));
  return files.map((name) => ({
    label: `${record.documentSourceLabel || `${record.name}@${record.version}`} — ${name}`,
    text: normalizeText(readFileSync(join(record.packagePath, name), "utf8")),
  }));
}

const mitTerms = (holder) => `MIT License

Copyright (c) ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

const bsd3Terms = (holder) => `BSD 3-Clause License

Copyright (c) ${holder}
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice,
   this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
`;

function fallbackDocuments(record) {
  const key = licenseKey(record.license);
  const holder = record.author || `the ${record.name} contributors`;
  const documents = [];

  if (key.includes("mit")) {
    documents.push({
      label: `${record.name}@${record.version} — declared MIT terms (archive omitted a standalone file)`,
      text: mitTerms(holder),
    });
  }
  if (key.includes("apache-2.0")) {
    const apachePath = join(
      ROOT,
      "apps/desktop/src/engine/agents/adapters/codex/generated/LICENSE",
    );
    if (!existsSync(apachePath)) {
      throw new Error("The canonical Apache-2.0 license copy is missing");
    }
    documents.push({
      label: `${record.name}@${record.version} — declared Apache-2.0 terms (archive omitted a standalone file)`,
      text: normalizeText(readFileSync(apachePath, "utf8")),
    });
  }
  if (key.includes("bsd-3-clause")) {
    documents.push({
      label: `${record.name}@${record.version} — declared BSD-3-Clause terms (archive omitted a standalone file)`,
      text: bsd3Terms(holder),
    });
  }

  if (documents.length === 0) {
    throw new Error(
      `${record.name}@${record.version} declares ${record.license} but its archive has no standalone license file. Add an exact reviewed fallback before release.`,
    );
  }
  return documents;
}

const rootRecords = normalizePackagedPlatformRecords(
  runPnpmLicenseInventory(ROOT, "root pnpm workspace"),
);
const controlPlaneRecords = runPnpmLicenseInventory(
  join(ROOT, "apps", "control-plane"),
  "control plane",
);
const marketingRecords = runPnpmLicenseInventory(
  join(ROOT, "apps", "marketing"),
  "marketing standalone deployment",
  { standalone: true },
);
const webRecords = runNpmLicenseInventory(
  join(ROOT, "apps", "web"),
  "web auth/session Worker",
);
const recordsByKey = new Map();
for (const record of [
  ...rootRecords,
  ...controlPlaneRecords,
  ...marketingRecords,
  ...webRecords,
  electronRuntimeRecord(),
]) {
  const key = `${record.name}@${record.version}`;
  const previous = recordsByKey.get(key);
  if (previous) {
    for (const surface of record.surfaces) previous.surfaces.add(surface);
  } else {
    recordsByKey.set(key, record);
  }
}
const records = [...recordsByKey.values()].sort((a, b) =>
  `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`),
);

for (const record of records) {
  const hasNonSpdxTerms =
    licenseKey(record.license) === "unknown" ||
    /^see license in\b/i.test(record.license);
  if (
    hasNonSpdxTerms &&
    !isTermsGovernedPackage(record.name) &&
    !REVIEWED_LICENSE_REFERENCES.has(record.name)
  ) {
    throw new Error(
      `${record.name}@${record.version} has an unreviewed Unknown license`,
    );
  }
}
for (const packageName of TERMS_GOVERNED_PACKAGES.keys()) {
  if (!records.some((record) => record.name === packageName)) {
    throw new Error(
      `Reviewed terms-governed package ${packageName} disappeared; update the legal inventory deliberately.`,
    );
  }
}
for (const packageName of REVIEWED_LICENSE_REFERENCES.keys()) {
  if (!records.some((record) => record.name === packageName)) {
    throw new Error(
      `Reviewed license-reference package ${packageName} disappeared; update the inventory deliberately.`,
    );
  }
}

const directDocuments = new Map();
for (const record of records) {
  const documents = packageDocuments(record);
  directDocuments.set(`${record.name}@${record.version}`, documents);
}

// Two different Codex artifacts ship, and NEITHER npm archive carries a
// standalone license file: the generated protocol bindings (in-tree) and the
// staged native runtime staged into Contents/Resources by
// scripts/stage-codex-cli.mjs. Both come from openai/codex under Apache-2.0,
// whose section 4(d) requires the NOTICE to travel with any redistribution, so
// pin the exact upstream LICENSE and NOTICE to each record.
const codexGeneratedDir = join(
  ROOT,
  "apps/desktop/src/engine/agents/adapters/codex/generated",
);
for (const codex of records.filter(
  (record) => record.name === "@openai/codex",
)) {
  const artifact = CODEX_PLATFORM_VERSION.test(codex.version)
    ? "staged native runtime"
    : "generated protocol";
  directDocuments.set(
    `${codex.name}@${codex.version}`,
    ["LICENSE", "NOTICE"].map((name) => ({
      label: `${codex.name}@${codex.version} ${artifact} — ${name}`,
      text: normalizeText(readFileSync(join(codexGeneratedDir, name), "utf8")),
    })),
  );
}

// Some monorepos publish a license once at repository root and omit it from
// leaf package archives. Reuse an exact document only when repository and
// declared license expression both match; otherwise use a labeled fallback.
const documentsByRepositoryLicense = new Map();
for (const record of records) {
  const documents = directDocuments.get(`${record.name}@${record.version}`);
  if (!record.repositoryKey || !documents?.length) continue;
  const key = `${record.repositoryKey}\0${licenseKey(record.license)}`;
  if (!documentsByRepositoryLicense.has(key)) {
    documentsByRepositoryLicense.set(key, documents);
  }
}

const documentsByHash = new Map();
const attachDocument = (record, document) => {
  const hash = createHash("sha256").update(document.text).digest("hex");
  let stored = documentsByHash.get(hash);
  if (!stored) {
    stored = {
      id: hash.slice(0, 12),
      hash,
      labels: new Set(),
      packages: new Set(),
      text: document.text,
    };
    documentsByHash.set(hash, stored);
  }
  stored.labels.add(document.label);
  stored.packages.add(`${record.name}@${record.version}`);
  record.documentIds.push(stored.id);
};

for (const record of records) {
  const direct = directDocuments.get(`${record.name}@${record.version}`) || [];
  const repositoryDocuments = documentsByRepositoryLicense.get(
    `${record.repositoryKey}\0${licenseKey(record.license)}`,
  );
  const documents = direct.length
    ? direct
    : repositoryDocuments?.length
      ? repositoryDocuments.map((document) => ({
          ...document,
          label: `${record.name}@${record.version} — repository-level copy from ${document.label}`,
        }))
      : fallbackDocuments(record);
  for (const document of documents) attachDocument(record, document);
  record.documentIds = [...new Set(record.documentIds)].sort();
}

const lines = [
  "ZEROS THIRD-PARTY LICENSE BUNDLE",
  "================================",
  "",
  "Generated by scripts/generate-third-party-licenses.mjs from the locked,",
  "installed production dependency graphs. Do not edit this file manually.",
  "Refresh it with: pnpm licenses:generate",
  "",
  "Scope",
  "-----",
  "This inventory covers production packages resolved by the root pnpm",
  "workspace (desktop, shared packages, and the development marketing graph),",
  "the independently locked control plane, the standalone marketing graph",
  "deployed by Cloudflare, the independently locked web auth/session Worker,",
  "and the Electron runtime embedded in the desktop application. Optional",
  "JavaScript dependencies are included. Host-native optional packages are",
  "normalized to the macOS arm64",
  "release contents: the staged Claude runtime, the staged Codex runtime, the",
  "packaged Cursor runtime, and the packaged ripgrep binary are all included.",
  "Electron's distribution also carries its Chromium notices",
  "file. See THIRD-PARTY-NOTICES.md for the vendor release requirements.",
  "",
  "A package archive that omitted a standalone license file is explicitly",
  "labeled below and paired with the terms declared by its package metadata.",
  "This generated inventory is a compliance aid, not legal advice or proof that",
  "a vendor grants redistribution rights beyond its stated terms.",
  "",
  "TERMS-GOVERNED COMPONENTS — RELEASE REVIEW REQUIRED",
  "----------------------------------------------------",
];

for (const [name, warning] of TERMS_GOVERNED_PACKAGES) {
  const versions = records
    .filter((record) => record.name === name)
    .map((record) => record.version)
    .sort();
  lines.push(`- ${name}@${versions.join(", ")}: ${warning}`);
}

lines.push(
  "",
  `PACKAGE INVENTORY (${records.length} resolved package/version records)`,
  "-----------------",
  "",
);
for (const record of records) {
  lines.push(`${record.name}@${record.version}`);
  lines.push(`  License: ${record.license}`);
  lines.push(`  Surfaces: ${[...record.surfaces].sort().join(", ")}`);
  if (record.author) lines.push(`  Author: ${record.author}`);
  const source = record.repository || record.homepage;
  if (source) lines.push(`  Source: ${source}`);
  lines.push(`  License documents: ${record.documentIds.join(", ")}`);
  lines.push("");
}

const documents = [...documentsByHash.values()].sort((a, b) =>
  a.id.localeCompare(b.id),
);
lines.push(
  `LICENSE AND NOTICE TEXTS (${documents.length} unique documents)`,
  "------------------------",
  "",
);
for (const document of documents) {
  lines.push("=".repeat(80));
  lines.push(`DOCUMENT ${document.id}`);
  lines.push(`SHA-256: ${document.hash}`);
  lines.push(`Applies to: ${[...document.packages].sort().join(", ")}`);
  lines.push(`Source labels: ${[...document.labels].sort().join("; ")}`);
  lines.push("=".repeat(80));
  lines.push("");
  lines.push(document.text.trimEnd());
  lines.push("");
}

const output = `${lines.join("\n").trimEnd()}\n`;
if (CHECK) {
  if (!existsSync(OUTPUT) || readFileSync(OUTPUT, "utf8") !== output) {
    console.error(
      "✖ THIRD-PARTY-LICENSES.txt is stale. Run `pnpm licenses:generate` and commit the result.",
    );
    process.exit(1);
  }
  console.log(
    `✓ third-party license bundle is current (${records.length} package/version records, ${documents.length} unique documents)`,
  );
} else {
  writeFileSync(OUTPUT, output);
  console.log(
    `Wrote THIRD-PARTY-LICENSES.txt (${records.length} package/version records, ${documents.length} unique documents)`,
  );
}
