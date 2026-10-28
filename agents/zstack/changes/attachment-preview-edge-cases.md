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
