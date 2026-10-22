-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- Preserve historical connect tickets and older issuers as waking.
ALTER TABLE cloud_v2_tokens
  ADD COLUMN wake_on_connect boolean NOT NULL DEFAULT true;
