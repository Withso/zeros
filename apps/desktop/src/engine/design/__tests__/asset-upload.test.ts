import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDesignWebDocumentState } from "@zeros/design-web";
import { DesignDraftStore } from "../design-api";
import {
  createDesignFrame,
  initializeDesignDocument,
  recoverPendingDesignTransaction,
} from "../document";
import { designTransactionJournalPath } from "../document-transactions";
import {
  designDirectoryNameFor,
  forgetDesignDirectoryName,
} from "../directory-registry";
import * as storage from "../document-storage";
import { withDesignWriteAuthority } from "../write-authority";
import { MAX_ASSET_BYTES } from "../assets";
import {
  parseDesignUploadedAsset,
  prepareDesignAssetUpload,
  publishDesignUploadedAsset,
  withDesignAssetUpload,
} from "../asset-upload";

// Minimal supported PNG header; these storage tests do not invoke a renderer.
const image = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]),
  Buffer.from("IHDR"),
  Buffer.from([0, 0, 0, 1, 0, 0, 0, 1]),
]);
const input = {
  name: "pixel.png",
  mimeType: "image/png",
  data: image.toString("base64"),
};

describe("checked Design image storage", () => {
  let root: string;
  let previous: string | undefined;
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(tmpdir(), "zeros-v2-test-design-upload-"));
    previous = process.env.ZEROS_DATA_DIR;
    process.env.ZEROS_DATA_DIR = path.join(root, "private");
    await initializeDesignDocument(root);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    forgetDesignDirectoryName(root);
    if (previous === undefined) delete process.env.ZEROS_DATA_DIR;
    else process.env.ZEROS_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  async function transaction() {
    const frame = await createDesignFrame(root, { title: "Upload" });
    const store = new DesignDraftStore(root);
    const current = createDesignWebDocumentState(
      await store.read(`frame:${frame.file}`),
    );
    const asset = prepareDesignAssetUpload(input);
    const source = current.files[frame.file]!.replace(
      "</main>",
      `<img data-oid="uploaded" src="../${asset.file}"></main>`,
    );
    const next = createDesignWebDocumentState({
      ...current,
      files: { ...current.files, [frame.file]: source },
    });
    const commit = () =>
      store.commit({
        documentId: current.documentId,
        expectedRevision: current.revision,
        state: next,
      });
    const target = path.join(root, designDirectoryNameFor(root), asset.file);
    return { asset, store, current, next, commit, target, frame };
  }

  it("recovers an interrupted image and source transaction once, after revocation", async () => {
    const tx = await transaction();
    vi.spyOn(storage, "writeCanvas").mockRejectedValue(
      new Error("interrupted source write"),
    );
    await expect(withDesignAssetUpload(tx.asset, tx.commit)).rejects.toThrow(
      "interrupted source write",
    );
    expect(fs.readFileSync(tx.target)).toEqual(image);
    const journal = JSON.parse(
      fs.readFileSync(designTransactionJournalPath(root), "utf8"),
    );
    expect(journal.version).toBe(2);
    expect(journal.asset.file).toBe(tx.asset.file);
    vi.restoreAllMocks();
    await withDesignWriteAuthority(
      () => {
        throw new Error("revoked");
      },
      () => recoverPendingDesignTransaction(root),
    );
    expect(
      createDesignWebDocumentState(await tx.store.read(tx.current.documentId))
        .revision,
    ).toBe(tx.next.revision);
    expect(fs.readFileSync(tx.target)).toEqual(image);
    expect(fs.existsSync(designTransactionJournalPath(root))).toBe(false);
    await recoverPendingDesignTransaction(root);
    expect(
      (await tx.store.read(tx.current.documentId)).files[tx.frame.file].match(
        /data-oid="uploaded"/g,
      ),
    ).toHaveLength(1);
  });

  it("keeps ordinary Local transactions and recovery in their existing V1 format", async () => {
    const tx = await transaction();
    vi.spyOn(storage, "writeCanvas").mockRejectedValue(
      new Error("interrupted"),
    );
    await expect(tx.commit()).rejects.toThrow("interrupted");
    const journal = JSON.parse(
      fs.readFileSync(designTransactionJournalPath(root), "utf8"),
    );
    expect(journal.version).toBe(1);
    expect(journal).not.toHaveProperty("asset");
    expect(fs.existsSync(tx.target)).toBe(false);
    vi.restoreAllMocks();
    await recoverPendingDesignTransaction(root);
    expect(
      createDesignWebDocumentState(await tx.store.read(tx.current.documentId))
        .revision,
    ).toBe(tx.next.revision);
    expect(fs.existsSync(tx.target)).toBe(false);
  });

  it("writes nothing for stale or revoked transactions", async () => {
    const tx = await transaction();
    await expect(
      withDesignAssetUpload(tx.asset, () =>
        tx.store.commit({
          documentId: tx.current.documentId,
          expectedRevision: "stale",
          state: tx.next,
        }),
      ),
    ).rejects.toThrow("changed");
    await expect(
      withDesignWriteAuthority(
        () => {
          throw new Error("revoked");
        },
        () => withDesignAssetUpload(tx.asset, tx.commit),
      ),
    ).rejects.toThrow("revoked");
    expect(fs.existsSync(tx.target)).toBe(false);
    expect(fs.existsSync(designTransactionJournalPath(root))).toBe(false);
    expect(
      createDesignWebDocumentState(await tx.store.read(tx.current.documentId))
        .revision,
    ).toBe(tx.current.revision);
  });

  it("rejects symbolic links and differing existing content before admitting a journal", async () => {
    const tx = await transaction();
    fs.writeFileSync(tx.target, "existing source");
    await expect(withDesignAssetUpload(tx.asset, tx.commit)).rejects.toThrow(
      /different contents/,
    );
    expect(fs.readFileSync(tx.target, "utf8")).toBe("existing source");
    fs.unlinkSync(tx.target);
    const outside = path.join(root, "outside");
    fs.writeFileSync(outside, "untouched");
    fs.symlinkSync(outside, tx.target);
    await expect(withDesignAssetUpload(tx.asset, tx.commit)).rejects.toThrow(
      /real directories/,
    );
    expect(fs.readFileSync(outside, "utf8")).toBe("untouched");
    expect(fs.existsSync(designTransactionJournalPath(root))).toBe(false);
  });

  it("settles a crash between exclusive publication and temporary unlink without rewriting bytes", async () => {
    const tx = await transaction();
    const temporary = path.join(
      path.dirname(tx.target),
      `.${path.basename(tx.target)}.zeros-tmp`,
    );
    fs.writeFileSync(temporary, image);
    fs.linkSync(temporary, tx.target);
    const inode = fs.statSync(tx.target).ino;
    publishDesignUploadedAsset(root, tx.asset);
    expect(fs.statSync(tx.target).ino).toBe(inode);
    expect(fs.statSync(tx.target).nlink).toBe(1);
    expect(fs.existsSync(temporary)).toBe(false);
    publishDesignUploadedAsset(root, tx.asset);
    expect(fs.statSync(tx.target).ino).toBe(inode);
  });

  it("enforces the catalog limit before admission but reuses an existing identical image", async () => {
    const tx = await transaction();
    const assets = path.dirname(tx.target);
    for (let i = 0; i < 128; i++)
      fs.writeFileSync(path.join(assets, `${i}.png`), image);
    await expect(withDesignAssetUpload(tx.asset, tx.commit)).rejects.toThrow(
      "128 images",
    );
    expect(fs.existsSync(designTransactionJournalPath(root))).toBe(false);
    fs.unlinkSync(path.join(assets, "0.png"));
    // Exclusive create: also proves the rejected upload left no target behind.
    fs.writeFileSync(tx.target, image, { flag: "wx" });
    const inode = fs.statSync(tx.target).ino;
    await withDesignAssetUpload(tx.asset, tx.commit);
    expect(fs.statSync(tx.target).ino).toBe(inode);
  });

  it("bounds input and validates type, canonical bytes and journal path identity", () => {
    for (const name of [
      "../pixel.png",
      "/pixel.png",
      "a\\pixel.png",
      "pixel.svg",
      "pixel.jpg",
      ".private.png",
    ])
      expect(() => prepareDesignAssetUpload({ ...input, name })).toThrow();
    expect(() =>
      prepareDesignAssetUpload({
        ...input,
        data: Buffer.from("<svg></svg>").toString("base64"),
      }),
    ).toThrow(/contents/);
    expect(() =>
      prepareDesignAssetUpload({ ...input, data: input.data + "\n" }),
    ).toThrow();
    expect(() =>
      prepareDesignAssetUpload({
        ...input,
        data: Buffer.alloc(MAX_ASSET_BYTES + 1).toString("base64"),
      }),
    ).toThrow(/10 MiB/);
    const asset = prepareDesignAssetUpload(input);
    expect(parseDesignUploadedAsset(asset)).toEqual(asset);
    expect(() =>
      parseDesignUploadedAsset({ ...asset, file: "../outside.png" }),
    ).toThrow(/identity/);
    expect(() =>
      parseDesignUploadedAsset({ ...asset, extra: "untrusted" }),
    ).toThrow();
  });
});
