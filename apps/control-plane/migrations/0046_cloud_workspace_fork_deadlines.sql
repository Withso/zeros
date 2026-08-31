-- ──────────────────────────────────────────────────────────
-- 0046 — bounded workspace-fork staging lifetime
--
-- Local→cloud copy uploads are resumable, but an abandoned client must not
-- reserve cloud-workspace quota or retain staged object references forever.
-- Cloud→local requests already have a short checkpoint deadline; this outer
-- deadline is a final coordinator safety net for every nonterminal fork.
-- ──────────────────────────────────────────────────────────

ALTER TABLE workspace_fork_intents
  ADD COLUMN deadline_at timestamptz;

UPDATE workspace_fork_intents
SET deadline_at = created_at + interval '24 hours'
WHERE deadline_at IS NULL;

ALTER TABLE workspace_fork_intents
  ALTER COLUMN deadline_at SET DEFAULT (now() + interval '24 hours'),
  ALTER COLUMN deadline_at SET NOT NULL,
  ADD CONSTRAINT workspace_fork_intents_deadline_check CHECK (
    deadline_at > created_at
  );

CREATE INDEX workspace_fork_intents_deadline_idx
  ON workspace_fork_intents(deadline_at, id)
  WHERE state NOT IN ('succeeded', 'failed', 'cancelled');
