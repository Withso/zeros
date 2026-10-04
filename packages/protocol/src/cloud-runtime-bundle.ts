import { sha256 } from "@noble/hashes/sha2.js";
import { z } from "zod";

export const RuntimeSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const RuntimeIdSchema = z.string().regex(/^r1-[a-f0-9]{64}$/);
export const BaseCompatibilityIdSchema = z.string().regex(/^bc1-[a-f0-9]{64}$/);
const sourceCommit = z.string().regex(/^[a-f0-9]{40}$/);
const integer = z.number().int().nonnegative().safe();
const protocolVersion = z.number().int().min(1).max(65_535);
const version = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.+-]+)?$/);
const libcVersion = z
  .string()
  .max(32)
  .regex(/^[0-9]+\.[0-9]+$/);
const timestamp = z.iso.datetime({ offset: true });
const mode = z.string().regex(/^0[0-7][0145][0145]$/);

/** POSIX archive names must already be normalized, without platform aliases. */
export function isRuntimeRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.startsWith("/") &&
    !/^[A-Za-z]:/.test(value) &&
    !/[\\\x00\ud800-\udfff]/u.test(value) &&
    value
      .split("/")
      .every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

export const RuntimeRelativePathSchema = z
  .string()
  .refine(isRuntimeRelativePath, "Invalid runtime relative path");
const absolutePath = z
  .string()
  .refine(
    (value) => value.startsWith("/") && isRuntimeRelativePath(value.slice(1)),
    "Invalid absolute path",
  );
const symlinkTarget = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !/^[A-Za-z]:/.test(value) &&
      !/[\\\x00\ud800-\udfff]/u.test(value),
    "Invalid relative symlink target",
  );

export const RuntimeManifestEntrySchema = z.discriminatedUnion("type", [
  z
    .object({ mode, path: RuntimeRelativePathSchema, type: z.literal("dir") })
    .strict(),
  z
    .object({
      mode,
      path: RuntimeRelativePathSchema,
      sha256: RuntimeSha256Schema,
      size: integer,
      type: z.literal("file"),
    })
    .strict(),
  z
    .object({
      path: RuntimeRelativePathSchema,
      target: symlinkTarget,
      type: z.literal("symlink"),
    })
    .strict(),
]);
export type RuntimeManifestEntry = z.infer<typeof RuntimeManifestEntrySchema>;

const utf8 = new TextEncoder();
function comparePaths(left: string, right: string): number {
  const a = utf8.encode(left),
    b = utf8.encode(right);
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

// Resolve components in order: normalizing '..' before following an earlier
// symlink could hide an escape. Checking with an empty map also proves lexical
// containment independently of the installed link topology.
function resolveManifestPath(
  segments: string[],
  links: Map<string, string>,
  visiting = new Set<string>(),
): string {
  let resolved: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (!resolved.length) throw new Error("Runtime symlink escapes its root");
      resolved.pop();
      continue;
    }
    resolved.push(segment);
    const path = resolved.join("/"),
      target = links.get(path);
    if (target !== undefined) {
      if (visiting.has(path)) throw new Error("Runtime symlink cycle");
      resolved = resolveManifestPath(
        [...resolved.slice(0, -1), ...target.split("/")],
        links,
        new Set([...visiting, path]),
      )
        .split("/")
        .filter(Boolean);
    }
  }
  return resolved.join("/");
}

export const RuntimeManifestSchema = z
  .object({
    agents: z
      .object({
        claude: z.object({ cli: version, sdk: version }).strict(),
        codex: z.object({ package: version }).strict(),
        cursor: z.object({ sdk: version }).strict(),
      })
      .strict(),
    entrypoints: z
      .object({
        node: RuntimeRelativePathSchema,
        setup: RuntimeRelativePathSchema,
        startEngine: RuntimeRelativePathSchema,
        supervisor: RuntimeRelativePathSchema,
        selfTest: RuntimeRelativePathSchema,
      })
      .strict(),
    files: z.array(RuntimeManifestEntrySchema).min(1),
    platform: z
      .object({
        arch: z.literal("x64"),
        libc: z.literal("glibc"),
        minGlibc: libcVersion,
        node: version,
        nodeModulesAbi: integer.positive(),
        os: z.literal("linux"),
      })
      .strict(),
    protocols: z
      .object({
        bootstrap: z.literal(1),
        engine: protocolVersion,
        setup: z.literal(2),
      })
      .strict(),
    schema: z.literal("zeros.runtime-manifest/v1"),
    source: z
      .object({ commit: sourceCommit, lockfileSha256: RuntimeSha256Schema })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const entries = new Map<string, RuntimeManifestEntry>();
    const links = new Map<string, string>();
    value.files.forEach((entry, index) => {
      if (
        entry.path === "manifest.json" ||
        entry.path.startsWith("manifest.json/")
      )
        context.addIssue({
          code: "custom",
          path: ["files", index, "path"],
          message: "The manifest is excluded from its inventory",
        });
      if (
        index > 0 &&
        comparePaths(value.files[index - 1].path, entry.path) >= 0
      )
        context.addIssue({
          code: "custom",
          path: ["files", index, "path"],
          message:
            "Inventory paths must be unique and sorted by UTF-8 byte order",
        });
      for (
        let parent = entry.path.lastIndexOf("/");
        parent > 0;
        parent = entry.path.lastIndexOf("/", parent - 1)
      ) {
        const ancestor = entries.get(entry.path.slice(0, parent));
        if (ancestor && ancestor.type !== "dir")
          context.addIssue({
            code: "custom",
            path: ["files", index, "path"],
            message: "Inventory entries cannot traverse a file or symlink",
          });
      }
      entries.set(entry.path, entry);
      if (entry.type === "symlink") links.set(entry.path, entry.target);
    });
    for (const [index, entry] of value.files.entries()) {
      if (entry.type !== "symlink") continue;
      const segments = [
        ...entry.path.split("/").slice(0, -1),
        ...entry.target.split("/"),
      ];
      try {
        resolveManifestPath(segments, new Map());
        resolveManifestPath(segments, links);
      } catch {
        context.addIssue({
          code: "custom",
          path: ["files", index, "target"],
          message:
            "Symlink must resolve inside the runtime without a link cycle",
        });
      }
    }
  });
export type RuntimeManifest = z.infer<typeof RuntimeManifestSchema>;

export function runtimeIdFromManifestSha256(manifestSha256: string): string {
  return `r1-${RuntimeSha256Schema.parse(manifestSha256)}`;
}

function checkRuntimeIdentity(
  value: { runtimeId: string; manifestSha256: string },
  context: z.RefinementCtx,
): void {
  if (value.runtimeId !== `r1-${value.manifestSha256}`)
    context.addIssue({
      code: "custom",
      path: ["runtimeId"],
      message: "Runtime identity must match the manifest digest",
    });
}

export const RuntimeDescriptorSchema = z
  .object({
    runtimeId: RuntimeIdSchema,
    manifestSha256: RuntimeSha256Schema,
    archiveSha256: RuntimeSha256Schema,
    archiveBytes: integer.positive(),
    expandedBytes: integer,
    sourceCommit,
    nodeModulesAbi: integer.positive(),
    bootstrapProtocolVersion: z.literal(1),
    engineProtocolVersion: protocolVersion,
  })
  .strict()
  .superRefine(checkRuntimeIdentity);
export type RuntimeDescriptor = z.infer<typeof RuntimeDescriptorSchema>;

export const RUNTIME_INSTALL_MAX_ENCODED_BYTES = 64 * 1024;
const artifact = z
  .object({
    url: z
      .string()
      .url()
      .max(RUNTIME_INSTALL_MAX_ENCODED_BYTES)
      .refine((value) => {
        try {
          const url = new URL(value);
          return (
            url.protocol === "https:" &&
            !url.username &&
            !url.password &&
            !url.hash
          );
        } catch {
          return false;
        }
      }, "Runtime artifacts require HTTPS without userinfo or a fragment"),
    expiresAt: timestamp,
  })
  .strict();
const installScope = {
  schema: z.literal("zeros.runtime-install/v1"),
  runtime: RuntimeDescriptorSchema,
  artifact,
};
export const RuntimeInstallInputSchema = z
  .discriminatedUnion("purpose", [
    z
      .object({
        ...installScope,
        purpose: z.literal("workspace-setup"),
        setup: z.string().min(1),
      })
      .strict(),
    z.object({ ...installScope, purpose: z.literal("build") }).strict(),
    z.object({ ...installScope, purpose: z.literal("qualification") }).strict(),
  ])
  .superRefine((value, context) => {
    // This bounds even the shortest encoding. The stdin consumer must also
    // enforce the 64 KiB bound on the actual base64url bytes before decoding.
    if (
      Math.ceil((utf8.encode(JSON.stringify(value)).length * 4) / 3) >
      RUNTIME_INSTALL_MAX_ENCODED_BYTES
    )
      context.addIssue({
        code: "custom",
        message: "Runtime install input exceeds its encoded bound",
      });
  });
export type RuntimeInstallInput = z.infer<typeof RuntimeInstallInputSchema>;

export const RuntimeInstallReceiptSchema = z
  .object({
    archiveSha256: RuntimeSha256Schema,
    baseCompatibilityId: BaseCompatibilityIdSchema,
    bootstrapVersion: z.literal(1),
    expandedBytes: integer,
    fileCount: integer.positive(),
    installedAt: timestamp,
    manifestSha256: RuntimeSha256Schema,
    runtimeId: RuntimeIdSchema,
    schema: z.literal("zeros.runtime-install-receipt/v1"),
  })
  .strict()
  .superRefine(checkRuntimeIdentity);
export type RuntimeInstallReceipt = z.infer<typeof RuntimeInstallReceiptSchema>;

export const ActiveRuntimeDescriptorSchema = z
  .object({
    baseCompatibilityId: BaseCompatibilityIdSchema,
    bootId: z.uuid(),
    cgroupRoot: absolutePath.refine(
      (value) => value.startsWith("/sys/fs/cgroup/"),
      "Runtime cgroup must be under the cgroup filesystem",
    ),
    installerReceiptSha256: RuntimeSha256Schema,
    manifestSha256: RuntimeSha256Schema,
    root: absolutePath,
    runtimeId: RuntimeIdSchema,
    schema: z.literal("zeros.active-runtime/v1"),
    supervisorSessionId: z.uuid(),
  })
  .strict()
  .superRefine((value, context) => {
    checkRuntimeIdentity(value, context);
    if (value.root !== `/opt/zeros-infra/${value.runtimeId}`)
      context.addIssue({
        code: "custom",
        path: ["root"],
        message: "Runtime root must match its immutable identity",
      });
  });
export type ActiveRuntimeDescriptor = z.infer<
  typeof ActiveRuntimeDescriptorSchema
>;

export const BaseCompatibilitySchema = z
  .object({
    arch: z.literal("x64"),
    artifactHostSuffixes: z
      .array(
        z
          .string()
          .max(253)
          .regex(/^\.(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/),
      )
      .min(1),
    bootstrapProtocolVersion: z.literal(1),
    glibc: libcVersion,
    os: z
      .object({
        id: z
          .string()
          .max(64)
          .regex(/^[a-z0-9][a-z0-9_-]*$/),
        versionId: z
          .string()
          .max(32)
          .regex(/^[0-9]+\.[0-9]+$/),
      })
      .strict(),
    protectedFiles: z
      .array(
        z
          .object({ mode, path: absolutePath, sha256: RuntimeSha256Schema })
          .strict(),
      )
      .min(1),
    schema: z.literal("zeros.base-compatibility/v1"),
    supportedManifestSchemas: z
      .array(z.literal("zeros.runtime-manifest/v1"))
      .min(1),
    systemdMin: integer.positive(),
    uids: z
      .object({
        agent: z.literal(10001),
        capture: z.literal(10002),
        coordinator: z.literal(10004),
        engine: z.literal(10003),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    for (const field of [
      "artifactHostSuffixes",
      "supportedManifestSchemas",
    ] as const) {
      if (new Set(value[field]).size !== value[field].length)
        context.addIssue({
          code: "custom",
          path: [field],
          message: "Compatibility entries must be unique",
        });
    }
    if (
      new Set(value.protectedFiles.map((file) => file.path)).size !==
        value.protectedFiles.length ||
      value.protectedFiles.some(
        (file) => file.path === "/opt/zeros-bootstrap/compatibility.json",
      )
    )
      context.addIssue({
        code: "custom",
        path: ["protectedFiles"],
        message:
          "Protected inventory must be unique and exclude compatibility.json",
      });
  });
export type BaseCompatibility = z.infer<typeof BaseCompatibilitySchema>;

export const RuntimeInstallerStageSchema = z.enum([
  "validate_input",
  "lock",
  "check_space",
  "check_cache",
  "download",
  "verify_archive",
  "verify_manifest",
  "extract",
  "verify_tree",
  "publish_receipt",
  "switch_pointer",
  "start_host",
  "run_setup",
  "done",
]);
export type RuntimeInstallerStage = z.infer<typeof RuntimeInstallerStageSchema>;
export const RuntimeInstallerCheckSchema = z.enum([
  "input_schema",
  "input_too_large",
  "artifact_host",
  "artifact_expired",
  "lock_busy",
  "insufficient_space",
  "cache_conflict",
  "http_status",
  "download_truncated",
  "archive_digest",
  "archive_size",
  "manifest_digest",
  "manifest_schema",
  "bootstrap_protocol",
  "base_compatibility",
  "archive_paths",
  "archive_member_type",
  "file_inventory",
  "file_digest",
  "file_mode",
  "symlink_escape",
  "root_ownership",
  "hard_link",
  "cgroup_retired",
  "pointer_publish",
  "host_start",
  "setup_exit",
  "timeout",
  "process_signal",
  "diagnostic_missing",
]);
export type RuntimeInstallerCheck = z.infer<typeof RuntimeInstallerCheckSchema>;
const diagnosticConstant = z
  .string()
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/);
export const ClosedDiagnosticSchema = z
  .object({
    schema: z.literal("zeros.diagnostic/v1"),
    component: z.enum([
      "bundle",
      "publication",
      "base",
      "bootstrap",
      "installer",
      "attester",
      "setup",
      "qualification",
      "cleanup",
      "build",
    ]),
    stage: diagnosticConstant,
    ok: z.boolean(),
    exitCode: integer.max(255).nullable(),
    timedOut: z.boolean(),
    failedChecks: z.array(diagnosticConstant).max(32),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.failedChecks).size !== value.failedChecks.length)
      context.addIssue({
        code: "custom",
        path: ["failedChecks"],
        message: "Failed checks must be deduplicated",
      });
    if (value.component === "installer") {
      if (!RuntimeInstallerStageSchema.safeParse(value.stage).success)
        context.addIssue({
          code: "custom",
          path: ["stage"],
          message: "Unknown installer stage",
        });
      if (
        value.failedChecks.some(
          (check) => !RuntimeInstallerCheckSchema.safeParse(check).success,
        )
      )
        context.addIssue({
          code: "custom",
          path: ["failedChecks"],
          message: "Unknown installer check",
        });
    }
  });
export type ClosedDiagnostic = z.infer<typeof ClosedDiagnosticSchema>;

export const RuntimeBaseStatusSchema = z
  .object({
    baseCompatibilityId: BaseCompatibilityIdSchema,
    bootId: z.uuid(),
    currentRuntimeId: RuntimeIdSchema.nullable(),
    hostState: z.enum(["idle", "waiting_for_runtime", "stopped", "failed"]),
    schema: z.literal("zeros.base-status/v1"),
  })
  .strict();
export type RuntimeBaseStatus = z.infer<typeof RuntimeBaseStatusSchema>;

// Validate canonical tokens directly, retaining duplicate keys and byte-level
// differences that JSON.parse would otherwise erase. Manifest numbers are
// nonnegative integers; canonical strings use JSON.stringify's minimal escapes.
function assertCanonicalManifestJson(text: string): void {
  let cursor = 0;
  const fail = (): never => {
    throw new Error("Invalid canonical runtime manifest JSON");
  };
  function string(): string {
    const start = cursor;
    if (text[cursor++] !== '"') fail();
    while (cursor < text.length) {
      const character = text[cursor++];
      if (character === '"')
        return JSON.parse(text.slice(start, cursor)) as string;
      if (character.charCodeAt(0) < 32) fail();
      if (character === "\\") {
        const escape = text[cursor++];
        if (escape === "u") {
          const hex = text.slice(cursor, cursor + 4),
            code = Number.parseInt(hex, 16);
          if (
            !/^[0-9a-f]{4}$/.test(hex) ||
            code >= 32 ||
            [8, 9, 10, 12, 13].includes(code)
          )
            fail();
          cursor += 4;
        } else if (!escape || !'"\\bfnrt'.includes(escape)) fail();
      }
    }
    return fail();
  }
  function value(depth: number): void {
    if (depth > 16) fail();
    if (text[cursor] === '"') {
      string();
      return;
    }
    if (text[cursor] === "{") {
      cursor++;
      if (text[cursor] === "}") {
        cursor++;
        return;
      }
      let previous: string | undefined;
      while (true) {
        const key = string();
        if (
          !/^[\x00-\x7f]+$/.test(key) ||
          (previous !== undefined && previous >= key)
        )
          fail();
        previous = key;
        if (text[cursor++] !== ":") fail();
        value(depth + 1);
        const delimiter = text[cursor++];
        if (delimiter === "}") return;
        if (delimiter !== ",") fail();
      }
    }
    if (text[cursor] === "[") {
      cursor++;
      if (text[cursor] === "]") {
        cursor++;
        return;
      }
      while (true) {
        value(depth + 1);
        const delimiter = text[cursor++];
        if (delimiter === "]") return;
        if (delimiter !== ",") fail();
      }
    }
    const number = /^(?:0|[1-9][0-9]*)/.exec(text.slice(cursor));
    if (!number) fail();
    cursor += number![0].length;
  }
  value(0);
  if (cursor !== text.length) fail();
}

/** Hash the supplied UTF-8 bytes, optionally compare the admitted digest, and
 * parse without ever re-serializing the manifest for identity verification. */
export function parseCanonicalManifest(
  rawBytes: Uint8Array,
  expectedManifestSha256?: string,
): {
  manifest: RuntimeManifest;
  manifestSha256: string;
  runtimeId: string;
} {
  const manifestSha256 = Array.from(sha256(rawBytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  if (
    expectedManifestSha256 !== undefined &&
    manifestSha256 !== RuntimeSha256Schema.parse(expectedManifestSha256)
  )
    throw new Error("Runtime manifest digest mismatch");
  const text = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(rawBytes);
  assertCanonicalManifestJson(text);
  const manifest = RuntimeManifestSchema.parse(JSON.parse(text));
  return {
    manifest,
    manifestSha256,
    runtimeId: runtimeIdFromManifestSha256(manifestSha256),
  };
}
