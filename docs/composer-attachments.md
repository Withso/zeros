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

Selection stages a lightweight composer pill immediately. For disk-backed
files in a local workspace, Electron's File-aware preload registers an opaque
source capability. The local engine opens that selected file and copies binary
bytes directly, without reading or Base64-encoding them in the renderer. It
checks the source inode, size and modification times before and after copying.
The final rename publishes a complete file; JSONL, line endings and binary
formats retain their original bytes. Disk speed and file size still determine
completion time. The pill appears immediately; “ready” means the copy finished.
Pills keep the same filename and geometry while queued, copying, complete or
failed. Transfer status belongs in the tooltip and `aria-busy`, never an inline
percentage that widens the pill and rewraps adjacent files. Failed copies retain
their warning styling and error tooltip.

Generated clipboard files and remote workspaces use bounded 1 MiB chunks, with
at most two concurrent renderer transfers. Browser FileReader performs Base64
encoding for the existing JSON transport. Encoding affects transport only,
never the stored file format. A transfer captures its runtime and resolves its
workspace once; switching runtimes rejects subsequent writes. Native source
capabilities are refused over remote or non-host-local transports.

The engine validates size, format, upload identity and offsets. Incomplete
uploads and final copies live in owner-only temporary directories outside the
workspace, on the destination filesystem. Every candidate, including OS and app
temporary roots and their symlink targets, must be outside every enclosing Git
checkout or Design folder. The engine checks location and filesystem before
allocation and again before writing. macOS uses its destination-aware item
replacement directory when ordinary temporary/app storage is on another volume.
Linux and Windows can allocate a private sibling on the workspace volume. A workspace
that occupies an entire mount with no writable outside location still needs
host-provided temporary space on that volume; unsuitable locations are refused.
Only a completed file is published into
`.context/local/attachments/<attachmentId>/<filename>`. An attachment moved to
`shared/` retains its identity. Aborted, failed and idle uploads are cleaned up.
Successful publication removes its temporary directory as well. Private
`attachment-temporaries/` ownership records identify the directory, inode and
creating process. Maintenance reclaims recorded copies older than 24 hours
only after that process exits and the directory identity still matches. It
never scans and deletes arbitrary temporary folders by name. Interrupted
copies retry from their separately persisted source; OS temporary directories
are never the durable draft store. An app-data override inside the workspace
is rejected so recovery metadata cannot add files to the repository. Imports no longer create
`.context/.attachment-staging/` or its extra ignore file. Explicit context writes
remove an old empty staging scaffold or its exact generated ignore file;
unknown files, edited ignore rules and links remain untouched.

Workspace creation and opening/refreshing the Context tab do not create
`.context/`. An attachment or explicit context write prepares storage on demand.
Existing context files and ignore rules retain their compatibility behavior;
viewing legacy context never migrates it.

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
disables attachment and mention removal until it succeeds or fails. Cut still
copies the selection while submission is pending, but leaves the draft intact.

Attachment support means the file is available to the agent's tools. It does
not promise native playback, document conversion, or model understanding of
every format. Existing image previews retain their bounded read behavior.

Legacy drafts and transcripts remain readable. On send, legacy inline text or
image bytes are saved once and delivered as file references to every agent,
including vision-capable agents. Old chat-scoped paths retain a bounded read
fallback for migration. Empty text placeholders in older saved chips resolve
their durable records; missing records fail the send instead of creating empty
replacement files. Confirmed empty files remain supported. Protocol 17 adds the
local native source capability; protocol 16 introduced file kinds and reference
metadata. Existing IPC and operation names and the context directory layout
remain compatible.

## Draft recovery and clipboard

Inactive chat tabs show a 12 × 12 pencil when their composer contains unsent
text or attachments, or a saved message edit exists. Chats displayed in any
split pane hide their pencils, including panes without focus. Inactive
workspace tabs show the same mark beside their name when any owned chat has a
draft, including displayed and closed chats. The active workspace hides its
pencil. Names truncate before the pencil; hovering the tab or focusing its
close/archive action covers the pencil in the same slot without resizing it.
Whitespace-only composers are empty. The live composer overrides an older
parked draft, so clearing or sending removes its mark immediately. Presence is
derived from existing draft storage and restored on launch, with no new
persistence key. Only empty/nonempty transitions notify tab subscribers.

The latest mounted composer document and attachment metadata participate in
the debounced draft snapshot, with synchronous pagehide/beforeunload flushes.
Clearing a live composer removes its old snapshot; deleting a chat cannot
resurrect its mounted draft. Completed files remain independent of chat and
composer lifetimes and are included by the existing workspace archive path.

Pending imports serialize a recovery id immediately. Native capabilities live
privately under the app data directory's `attachment-sources/`; generated and
remote upload Blobs live in IndexedDB `zeros:attachment-sources:v1`. Restart
first resolves a completed context record, then retries from the retained
source if necessary. Recovery-source cleanup considers persisted and live
drafts, editor undo side stores, active uploads and the current clipboard.
Completing one upload releases that transfer's reference; it cannot remove
bytes another owner still needs. Unreferenced native capability records and
IndexedDB Blobs have a 24-hour grace period. Legacy raw-Blob records migrate
with a fresh grace period. Referenced drafts have no age-based expiry.

Cleanup runs in bounded batches while the app is visible, including after
startup and return to the app. Electron reads only attachment clipboard
metadata (custom format or HTML) to retain current clipboard sources. Without
the native bridge, the browser conservatively retains the last app-copied ids.
Unreadable reference metadata prevents cleanup. Completed `.context` files
are never garbage-collected by recovery maintenance. Normal
app quit waits for source preparation before shutting down, with a 30-second
bound for an unresponsive renderer. A force-kill before preparation completes,
storage failure, or removal/modification of an unfinished native source can
still require reattaching. Those errors must not produce a successful send.

Copy/cut writes a versioned custom clipboard format, an HTML metadata fallback,
and plain text containing full source paths. Pasting within the same workspace
restores the selected document and fresh pill node ids, preserving durable
attachment ids and pending recovery keys. It reuses existing files. Rich paste
runs before the long-text-to-file rule. Cross-workspace paste replaces attachment
and file-mention pills with source-path text; remote paths include their runtime
identity. Local clipboard identity is scoped to this app profile, preventing a
clipboard copied on another computer from binding merely because paths match.
Malformed or missing references cannot silently disappear from a send.

Browser smoke coverage reloads a pending JSONL import through real IndexedDB,
checks exact bytes, and exercises rich and HTML clipboard round trips and
cross-workspace text fallbacks.

## Native verification

`pnpm smoke:attachment-storage` interrupts a real copy process, resumes through
its persisted capability in a fresh process, compares file hashes and checks
crash cleanup. `pnpm smoke:attachment-storage --large` exercises the full 500 MB
limit; on macOS it also mounts a disposable APFS image to check a separate
volume and an actual disk-full failure. The test removes its own files/volume.

`pnpm smoke:attachment-electron` runs on macOS. A separate Electron fixture uses
the production preload, source IPC, composer and draft persistence. It selects
a real disk file, quits with an upload held, relaunches with the same temporary
profile and completes the recovered copy. The regular packaged-engine gate is
still `pnpm smoke:engine`; the fixture is not a replacement for that gate.
