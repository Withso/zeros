-- ──────────────────────────────────────────────────────────
-- 0007 — Staff role: product-wide, orthogonal to team membership
-- ──────────────────────────────────────────────────────────
--
-- WHY THIS IS NOT A team_role VALUE
--
-- `team_role` ('owner','admin','member') answers "what may I do inside THIS
-- team", and authz.ts ranks it (ROLE_RANK) so `roleAtLeast(role, min)` can
-- compare. "I work on Zeros" is not a position in a customer's team hierarchy,
-- so adding 'developer' there would force an answer to "is a developer above
-- or below admin?" — every answer is wrong. It would also admit nonsense
-- states: developer in team A, plain member in team B.
--
-- Staff is a property of the PERSON, global and team-independent. Hence a
-- separate enum on `users`, NULL meaning "not staff" (the overwhelmingly
-- common case, and the correct default for every row that already exists).
--
-- An enum rather than a boolean because the internal group is expected to grow
-- roles ('support', 'qa', …). Adding a value to an existing enum is
-- ALTER TYPE … ADD VALUE — cheap and non-blocking. Retrofitting an enum onto a
-- boolean column later is a table rewrite plus a backfill.
--
-- First consumer: Settings → Internal, which until now gated on a build-time
-- email allowlist (VITE_INTERNAL_USER_EMAILS) baked into the renderer bundle.
-- That list was readable by anyone who unzipped app.asar from a public build,
-- and changing it required a full rebuild + re-release. Read from here it is a
-- SQL UPDATE, effective on the acting user's next request.

CREATE TYPE staff_role AS ENUM ('developer');

ALTER TABLE users ADD COLUMN staff_role staff_role;  -- NULL = not staff

-- ── Why a column-level grant, not just RLS ────────────────
--
-- `users_rw` (0006) is:
--     USING      (app_is_system() OR id = app_current_user() OR <same-team>)
--     WITH CHECK (app_is_system() OR id = app_current_user())
--
-- so RLS deliberately permits a user to UPDATE THEIR OWN row — that is what
-- makes profile edits possible. And 0004 granted table-wide UPDATE:
--     GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
--       TO zeros_app;
-- Both withUserTx and withSystemTx run `SET LOCAL ROLE zeros_app` (db.ts), so
-- that grant is what every request actually holds.
--
-- Together those mean: the moment `staff_role` lives on `users`, any code path
-- that lets a user write their own row is a self-promotion to staff. No such
-- route exists today (the only `UPDATE users` in the backend is ensureUser's
-- email/display_name mirror, in system context), but "no route exists yet" is
-- not a security boundary — the next profile-edit endpoint would silently
-- become one, and nothing in review would flag it.
--
-- So narrow the privilege to the columns that are legitimately user-writable.
-- Column privileges are enforced independently of RLS, which makes this a real
-- second layer rather than a restatement of the policy.
--
-- CONSEQUENCE FOR FUTURE MIGRATIONS: a new `users` column is NOT updatable by
-- zeros_app until it is added to the GRANT below. That is the intended
-- direction of failure — a forgotten grant surfaces immediately as a
-- permission error in development, whereas a forgotten REVOKE would ship as a
-- silent privilege escalation.
--
-- `staff_role` is deliberately absent from the list: staff is assigned by the
-- migration owner over SQL, never by the application. Granting it would hand
-- the escalation path straight back. (0004's ALTER DEFAULT PRIVILEGES only
-- applies to newly-created tables, so it cannot re-widen `users`.)

REVOKE UPDATE ON users FROM zeros_app;
GRANT UPDATE (email, display_name, avatar_url, deleted_at) ON users TO zeros_app;
