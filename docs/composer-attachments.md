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

Generated clipboard files and cloud workspaces use bounded 1 MiB chunks, with
at most two concurrent renderer transfers and 32 queued transfers. Browser FileReader performs Base64
encoding for the existing JSON transport. Encoding affects transport only,
never the stored file format. A transfer captures its runtime and resolves its
workspace once; switching runtimes rejects subsequent writes. Native source
capabilities are refused over remote or non-host-local transports. Cloud uploads
start on selection in an existing workspace, explicitly waking that destination
if needed. Each chunk is fenced against account, Stop and execution changes;
the expected wake generation is allowed. The standalone worker accepts four
uploads per VM and reports them as activity so an idle stop cannot interrupt
an active transfer. Explicit Stop aborts partial uploads before its acknowledgement.
Retries first resolve a completed record, including after a lost final reply,
then restart incomplete uploads from the retained source.

Clicking a selected image/video while it uploads opens Files immediately from
its local Blob, without waiting for the VM. A visible preview keeps its lease
through completion; closing or hiding releases it. Files previews support
200 MB, independently of the 500 MB attachment limit. See
[Files media previews](file-media-preview.md) for streaming and resource limits.

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
`.context/attachments/<attachmentId>/<filename>`. A record an earlier build
wrote under `local/` or `shared/` retains its folder and identity. Aborted,
failed and idle uploads are cleaned up.
Local successful publication removes its temporary directory as well. Private
`attachment-temporaries/` ownership records identify the directory, inode and
creating process. Maintenance reclaims recorded copies older than 24 hours
only after that process exits and the directory identity still matches. It
never scans and deletes arbitrary temporary folders by name. Interrupted
copies retry from their separately persisted source; OS temporary directories
are never the durable draft store. An app-data override inside the workspace
is rejected so recovery metadata cannot add files to the repository. Imports no longer create
`.context/.attachment-staging/` or its extra ignore file. Explicit context writes
remove an old empty staging scaffold or its exact generated ignore file;
unknown files, edited ignore rules and links remain untouched. The cloud worker
uses a private sibling `attachment-uploads/` directory in its state store,
publishes complete files with an atomic no-overwrite hardlink, and removes the
partial immediately. Failed, aborted, stopped or five-minute-idle transfers
release partial files; startup also reclaims stale owned partials in bounded
batches. Completed cloud attachments are included in workspace checkpoints
even when their `.context` directory is ignored. Attachment records require
ordinary directory paths; redirected symlink layouts are refused before
completion because the checkpoint cannot retain them. Private partial uploads
are excluded from checkpoints.

Workspace creation and read-only context listings do not create
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
every format. Image/video Files previews stream within their separate 200 MB cap.

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

### Create before a workspace exists

Create saves its text, editor document, attachment metadata and linked Local directories in
`zeros:create-composer-drafts:v1`, separately for each owner, project and
Local/cloud placement. Local belongs to this device; cloud owners include the
backend, account and organization. A draft typed before choosing a project has
an unselected-project scope. Selecting the first project adopts it only when
that project has no existing draft. Switching projects or owners restores
their own drafts. Explicit Local project removal and confirmed organization
removal prune the matching scopes; a cold or failed catalog read does not.
Model, effort and permission choices stay with the open Create page when
switching projects and owners.
Linked workspace pills belong to the scoped draft, survive project switches
and reload, and count as unsent work even without text. Cloud Create offers
attachments but not Local directory links, which its runtime cannot use.

When Create is closed, its sidebar row shows the same 12 × 12 draft pencil as
workspace tabs if the selected owner has any nonempty Create draft. It covers
all of that owner's projects and placements, including reference-only and
attachment-only drafts. Whitespace alone does not count. Opening Create hides
the pencil; clearing the last draft or successfully handing it off removes it.
Presence restores synchronously from the existing store and only empty/nonempty
owner transitions notify the sidebar. It adds no persistence key or runtime read.

Create snapshots attachment bytes into the existing device-side IndexedDB
`zeros:attachment-sources:v1`, including files selected from disk. Its source
ids keep those copies alive even while Create is unmounted. Neither selecting
nor previewing an attachment creates `.context`, writes into the selected
project, uploads to a server, or starts a cloud VM. The saved copy is independent
of later changes to the original file. Normal quit waits for source preparation;
force-quitting before that preparation commits can still require reattaching.

On Create, the submitted revision and sources transfer to the new chat. Local
delivery publishes files under `.context/attachments/<id>/<filename>` in the
created workspace. Cloud v2 starts the same background chunked upload after
creation and publishes to `.context/attachments/<id>/<filename>`, up to
**500 MB per file**, matching Local. Attach and Send share the upload. The
durable prompt outbox receives only complete file references; its existing
**8 MiB encoded message limit** does not include attachment file bytes.
The worker still accepts older clients' inline attachment messages.
The Create draft is consumed only after confirmed creation and complete chat
draft persistence, and only if its submitted revision is still current. Failed
creates, newer typing and a handoff that cannot be fully persisted keep their
source draft. A delayed creation cannot navigate a different owner into its
workspace.

Draft metadata is bounded to 128 drafts, 1,000 attachments, 128 linked directories and 1 MB per draft,
and 4 MB overall; these limits do not include file bytes. Exceeding a limit or
device storage quota reports a save failure instead of evicting another unsent draft. Metadata
writes debounce while typing and flush on pagehide, normal close and submission.

Clicking an attachment opens a right-hand preview column. Markdown has Preview
and Code segments that remain visible in both views; text reads are limited to
the first 1 MB; images, audio and video
use local Blob URLs and the browser's supported codecs. Binary documents,
including PDF, offer a download when no safe in-app renderer is available.
Markdown cannot execute scripts, style the app, or load remote media. Closing,
removing the attachment, switching scope or hiding Create cancels stale preview
results and releases its media URL. Removing a pill remains undoable.

### Existing chats and clipboard

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
Completing an upload joins any pending recovery snapshot, persists the confirmed
destination reference, then immediately deletes its unneeded recovery Blob.
It cannot remove bytes another owner still needs, or the selected original file.
If draft persistence or ownership inspection fails, recovery bytes stay.
Other unreferenced native capability records and IndexedDB Blobs have a 24-hour
grace period. Legacy raw-Blob records migrate
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

## File references, skills and suggestions

`@` mentions and skills reference their source files; they are not attachment
copies. In Create, their open controls are disabled until a workspace exists.
Removing a reference remains undoable. Reference controls never submit the
Create form, and a form event without the explicit Create submitter is ignored;
the editor's Enter shortcut has its own intentional submission path.

Workspace composers open project references in the existing file-tab flow.
Project skill paths are relative to the workspace, so a reference selected in
Create follows the created worktree. Provider-library skills open in separate,
read-only source tabs, deduplicated by workspace, provider and source path.
Their complete Markdown source, including frontmatter, comes from discovery
through that workspace's runtime. Cloud sources never fall back to the Mac's
library. Older workers without skill discovery, virtual skills and unavailable
sources cannot be opened. Relative links inside library source previews do not
open unrelated workspace files.

Selecting a skill inserts a pill with a 12px Book icon that retains its provider
and source identity.
If selected before discovery completes, an unknown source resolves only from
that provider's catalog; an already captured source is never retargeted. Sending
or copying plain text preserves `/skill-name`, without attachment bytes or a new
prompt segment. Same-owner rich clipboard paste preserves the source reference;
cross-owner paste keeps only its invocation text.

Discovery checks project provider, shared `.agents/skills` and legacy `skills`
directories before home libraries, including Codex's `skills/.system`. Local
and VM scanners read bounded UTF-8 source through checked file descriptors,
confine sources to their skill libraries, skip Git metadata and reject redirects
outside the library. Each catalog scans at most 512 entries per root, accepts
up to 256 skills, limits a source to 256 KiB and limits the serialized response
to 2 MiB. The renderer shares exact workspace/provider reads, retains confirmed
data on refresh failure and bounds inactive catalogs by count and byte weight.
Cloud discovery waits for a running workspace and resumes when its lifecycle
publishes that state; stopped or transitioning workspaces receive no background
skill request from the composer.

Slash suggestions work after whitespace anywhere in the draft, including after
newlines and pills. URLs and slash-containing file paths do not open a command
menu. In Create, both `@` and `/` menus follow the typed trigger and prefer the
space beneath it. Workspace chat and message-edit menus open above the whole
composer at its width. Both placements adjust to the viewport. They preserve editor focus, consume acceptance
keys and dismiss with their editor when hidden or switched. IME confirmation
does not accept a suggestion or send a message. Known commands use the warm
primary text color; skills, arguments, paths and unknown commands stay distinct.
Markdown attachments opened in workspace file tabs also label their source
view Code alongside Preview.

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
