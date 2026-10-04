import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ActiveRuntimeDescriptorSchema,
  BaseCompatibilitySchema,
  ClosedDiagnosticSchema,
  RuntimeBaseStatusSchema,
  RuntimeDescriptorSchema,
  RuntimeInstallInputSchema,
  RuntimeInstallReceiptSchema,
  RuntimeManifestSchema,
  RuntimeRelativePathSchema,
  RuntimeInstallerCheckSchema,
  RuntimeInstallerStageSchema,
  parseCanonicalManifest,
  runtimeIdFromManifestSha256,
} from "../cloud-runtime-bundle";

const fixtureDirectory = new URL("./fixtures/cloud-runtime/", import.meta.url);
const readBytes = (file: string) =>
  readFileSync(new URL(file, fixtureDirectory));
const read = (file: string): Record<string, any> =>
  JSON.parse(readBytes(file).toString("utf8"));
const catalog = read("cases.json") as {
  cases: {
    contract: string;
    file: string;
    valid: boolean;
    manifestSha256?: string;
  }[];
};
const schemas = {
  "active-runtime": ActiveRuntimeDescriptorSchema,
  "base-compatibility": BaseCompatibilitySchema,
  "base-status": RuntimeBaseStatusSchema,
  descriptor: RuntimeDescriptorSchema,
  diagnostic: ClosedDiagnosticSchema,
  install: RuntimeInstallInputSchema,
  receipt: RuntimeInstallReceiptSchema,
};

describe("shared runtime golden fixtures", () => {
  for (const fixture of catalog.cases) {
    it(`${fixture.valid ? "accepts" : "rejects"} ${fixture.file}`, () => {
      if (fixture.contract === "manifest") {
        const raw = readBytes(fixture.file);
        expect(createHash("sha256").update(raw).digest("hex")).toBe(
          fixture.manifestSha256,
        );
        const parse = () => parseCanonicalManifest(raw, fixture.manifestSha256);
        if (fixture.valid)
          expect(parse()).toMatchObject({
            manifestSha256: fixture.manifestSha256,
            runtimeId: `r1-${fixture.manifestSha256}`,
          });
        else expect(parse).toThrow();
      } else {
        const schema = schemas[fixture.contract as keyof typeof schemas];
        expect(schema, "Every fixture contract has a consumer").toBeDefined();
        expect(schema.safeParse(read(fixture.file)).success).toBe(
          fixture.valid,
        );
      }
    });
  }
});

describe("runtime manifest identity and canonical bytes", () => {
  const raw = readBytes("manifest.valid.json");
  const digest = createHash("sha256").update(raw).digest("hex");

  it("derives identity from the original bytes and rejects an admitted digest mismatch", () => {
    expect(runtimeIdFromManifestSha256(digest)).toBe(`r1-${digest}`);
    expect(parseCanonicalManifest(raw).manifestSha256).toBe(digest);
    expect(() => parseCanonicalManifest(raw, "0".repeat(64))).toThrow(
      "digest mismatch",
    );
    for (const invalid of [
      digest.toUpperCase(),
      ` ${digest}`,
      digest.slice(1),
      `r1-${digest}`,
    ])
      expect(() => runtimeIdFromManifestSha256(invalid)).toThrow();
  });

  it("rejects byte differences even if JSON.parse would produce the same document", () => {
    for (const file of [
      "manifest.invalid-newline.json",
      "manifest.invalid-key-order.json",
      "manifest.invalid-duplicate-key.json",
      "manifest.invalid-escaped-key.json",
      "manifest.invalid-exponent.json",
    ]) {
      const altered = readBytes(file);
      expect(JSON.parse(altered.toString("utf8"))).toEqual(
        JSON.parse(raw.toString("utf8")),
      );
      expect(() => parseCanonicalManifest(altered, digest)).toThrow(
        "digest mismatch",
      );
      expect(() => parseCanonicalManifest(altered)).toThrow("canonical");
    }
  });

  it("rejects malformed UTF-8 and byte order marks", () => {
    expect(() => parseCanonicalManifest(new Uint8Array([0xff]))).toThrow();
    expect(() =>
      parseCanonicalManifest(
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), raw]),
      ),
    ).toThrow();
  });

  it("validates strict relative paths without normalizing them", () => {
    for (const valid of [
      "bin/node",
      "worker/node_modules/.pnpm/a@1.0.0",
      "worker/é",
      "worker/😀",
    ])
      expect(RuntimeRelativePathSchema.safeParse(valid).success).toBe(true);
    for (const invalid of [
      "",
      "/bin/node",
      "bin/",
      "bin//node",
      ".",
      "..",
      "bin/./node",
      "bin/../node",
      "bin\\node",
      "C:/node",
      "bin/\0node",
      "bin/\ud800",
    ])
      expect(RuntimeRelativePathSchema.safeParse(invalid).success).toBe(false);
  });

  it("orders paths by UTF-8 bytes, independently of locale and UTF-16 order", () => {
    const manifest = read("manifest.valid.json");
    manifest.files.push({
      mode: "0555",
      path: "worker/\ue000",
      sha256: digest,
      size: 1,
      type: "file",
    });
    manifest.files.push({
      mode: "0555",
      path: "worker/😀",
      sha256: digest,
      size: 1,
      type: "file",
    });
    expect(RuntimeManifestSchema.safeParse(manifest).success).toBe(true);
    manifest.files.reverse();
    expect(RuntimeManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it("rejects unknown entry fields, hard links, unsafe modes and unsafe sizes", () => {
    for (const entry of [
      { type: "hardlink", path: "bin/alias", target: "bin/node" },
      {
        type: "file",
        mode: "0555",
        path: "bin/node",
        size: 1,
        sha256: digest,
        extra: true,
      },
      { type: "symlink", path: "bin/alias", target: "node", mode: "0777" },
      {
        type: "file",
        mode: "0555",
        path: "bin/node",
        size: Number.MAX_SAFE_INTEGER + 1,
        sha256: digest,
      },
    ]) {
      const manifest = read("manifest.valid.json");
      manifest.files[1] = entry;
      expect(RuntimeManifestSchema.safeParse(manifest).success).toBe(false);
    }
  });
});

describe("runtime trust-boundary documents", () => {
  it("returns validation failures rather than throwing for malformed digest and URL fields", () => {
    const descriptor = read("descriptor.valid.json");
    descriptor.manifestSha256 = "invalid";
    expect(RuntimeDescriptorSchema.safeParse(descriptor).success).toBe(false);
    const install = read("install.valid-build.json");
    install.artifact.url = "invalid";
    expect(RuntimeInstallInputSchema.safeParse(install).success).toBe(false);
  });

  it("bounds the encoded installer input including multibyte setup content", () => {
    const install = read("install.valid-workspace.json");
    install.setup = "x".repeat(64 * 1024);
    expect(RuntimeInstallInputSchema.safeParse(install).success).toBe(false);
    install.setup = "😀".repeat(16 * 1024);
    expect(RuntimeInstallInputSchema.safeParse(install).success).toBe(false);
  });

  it("rejects artifact userinfo and fragments while leaving host/expiry admission to the base", () => {
    const install = read("install.valid-build.json");
    for (const url of [
      "https://user:password@example.test/archive",
      "https://example.test/archive#fragment",
      "file:///archive",
    ])
      expect(
        RuntimeInstallInputSchema.safeParse({
          ...install,
          artifact: { ...install.artifact, url },
        }).success,
      ).toBe(false);
  });

  it("keeps diagnostics closed and installer names enumerated", () => {
    const diagnostic = read("diagnostic.valid.json");
    expect(RuntimeInstallerStageSchema.options).toHaveLength(14);
    expect(RuntimeInstallerCheckSchema.options).toHaveLength(27);
    for (const altered of [
      { ...diagnostic, stderr: "untrusted output" },
      { ...diagnostic, failedChecks: ["https://example.test"] },
      { ...diagnostic, failedChecks: ["unknown_check"] },
      {
        ...diagnostic,
        failedChecks: Array.from(
          { length: 33 },
          (_, index) => `check_${index}`,
        ),
      },
    ])
      expect(ClosedDiagnosticSchema.safeParse(altered).success).toBe(false);
    expect(
      ClosedDiagnosticSchema.safeParse({
        ...diagnostic,
        component: "qualification",
        stage: "done",
        exitCode: null,
        failedChecks: ["native_binaries"],
      }).success,
    ).toBe(true);
  });
});
