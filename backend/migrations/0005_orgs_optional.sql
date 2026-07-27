-- ──────────────────────────────────────────────────────────
-- 0005 — Organizations become optional (product decision 2026-07-22).
--
-- Sign-in no longer auto-creates a personal org (auth.ts change lands
-- with this migration), so the personal-org concept is retired:
-- existing personal orgs become ordinary orgs — renameable as before,
-- and now deletable by their owner like any other org. Billing will
-- attach to person OR org separately, so a user with zero orgs is a
-- fully supported state.
--
-- Also in this migration:
--   • organizations.logo — a small raster logo as a data: URL. The API
--     layer enforces mime (png/jpeg/webp — never SVG, which can carry
--     script) and size; the column is plain text.
--   • org_secrets dropped — the shared-secrets vault left the product
--     (UI + API + engine injection all removed). Rows only ever held
--     ciphertext whose master key lives outside the DB; nothing to
--     migrate out. The RLS policy drops with the table.
-- ──────────────────────────────────────────────────────────

DROP INDEX IF EXISTS one_personal_org_per_user;
ALTER TABLE organizations DROP COLUMN is_personal;

ALTER TABLE organizations ADD COLUMN logo text;

DROP TABLE org_secrets;
