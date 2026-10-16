Provider Information gated its two intervals only on the retained surface, so
a hidden document still queried usage and woke the display clock. It now
combines document and surface visibility, releases both intervals and the
focus listener, and guards a focus event delivered before cleanup.

The first fix exposed a second issue: the cached reset label remained at five
hours after 31 hidden minutes while a reveal request was held. Reveal now
updates elapsed labels from the current clock without clearing confirmed data.
The retained browser regression covers cold hidden mounts, timer cancellation,
reveal/focus coalescing and held account A → B → A replies for Claude, Codex and
Cursor. The existing 30-minute visible fallback, native timeout, error backoff
and explicit refresh remain covered. See the bug-fix playbook and the
provider-usage-hidden-observation eval case.
