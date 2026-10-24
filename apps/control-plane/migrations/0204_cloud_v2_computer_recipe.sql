-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- The organization's configured Cloud Computer recipe: the repositories and
-- setup an admin wants installed. The active build is what is live; the two
-- differ while changes are unbuilt. NULL means "the active build's recipe".
-- The revision serializes edits from several admins and devices.
ALTER TABLE cloud_v2_computers
  ADD COLUMN recipe jsonb CHECK (recipe IS NULL OR jsonb_typeof(recipe) = 'object'),
  ADD COLUMN recipe_revision bigint NOT NULL DEFAULT 0 CHECK (recipe_revision >= 0),
  ADD COLUMN recipe_updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN recipe_updated_at timestamptz;

-- Why a build ran and what it started from. A NULL base snapshot is a clean
-- build from Boat's stock image; otherwise the build refreshed the
-- organization's previous snapshot in place. runtime_sha256 is the worker
-- runtime the build installed, so a runtime release can refresh the snapshot.
ALTER TABLE cloud_v2_computer_builds
  ADD COLUMN reason text NOT NULL DEFAULT 'manual'
    CHECK (reason IN ('manual', 'reactivate', 'runtime', 'refresh')),
  ADD COLUMN base_snapshot text
    CHECK (base_snapshot IS NULL OR char_length(base_snapshot) BETWEEN 1 AND 128),
  ADD COLUMN runtime_sha256 text
    CHECK (runtime_sha256 IS NULL OR runtime_sha256 ~ '^[0-9a-f]{64}$');
