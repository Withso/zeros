# Files media and document previews

The Files viewer shows a bottom-left zoom control for images and videos. It
opens at 100% of the contained preview size, never enlarging a small source
automatically. Zoom is limited to 25–500%. Reset restores 100% and centers the
media. Drag pans; wheel and trackpad pinch zoom around the pointer. With the
preview focused, `+`/`-` zoom, arrow keys pan and `0` resets.

Copy appears beside the file title. Images have a Download action there; videos
put Download and Attach as frames in their overflow menu. Download preserves the original
bytes and filename. Copy writes the original image dimensions as PNG, or the
current video frame; the viewport's zoom and translation do not crop the copy.
Streamed/selected images and video frames use a temporary canvas only on explicit
Copy, limited to 32 megapixels. Legacy PNG data URLs decode directly because
the packaged CSP disallows `fetch(data:)`.

Video playback, seek and mute controls stay outside the transformed media.
Hiding the tab or document releases the decoder and buffered video, retaining
the camera, playback position and mute state without autoplay on return. Unsupported
codecs keep Download available and show a neutral preview-unavailable state.
An unvisited hidden preview does not create a decoder or open a media stream.

## PDF and Word

Attached and agent-generated PDF and Word `.docx` files open as document pages.
PDF supports thumbnails, page selection, Fit, zoom, rotation, selectable text,
password entry and original download. Word supports page selection, Fit, zoom,
formatted text, tables, embedded images and original download. Word pagination
uses section breaks and saved page breaks; its rendering can differ from Word,
especially for documents without saved pagination. The original remains intact.
Other document formats retain their existing fallback.

Page navigation and zoom share a floating bottom island in both viewers. The
percentage shows the rendered scale; clicking it fits the page again. PDF
thumbnails and rotation remain in the file title actions beside Download.
The page viewport reserves space for the island, including in narrow panes,
so Fit and the end of a zoomed page stay readable. Hidden views remove the
island along with their rendering resources.

PDF.js runs in a local worker with packaged fonts, CMaps and image decoders.
It reads exact-workspace ranges, caps each coalesced allocation at 32 MiB, and
renders only the selected page and a virtualized thumbnail window. Hidden views
destroy the worker and canvases while keeping page, rotation and zoom selection.

Word previews read at most 50 MB in bounded chunks. ZIP headers, local entry
offsets, compression methods and actual expanded lengths are checked before
parsing, with limits of 2,000 entries, 32 MB per entry and 64 MB total expansion.
Rendering occurs in a detached document. DOMPurify sanitizes the result before
it enters a scriptless, opaque-origin iframe whose CSP blocks network resources
and active content. External hyperlinks are inert. Previews use no external
document service, and hidden Word views release their rendered pages.

Documents use the existing `binary` wire kind with optional MIME/revision
metadata. Updated Local and cloud readers support document ranges. Older
runtimes show a neutral runtime-update fallback instead of exposing PDF source.
Downloads preserve original bytes, including when a document cannot be previewed.

## Ownership and resource limits

Local Personal, organization-local and organization-cloud workspaces use the
same renderer and existing workspace file cache. `FileViewer` keys each media
view by workspace, tab, path and content revision. A retained view keeps its
camera; changing file/owner or replacing the source resets it. Late reads stay
in their original exact-key cache, and pending copy conversions are rejected
when their preview retires.

One native image/video element owns the decoded media. Gesture updates use
refs and a single pending animation frame to write a CSS transform and zoom
readout; they perform no file reads, React commits, canvas redraws or idle
polling. Hidden views detach gesture listeners and cancel pending paint.
Playback progress uses native media events in its own small control component.
No permanent `will-change` or forced compositor layer is requested.
Local and cloud file caches retain stream metadata, not large encoded media.
Their existing 128 MiB payload budgets and 96-entry limits still apply to text
and legacy inline responses; subscribed snapshots remain pinned.

Desktop Files previews allow **200 MB (200,000,000 bytes) per image or video**
for Local Personal, organization-local and organization-cloud workspaces.
Supported video containers are MP4, M4V, WebM, MOV, OGV and MKV; actual playback
depends on Chromium's codecs. Larger files show the too-large placeholder.

Files opts into `streamMedia` on `read_file`/`file.read`. The result describes
MIME type, byte length and file revision. An unguessable `zeros-media:` URL,
owned by the app window, serves Chromium's HTTP Range requests through the
existing authenticated workspace reader. Playback and seeking read only the
requested ranges. Video range packets are at most 256 KiB; image and full
download packets are at most 1 MiB. HTTP responses preserve the full requested
range: shortening open-ended ranges breaks Chromium's EOF and seek handling.
The native adapter permits 24 registered sources, eight active streams and
three streams per source, with a 30-second range timeout and no disk cache.
Abandoned workspace reads retain their budget slot until their reply or timeout;
new seeks wait without starting more reads, and cancelled waiters are removed.
Range events that arrive after their renderer source closes receive an error
reply immediately, freeing their native slot without waiting for the timeout.
Downloads stream to a temporary file beside the chosen destination and rename
only on completion; at most two downloads run concurrently.

Each range reauthorizes the path, reads a held regular-file descriptor and
checks its revision before and after I/O. Account, workspace and execution
generation changes invalidate the reader, including A → B → A transitions.
Closing, hiding or navigating away retires playback capabilities. A started
download holds its own lease until it completes. Cloud paths never fall back
to Local, and a retired or stopped runtime fails its pending reads.

The request fields are optional. Updated runtimes keep the previous 5 MiB
inline behavior for older clients; older runtimes retain their existing
binary/too-large fallback. Streaming requires the updated desktop and, for
cloud placement, the updated worker. Chromium owns playback buffering and
decoded surfaces. Packet and cache limits are not a total process/GPU memory
guarantee; large image dimensions and explicit Copy can still require substantial
decoding memory.

## Preview during attachment upload

Selecting media in an existing workspace starts the attachment transfer in
the background. Clicking its pill immediately opens Files using the selected
Blob, before a VM file exists. It borrows that Blob without another copy or
base64 conversion and creates an object URL only while displayed. The pending
registry is scoped to the exact workspace/account; optional unvisited entries
are bounded to 16 entries and 400 MB. Attachments above the preview cap retain
only their size in this registry and never create a media URL.

Completion preserves an already-open preview until it closes or hides, then
releases its URL and Blob lease. Confirmed recovery storage is removed once
the saved reference is persisted and no other draft, undo, transfer or clipboard
owner needs the bytes. The user's original selected file is never deleted.
Reopening uses the VM stream. Attachments may be up to 500 MB even though
Files playback is capped at 200 MB; see [composer attachments](composer-attachments.md).
Picker MIME metadata follows the same filename policy as saved files; correcting
an SVG reported as plain text uses a Blob slice that shares its backing bytes.

Transient image hover cards retain their separate 5 MiB limit. Saved-image
hovers open a native stream only while visible, release it on dismissal, and
reject larger images from metadata before reading their bytes. Larger supported
images can be opened in Files.

`scripts/ui-smoke-file-media.mjs`, included in `pnpm test:ui-smoke` through the
Files scenario, exercises gestures, clipboard PNGs, original downloads, playback,
owner changes, stale reads, failure states and both themes. Adjacent clipboard,
file-reader and bridge tests cover conversion cleanup, caps and compatibility.
`node scripts/smoke-file-media-electron.mjs` exercises production Electron/preload/Files
with a valid sparse 200 MB video: playback, distant seeking, hidden retirement,
PNG/frame copying and an exact-byte download. It uses the real Local reader and
a simulated cloud bridge, and verifies saved-image hover cleanup and metadata-only
refusal above the hover cap. On Linux the cloud bridge calls the standalone worker
reader; on macOS it uses the Local reader as its response fixture because the
worker requires Linux descriptor paths. The report records `cloudFileReader`.
Run on macOS and under `xvfb-run -a` on Linux to qualify both implementations;
this harness does not establish live Boat or physical Mac CPU, memory or GPU
performance.
Pass `--packaged` to build the harness with the production Vite CSP and load it
over `file://`. This also checks PDF/Word pages and exact document downloads.
The renderer meta policy and the Electron response policy must both allow
`zeros-media:` in `img-src` and `media-src`; allowing it in only one still blocks
playback. Protocol fetch probes run in Electron main without broadening the
renderer's `connect-src`.
