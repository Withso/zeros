-- Provider sid discovery and stable browser-account binding run on every
-- authenticated request. The subject index cannot serve this independent key.
CREATE INDEX workos_browser_sessions_provider_session_idx
  ON workos_browser_sessions (provider_session_id)
  WHERE kind = 'session';
