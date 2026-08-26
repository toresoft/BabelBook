-- The composition's verdict becomes durable.
--
-- `composeEpub` returns the invariants, the EPUBCheck verdict, the overlays it
-- removed and the path it wrote, and the runtime used all of that to decide
-- COMPOSED or FAIL and then dropped it. So the one screen that exists to
-- explain what happened to a book had no way to say why a gate refused it, or
-- which checks a published EPUB actually passed.
--
-- It belongs in `project_phase_result` rather than a table of its own: that is
-- already the place where a phase's outcome is kept, keyed by the source and
-- configuration it was produced under, and a compose result is one of those.
CREATE TABLE project_phase_result_new (
  project_id  TEXT NOT NULL REFERENCES project (id) ON DELETE CASCADE,
  phase       TEXT NOT NULL CHECK (phase IN ('candidates', 'code-index', 'compose')),
  cache_key   TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (project_id, phase, cache_key)
);
INSERT INTO project_phase_result_new (project_id, phase, cache_key, result_json, created_at)
  SELECT project_id, phase, cache_key, result_json, created_at FROM project_phase_result;
DROP TABLE project_phase_result;
ALTER TABLE project_phase_result_new RENAME TO project_phase_result;
