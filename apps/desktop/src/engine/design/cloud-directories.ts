import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { QualifiedCloudFilePolicy } from "../files/cloud-file-policy";
import type { Workspace } from "../git/types";
import { opSettingsPreviewWrite, opSettingsWrite } from "../settings/ops";
import { assertDesignCheckoutReadable } from "./checkout-status";
import {
  assertSafeProspectiveDesignDirectory,
  previewDesignDirectoryForEnter,
  validateDesignDirectoryPointerTarget,
} from "./directory";
import {
  DESIGN_DIRECTORY_ID_PATTERN,
  sanitizeDesignDirectoryName,
} from "./directory-path";
import {
  designDirectoryNameFor,
  primeDesignDirectoryName,
} from "./directory-registry";
import { withDesignWorkspaceMutation } from "./document-write-lock";
import {
  createDesignDirectoryPages,
  designDirectoryEntry,
  readDesignDirectoryRegistry,
} from "./metadata";
import {
  rememberRecognizedDesignDirectories,
  stickyRecognizedDesignDirectories,
} from "./recognition-store";
import { unfenceDesignDirectory } from "./workspace-lock";

const directorySchema = z
  .string()
  .max(1024)
  .refine(
    (value) => sanitizeDesignDirectoryName(value) === value,
    "Choose a repository-relative Design folder.",
  );
const directoryIdSchema = z.string().regex(DESIGN_DIRECTORY_ID_PATTERN);
const selectionSchema = z
  .object({
    workspaceId: z.literal("local-main"),
    directoryId: directoryIdSchema,
    expectedDirectoryId: directoryIdSchema.nullable(),
  })
  .strict();
const creationSchema = z
  .object({ workspaceId: z.literal("local-main"), directory: directorySchema })
  .strict();
const browsingSchema = z
  .object({
    workspaceId: z.literal("local-main"),
    directory: z.union([z.literal(""), directorySchema]),
  })
  .strict();

/** Checkout-only picker. No native host paths, aliases, private storage or
 * nested owners are exposed, including empty directories Git does not list. */
export function browseCloudDesignDirectories(
  params: unknown,
  policy: QualifiedCloudFilePolicy,
) {
  const { directory } = browsingSchema.parse(params);
  const target = policy.assertPath(directory);
  if (target !== path.join(policy.root, directory))
    throw new Error("Choose a folder without symbolic links.");
  const fd = fs.openSync(
    target,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  );
  try {
    policy.assertDescriptor(fd, target);
    const handle = fs.opendirSync(`/proc/self/fd/${fd}`);
    const directories: string[] = [];
    let truncated = false;
    try {
      let inspected = 0;
      for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
        if (++inspected > 20_000 || directories.length === 512) {
          truncated = true;
          break;
        }
        const relative = directory ? `${directory}/${entry.name}` : entry.name;
        if (
          entry.isDirectory() &&
          sanitizeDesignDirectoryName(relative) === relative &&
          policy.allows(relative)
        )
          directories.push(relative);
      }
      policy.assertDescriptor(fd, target);
      return { directory, directories: directories.sort(), truncated };
    } finally {
      handle.closeSync();
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** Registration is explicit authoring; it leaves source and metadata as an
 * ordinary uncommitted change. Selection is a separate checked operation. */
export async function createCloudDesignDirectory(
  workspace: Workspace,
  params: unknown,
  policy: QualifiedCloudFilePolicy,
) {
  const { directory } = creationSchema.parse(params);
  return withDesignWorkspaceMutation(workspace.path, async () => {
    await assertDesignCheckoutReadable(workspace.path);
    await assertSafeProspectiveDesignDirectory(workspace.path, directory);
    const target = policy.assertPath(directory, true);
    if (fs.existsSync(target))
      throw new Error(
        "That folder already exists. Choose it from the VM folder picker to register it.",
      );
    if (!policy.createDirectory(directory))
      throw new Error(
        "That folder already exists. Choose it from the VM folder picker to register it.",
      );
    try {
      createDesignDirectoryPages(workspace.path, directory, {
        version: 3,
        frames: {},
      });
    } catch (error) {
      // Only undo an empty reservation. Never remove source or an admitted
      // metadata journal that must remain recoverable after interruption.
      try {
        fs.rmdirSync(policy.assertPath(directory, true));
      } catch {
        /* preserve nonempty/revoked paths */
      }
      throw error;
    }
    await rememberRecognizedDesignDirectories(workspace.path, [directory]);
    return {
      directory,
      directoryId: designDirectoryEntry(workspace.path, directory)!.id,
    };
  });
}

type Transition = (
  targets: readonly { workspaceId: string; designDirectory: string }[],
  mutation: () => Promise<unknown>,
) => Promise<unknown>;

/** A narrow lifecycle command, independent of the remote settings denylist.
 * Resolve and compare identities under the same lane as checked canvas edits. */
export async function selectCloudDesignDirectory(
  workspace: Workspace,
  params: unknown,
  policy: QualifiedCloudFilePolicy,
  transition: Transition,
) {
  const input = selectionSchema.parse(params);
  return withDesignWorkspaceMutation(workspace.path, async () => {
    await assertDesignCheckoutReadable(workspace.path);
    let selected = designDirectoryNameFor(workspace.path);
    try {
      selected = await previewDesignDirectoryForEnter(workspace, {
        strict: false,
        additionalRecognized: await stickyRecognizedDesignDirectories(
          workspace.path,
        ),
      });
    } catch {
      /* Match the listing's unresolved target; a valid explicit selection can repair it. */
    }
    const currentId =
      designDirectoryEntry(workspace.path, selected)?.id ?? null;
    if (currentId !== input.expectedDirectoryId)
      throw new Error(
        "The active Design directory changed. Refresh before choosing a folder.",
      );
    const directory = readDesignDirectoryRegistry(workspace.path)?.directories[
      input.directoryId
    ]?.path;
    if (!directory)
      throw new Error(
        "The Design directory is no longer registered. Refresh before choosing a folder.",
      );
    const patch = {
      design: { directory_id: input.directoryId, directory: null },
    };
    opSettingsPreviewWrite("workspace-local", patch, workspace.path);
    await validateDesignDirectoryPointerTarget(workspace.path, directory);
    policy.assertPath(directory, true);
    return transition(
      [
        {
          workspaceId: workspace.id,
          designDirectory: path.join(workspace.path, directory),
        },
      ],
      async () => {
        await validateDesignDirectoryPointerTarget(workspace.path, directory);
        await unfenceDesignDirectory(workspace.path);
        policy.assertPath(directory, true);
        if (
          designDirectoryEntry(workspace.path, directory)?.id !==
          input.directoryId
        )
          throw new Error("The Design directory changed during selection.");
        opSettingsWrite("workspace-local", patch, workspace.path);
        primeDesignDirectoryName(workspace.path, directory);
        return { directory, directoryId: input.directoryId };
      },
    );
  });
}
