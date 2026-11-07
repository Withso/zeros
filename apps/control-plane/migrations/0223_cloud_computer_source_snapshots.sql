-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- v3 images hold every recipe repository, cloned and set up, so a new
-- workspace starts with its checkout on disk. Only a workspace whose
-- immutable source scope covers the whole recipe may start from one; any
-- other starts from Boat's stock image as before. v2 stays source-free.
-- zeros-expand-exception: widen-check Keep policies 1 and 2 and admit source-holding v3 images
ALTER TABLE cloud_v2_computer_builds DROP CONSTRAINT cloud_v2_computer_builds_source_policy_version_check;
ALTER TABLE cloud_v2_computer_builds ADD CONSTRAINT cloud_v2_computer_builds_source_policy_version_check
  CHECK (source_policy_version IN (1,2,3));
