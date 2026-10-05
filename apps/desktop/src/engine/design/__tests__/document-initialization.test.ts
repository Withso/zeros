import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as metadata from "../metadata";
import {
  createDesignFrame,
  designTransactionJournalPath,
  initializeDesignDocument,
  updateDesignFrameGeometry,
} from "../document";
import { withDesignDirectoryNameLease } from "../directory-registry";
import { designPagesMigrationJournalName } from "../pages-migration";
import { serializeDesignRegistration } from "../manifest";

describe("settled Design initialization", () => {
  let root: string;
  let file: string;
  const directory = "Screens";
  const run = <T>(work: () => Promise<T>) =>
    withDesignDirectoryNameLease(root, directory, work);
  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), "zeros-design-init-gate-"));
    process.env.ZEROS_DATA_DIR = path.join(root, "private");
    file = (await run(() => createDesignFrame(root))).file;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ZEROS_DATA_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  it("skips workspace recovery and migration on repeated settled geometry writes", () =>
    run(async () => {
      const recover = vi.spyOn(metadata, "recoverWorkspaceDesignMetadata");
      const migrate = vi.spyOn(metadata, "ensureDesignPagesLayout");
      for (let x = 10; x <= 30; x += 10) {
        await updateDesignFrameGeometry(root, file, {
          x,
          y: 0,
          w: 1440,
          h: 900,
          z: 0,
        });
      }
      expect(recover).not.toHaveBeenCalled();
      expect(migrate).not.toHaveBeenCalled();
    }));

  it.each(["metadata", "pages", "transaction"])(
    "does not skip a newly appeared %s recovery journal",
    (kind) =>
      run(async () => {
        const journal =
          kind === "transaction"
            ? path.basename(designTransactionJournalPath(root))
            : kind === "pages"
              ? designPagesMigrationJournalName(directory)
              : "metadata-" +
                createHash("sha256")
                  .update(directory)
                  .digest("hex")
                  .slice(0, 24) +
                ".json";
        metadata.writePrivateDesignState(root, journal, "invalid journal");
        const recover = vi.spyOn(metadata, "recoverWorkspaceDesignMetadata");
        const writing = updateDesignFrameGeometry(root, file, {
          x: 40,
          y: 0,
          w: 1440,
          h: 900,
          z: 0,
        });
        if (kind === "transaction") await writing;
        else await expect(writing).rejects.toThrow();
        expect(recover).toHaveBeenCalled();
        if (kind === "transaction")
          expect(existsSync(designTransactionJournalPath(root))).toBe(false);
      }),
  );

  it("keeps explicit initialization on the full repair path", () =>
    run(async () => {
      const recover = vi.spyOn(metadata, "recoverWorkspaceDesignMetadata");
      await initializeDesignDocument(root);
      expect(recover).toHaveBeenCalled();
    }));

  it("rejects a competing registration introduced after the directory was settled", () =>
    run(async () => {
      const manifest = readFileSync(
        path.join(root, directory, "meta/design.toml"),
        "utf8",
      );
      const id = manifest.match(/^id = "([^"]+)"/m)![1];
      writeFileSync(
        path.join(root, directory, "design.toml"),
        serializeDesignRegistration(id),
      );
      const before = readFileSync(
        path.join(root, directory, "meta/canvas.json"),
      );
      await expect(
        updateDesignFrameGeometry(root, file, {
          x: 40,
          y: 0,
          w: 1440,
          h: 900,
          z: 0,
        }),
      ).rejects.toThrow(/competing/i);
      expect(
        readFileSync(path.join(root, directory, "meta/canvas.json")),
      ).toEqual(before);
    }));
});
