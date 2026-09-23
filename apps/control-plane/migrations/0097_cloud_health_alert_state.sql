-- Durable state for aggregate cloud health alerts, shared by every replica and
-- surviving deploys: when a read last counted, the last observed reason set and
-- how many consecutive counted reads saw exactly it, how many were degraded,
-- and the open incident with its update sequence and the reasons and repeat
-- window it last emailed. It holds reason names only, never tenant identifiers.
CREATE TABLE cloud_health_alert_state (
  scope text PRIMARY KEY CHECK (scope = 'cloud'),
  observed_reasons text[] NOT NULL DEFAULT '{}' CHECK (cardinality(observed_reasons) <= 64),
  observed_reads integer NOT NULL DEFAULT 0 CHECK (observed_reads >= 0),
  degraded_reads integer NOT NULL DEFAULT 0 CHECK (degraded_reads >= 0),
  incident bigint NOT NULL DEFAULT 0 CHECK (incident >= 0),
  alert_sequence bigint NOT NULL DEFAULT 0 CHECK (alert_sequence >= 0),
  alerted_reasons text[] CHECK (alerted_reasons IS NULL OR cardinality(alerted_reasons) BETWEEN 1 AND 64),
  alerted_window bigint,
  last_read_ms bigint NOT NULL DEFAULT 0 CHECK (last_read_ms >= 0),
  CHECK ((alerted_reasons IS NULL) = (alerted_window IS NULL))
);
ALTER TABLE cloud_health_alert_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_health_alert_state FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_health_alert_state_system ON cloud_health_alert_state
  FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());
GRANT SELECT, INSERT, UPDATE ON cloud_health_alert_state TO zeros_app;
