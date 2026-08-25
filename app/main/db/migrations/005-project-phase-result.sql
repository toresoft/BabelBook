-- Durable, source/config-keyed results for paid phases.
--
-- A result row is the commit marker. Empty candidate reports and zero-change
-- code indexes are results too: absence alone would make both indistinguishable
-- from "not run" and pay the model again after a restart.
CREATE TABLE project_phase_result (
  project_id TEXT NOT NULL REFERENCES project (id) ON DELETE CASCADE,
  phase      TEXT NOT NULL CHECK (phase IN ('candidates', 'code-index')),
  cache_key  TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (project_id, phase, cache_key)
);
