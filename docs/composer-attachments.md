# Composer attachments

Each file may be up to **500 MB (500,000,000 bytes)**, independent of the
selected model. The same policy applies to the picker, drag/drop, clipboard
files, pasted-text attachments, and attached chat transcripts.

The composer accepts all file formats except the archive, package, disk-image,
and compiled-executable formats excluded by
`packages/protocol/src/attachment-policy.ts`. Supported examples include:

| Category                    | Examples                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------- |
| Text, source, configuration | TXT, Markdown, HTML, XML, YAML, TOML, source code, shell scripts, logs, extensionless files |
| JSON and structured data    | JSON, JSONL, NDJSON, JSON5, JSONC, GeoJSON, HAR, CSV, TSV, Parquet, Arrow, SQLite           |
| Documents                   | PDF, DOC/DOCX, XLS/XLSX, PPT/PPTX, RTF, OpenDocument, EPUB                                  |
| Images                      | PNG, JPEG, GIF, WebP, SVG, TIFF, HEIC, AVIF, and other image formats                        |
| Audio                       | MP3, WAV, M4A, AAC, FLAC, OGG, and other audio formats                                      |
| Video                       | MP4, MOV, MKV, WebM, AVI, MPEG, TS, MTS, M2TS, MXF, FLV, WMV, and other video formats       |
| Other data                  | Fonts, datasets, 3D assets, and custom formats not excluded below                           |

Excluded categories include:

- Archives/compression: ZIP/ZIPX, RAR, 7Z, TAR, GZ/TGZ, BZ/BZ2/TBZ/TBZ2,
  XZ/TXZ, ZST/ZSTD/TZST, LZ/LZMA/LZO, Z, BR, CAB, AR, CPIO, SIT/SITX.
- Installers/application packages: APK/APKS/AAB, IPA, APP, PKG/MPKG,
  MSI/MSP/MSIX/MSIXBUNDLE, APPX/APPXBUNDLE, DEB, RPM, AppImage, RUN,
  JAR/WAR/EAR, WHL/EGG, GEM, CRATE, NUPKG.
- Disk images: DMG, ISO, IMG, SPARSEIMAGE/SPARSEBUNDLE, VHD/VHDX, VMDK,
  VDI, QCOW/QCOW2, WIM, ESD, TOAST.
- Compiled programs/libraries: EXE, COM, SCR, DLL, SO (including versioned
  names), DYLIB, ELF, O, A, LIB, CLASS, DEX, WASM.

Matching is case-insensitive and checks both filename and reported MIME type.
DOCX/XLSX/PPTX, OpenDocument and EPUB remain documents even when their container
uses ZIP. Source scripts and ambiguous data extensions such as BIN and OBJ are
allowed. This is a format policy, not content inspection or a malware scanner.

## Storage and delivery

Selection stages a lightweight composer pill immediately. Files transfer in
1 MiB chunks, with at most two concurrent renderer transfers. The engine
validates the size, format, upload identity, and offsets. Incomplete uploads
live in private temporary storage; only a completed file is published into
`.context/local/attachments/<attachmentId>/<filename>`. An attachment moved to
`shared/` retains its identity. Aborted, failed and idle uploads are cleaned up.

Send waits for the complete file and provides its confirmed path in an
`attached_file` text block. File contents are not embedded in the prompt or
persisted composer/transcript JSON. Draft restore and edit/resend resolve the
stable record using metadata only, including after scope/root moves. Failed
transfers keep the draft unsent; typing during a transfer preserves the newer
composer document. Removing a pill or clearing the composer leaves completed
context records intact. Delete a saved file manually, or explicitly ask an
agent to delete it from `.context`, to remove the record.

Staged transcript hover previews read the selected Blob, or resolve the saved
file after draft restore. Preview text lives only in a bounded memory cache;
it is not copied into persisted drafts or prompt payloads. Edit submission
disables attachment and mention removal until it succeeds or fails.

Attachment support means the file is available to the agent's tools. It does
not promise native playback, document conversion, or model understanding of
every format. Existing image previews retain their bounded read behavior.

Legacy drafts and transcripts remain readable. Their old inline image/text
encoding and bounded base64-write path are retained for compatibility; newly
created attachments use reference delivery. Bridge protocol 16 adds the file
kind and reference metadata while retaining existing IPC and operation names.
