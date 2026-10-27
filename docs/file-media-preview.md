# Files image and video previews

The Files viewer shows a bottom-left zoom control for images and videos. It
opens at 100% of the contained preview size, never enlarging a small source
automatically. Zoom is limited to 25–500%. Reset restores 100% and centers the
media. Drag pans; wheel and trackpad pinch zoom around the pointer. With the
preview focused, `+`/`-` zoom, arrow keys pan and `0` resets.

Copy and Download appear beside the file title. Download preserves the original
bytes and filename. Copy writes the original image dimensions as PNG, or the
current video frame; the viewport's zoom and translation do not crop the copy.
Non-PNG images and video frames use a temporary canvas only on explicit Copy,
limited to 32 megapixels. Original PNGs decode their bounded base64 directly:
the packaged app's CSP deliberately disallows `fetch(data:)`.

Video playback, seek and mute controls stay outside the transformed media.
Hiding the tab or document pauses video without autoplay on return. Unsupported
codecs keep Download available and show a neutral preview-unavailable state.
An unvisited hidden preview does not create a decoder, even when its file bytes
are already warm. Replacing a hidden source retires its old media element.

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
Local and cloud source caches have separate 128 MiB retained-payload budgets,
alongside the existing 96-entry limit. Confirmed subscribed snapshots remain
pinned; the budget evicts inactive payloads without clearing a displayed file.

Files opts into `includeVideo: true` on the existing `read_file`/`file.read`
request. The desktop engine and standalone cloud worker support MP4, M4V,
WebM, MOV, OGV and MKV containers; actual playback depends on Chromium's codec
support. Video payloads share the existing 5 MiB image limit, keeping their
base64 response below the 16 MiB bridge frame limit. Larger files retain the
existing too-large placeholder. This is a bounded preview, not a streaming
video transport.

The new request field is optional. Updated runtimes keep legacy results for
clients that omit it, and older runtimes keep their binary/too-large fallback.
Desktop workspace trust and cloud descriptor checks still authorize reads;
cloud paths never fall back to the Mac filesystem. Copy/download use confirmed
preview bytes and do not wake a stopped cloud VM.

`scripts/ui-smoke-file-media.mjs`, included in `pnpm test:ui-smoke` through the
Files scenario, exercises gestures, clipboard PNGs, original downloads, playback,
owner changes, stale reads, failure states and both themes. Adjacent clipboard,
file-reader and bridge tests cover conversion cleanup, caps and compatibility.
