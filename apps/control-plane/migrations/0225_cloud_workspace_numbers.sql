-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- Every cloud workspace is `w-<number>` within its organization, addressed as
-- app.zeros.build/<organization slug>/w/<number>. Numbers are never reused:
-- the sequence outlives deleted and purged workspaces. A workspace's title is
-- the first name one of its chats received; NULL shows as "Untitled".
ALTER TABLE cloud_v2_workspaces
  ADD COLUMN number integer CHECK (number IS NULL OR number > 0),
  ADD COLUMN title text CHECK (title IS NULL OR char_length(title) BETWEEN 1 AND 200);

CREATE TABLE cloud_v2_workspace_number_sequences (
  org_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  last_number integer NOT NULL CHECK (last_number >= 0)
);

UPDATE cloud_v2_workspaces w SET number = numbered.number
FROM (
  SELECT id, row_number() OVER (PARTITION BY org_id ORDER BY created_at, id)::integer AS number
  FROM cloud_v2_workspaces
) numbered
WHERE w.id = numbered.id;

INSERT INTO cloud_v2_workspace_number_sequences (org_id, last_number)
SELECT org_id, max(number) FROM cloud_v2_workspaces GROUP BY org_id;

CREATE UNIQUE INDEX cloud_v2_workspaces_org_number
  ON cloud_v2_workspaces (org_id, number) WHERE number IS NOT NULL;

-- Every writer, including a release that predates numbers, gets the next
-- number; an explicit one only raises the sequence. The sequence row lock
-- orders concurrent creates in one organization.
CREATE FUNCTION cloud_v2_workspace_number() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.number IS NULL THEN
    INSERT INTO cloud_v2_workspace_number_sequences AS s (org_id, last_number)
      VALUES (NEW.org_id, 1)
      ON CONFLICT (org_id) DO UPDATE SET last_number = s.last_number + 1
      RETURNING s.last_number INTO NEW.number;
  ELSE
    INSERT INTO cloud_v2_workspace_number_sequences AS s (org_id, last_number)
      VALUES (NEW.org_id, NEW.number)
      ON CONFLICT (org_id) DO UPDATE SET last_number = greatest(s.last_number, EXCLUDED.last_number);
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER cloud_v2_workspaces_number BEFORE INSERT ON cloud_v2_workspaces
  FOR EACH ROW EXECUTE FUNCTION cloud_v2_workspace_number();

-- Workspaces whose chats were already named take the earliest named chat's
-- title, by the same rule the history mirror applies from now on.
UPDATE cloud_v2_workspaces w SET title = named.title
FROM (
  SELECT DISTINCT ON (c.workspace_id) c.workspace_id,
    left(regexp_replace(btrim(c.row->>'title'), '\s+', ' ', 'g'), 200) AS title
  FROM cloud_v2_chats c
  WHERE c.deleted_at IS NULL
    AND jsonb_typeof(c.row->'title') = 'string'
    AND regexp_replace(btrim(c.row->>'title'), '\s+', ' ', 'g') NOT IN ('', 'Untitled', 'New chat')
    AND coalesce(c.row->>'kind', '') <> 'terminal'
    AND coalesce(c.row->'archived', 'false'::jsonb) <> 'true'::jsonb
  ORDER BY c.workspace_id,
    CASE WHEN jsonb_typeof(c.row->'createdAt') = 'number' THEN (c.row->>'createdAt')::numeric END NULLS LAST,
    c.chat_id
) named
WHERE w.id = named.workspace_id AND w.title IS NULL;

ALTER TABLE cloud_v2_workspace_number_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_v2_workspace_number_sequences FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_v2_workspace_number_sequences USING (app_is_system()) WITH CHECK (app_is_system());
GRANT SELECT, INSERT, UPDATE ON cloud_v2_workspace_number_sequences TO zeros_app;
