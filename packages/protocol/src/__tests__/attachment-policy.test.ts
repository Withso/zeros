import { describe, expect, it } from "vitest";
import {
  MAX_ATTACHMENT_BYTES,
  validateAttachmentFile,
} from "../attachment-policy";

describe("composer attachment file policy", () => {
  it.each([
    "events.jsonl",
    "events.ndjson",
    "config.json5",
    "config.jsonc",
    "report.pdf",
    "notes.txt",
    "script.sh",
    "main.ts",
    "data.parquet",
    "book.epub",
    "report.docx",
    "table.xlsx",
    "slides.pptx",
    "scene.obj",
    "image.png",
    "audio.flac",
    "video.mp4",
    "video.mkv",
    "video.mov",
    "video.webm",
    "video.avi",
    "video.mxf",
    "unknown.custom",
    "LICENSE",
  ])("accepts %s up to 500 decimal MB", (name) => {
    expect(MAX_ATTACHMENT_BYTES).toBe(500_000_000);
    expect(
      validateAttachmentFile({ name, size: MAX_ATTACHMENT_BYTES }),
    ).toEqual({ ok: true });
    expect(
      validateAttachmentFile({ name, size: MAX_ATTACHMENT_BYTES + 1 }).ok,
    ).toBe(false);
  });

  it.each([
    "files.zip",
    "files.RAR",
    "files.7z",
    "files.tar.gz",
    "files.tgz",
    "files.tar.xz",
    "files.zst",
    "package.apk",
    "package.aab",
    "package.ipa",
    "package.dmg",
    "package.pkg",
    "package.deb",
    "package.rpm",
    "package.whl",
    "package.jar",
    "package.msixbundle",
    "disk.iso",
    "disk.vhdx",
    "disk.qcow2",
    "program.exe",
    "program.AppImage",
    "library.dll",
    "library.so.1.2",
    "binary.elf",
  ])("rejects %s before reading its bytes", (name) => {
    expect(validateAttachmentFile({ name, size: 1 }).ok).toBe(false);
  });

  it("checks MIME types even when the extension is misleading", () => {
    expect(
      validateAttachmentFile({
        name: "notes.txt",
        mimeType: "application/zip",
        size: 1,
      }).ok,
    ).toBe(false);
    expect(
      validateAttachmentFile({
        name: "download",
        mimeType: "application/vnd.android.package-archive",
        size: 1,
      }).ok,
    ).toBe(false);
    expect(
      validateAttachmentFile({
        name: "data",
        mimeType: "application/octet-stream",
        size: 1,
      }).ok,
    ).toBe(true);
  });

  it("allows document containers without treating their ZIP storage as an archive upload", () => {
    expect(
      validateAttachmentFile({
        name: "report.docx",
        mimeType: "application/zip",
        size: 1,
      }).ok,
    ).toBe(true);
    expect(
      validateAttachmentFile({
        name: "book.epub",
        mimeType: "application/epub+zip",
        size: 1,
      }).ok,
    ).toBe(true);
  });

  it.each([-1, NaN, Infinity, 1.5])("rejects invalid size %s", (size) => {
    expect(validateAttachmentFile({ name: "a.txt", size }).ok).toBe(false);
  });
});
