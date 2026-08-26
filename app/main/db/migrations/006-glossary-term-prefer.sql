-- The third rule reaches the glossaries too.
--
-- Migration 003 added `prefer` to `term` and stopped there, so a project term
-- could carry a rule that its own glossary was forbidden to hold: promoting it
-- hit a CHECK constraint. That is the commonest rule there is — 55 of the 129
-- entries in the prototype's real glossaries — so the failure would have met
-- the user on the ordinary path, not on an edge case.
--
-- `sense` comes along for the same reason it exists on `term`: a glossary that
-- cannot say which "spring" it means will mistranslate one of them.
-- SQLite cannot alter a CHECK, so the table is rebuilt.
CREATE TABLE glossary_term_new (
  id          TEXT PRIMARY KEY,
  glossary_id TEXT NOT NULL REFERENCES glossary (id) ON DELETE CASCADE,
  source      TEXT NOT NULL,
  target      TEXT,
  rule        TEXT NOT NULL CHECK (rule IN ('dnt', 'prefer', 'must')),
  sense       TEXT,
  note        TEXT,
  UNIQUE (glossary_id, source)
);
INSERT INTO glossary_term_new (id, glossary_id, source, target, rule, note)
  SELECT id, glossary_id, source, target, rule, note FROM glossary_term;
DROP TABLE glossary_term;
ALTER TABLE glossary_term_new RENAME TO glossary_term;
