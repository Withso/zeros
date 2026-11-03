// Smoke scenarios share one browser profile, and the Files draft journal
// persists unsaved edits across page loads by design. Each harness page keeps
// its drafts in memory so a scenario never restores another scenario's draft.
import { createMemoryDraftJournal, setEditorDraftJournalForTests } from "../shell/workbench/tabs/code-editor/draft-journal";

setEditorDraftJournalForTests(createMemoryDraftJournal());
