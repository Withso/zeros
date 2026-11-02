-- zeros-migration: contract
-- zeros-contract-after: 2026-11-02
-- Owner-approved Auth0 removal: no API release since 0.1.28 (#800) reads the
-- 0208 tables, and the Auth0 tenant is deleted.
DROP TABLE IF EXISTS
  auth0_desktop_sessions,
  auth0_handoff_tickets,
  auth0_browser_sessions,
  auth0_session_revocations;
