-- A state is something that happened, not a word on a row.
--
-- `project.state` says what a book is now and nothing about how it got there:
-- when the analysis began, how long the extraction took, why the third phase
-- stopped, when the book was finished. Every one of those was about to be
-- guessed — from the presence of a result row, or from the clock of the whole
-- run — and a guess that looks like a fact is the worst kind of interface.
--
-- So every state a project enters, its own and the phases of its runs, is
-- appended here with its own dates and its own information. `project.state`
-- stays where it is: this table explains it, it does not replace it.
CREATE TABLE project_state (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project (id) ON DELETE CASCADE,
  run_id     TEXT REFERENCES run (id) ON DELETE SET NULL,
  -- Two kinds in one table because they are read as one history: the log
  -- interleaves "run started" with "phase 2 finished", and a join of two
  -- tables to tell one story is two tables too many.
  kind       TEXT NOT NULL CHECK (kind IN ('project', 'phase')),
  name       TEXT NOT NULL,
  outcome    TEXT CHECK (outcome IN ('done', 'failed', 'paused', 'cancelled')),
  entered_at TEXT NOT NULL,
  left_at    TEXT,
  info_json  TEXT
);

CREATE INDEX project_state_project ON project_state (project_id, entered_at);
CREATE UNIQUE INDEX project_state_one_open ON project_state (project_id, kind)
  WHERE left_at IS NULL;

-- What the books already in the library can still say for themselves: when
-- they were created, and what they are now. An old book with a short history
-- is honest; one with an invented history is not.
INSERT INTO project_state (id, project_id, run_id, kind, name, outcome, entered_at, left_at, info_json)
  SELECT lower(hex(randomblob(16))), p.id, NULL, 'project', p.state, NULL, p.created_at, NULL, NULL
    FROM project p;
