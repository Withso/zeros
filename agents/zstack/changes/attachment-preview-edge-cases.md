# Attachment and document preview boundaries

Apply a group label only to a node with multiple file members. A video extraction
can return its timeline alone, and a bounded large batch can end in one file.
Both cases must keep that file's name in the composer, matching its sent form.

Only viewer-owned validation errors may supply display text. Use an explicit
error type; matching a message prefix does not establish where it came from.
Keep unknown parser and transport failures behind a fixed readable fallback.
The browser regression uses malformed Word XML inside a structurally valid DOCX
archive: corrupt ZIP bytes stop at validation and never exercise the parser's
error path. Verify that path for Local, organization-local and cloud sources.

Video actions must reflect attachment availability. A rejected selection has
no retained source, and a restored missing file cannot be extracted. Disable
frame extraction for both states and guard its entry point; an enabled action
that silently returns is misleading. The browser smoke exercises the real
selection size policy and a restored unavailable video across all three
owner/placement cases, requiring both download and extraction to be disabled.
