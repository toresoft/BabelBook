-- A third rule: `prefer`.
--
-- Measured on the prototype's own glossaries: 73 `dnt`, 55 `prefer`, zero
-- `must`. A preferred rendering is not an obligatory one, and mapping it onto
-- `must` would strengthen fifty-five rules their author deliberately left
-- weak. SQLite cannot alter a CHECK, so the table is rebuilt.
CREATE TABLE term_new (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES project (id) ON DELETE CASCADE,
  source         TEXT NOT NULL,
  target         TEXT,
  rule           TEXT NOT NULL CHECK (rule IN ('dnt', 'prefer', 'must')),
  origin         TEXT,
  approval_state TEXT NOT NULL DEFAULT 'pending'
                   CHECK (approval_state IN ('pending', 'approved', 'rejected')),
  sense          TEXT,
  note           TEXT,
  UNIQUE (project_id, source)
);
INSERT INTO term_new (id, project_id, source, target, rule, origin, approval_state, note)
  SELECT id, project_id, source, target, rule, origin, approval_state, note FROM term;
DROP TABLE term;
ALTER TABLE term_new RENAME TO term;
