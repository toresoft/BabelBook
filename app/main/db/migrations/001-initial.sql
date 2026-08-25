-- babelBook, initial schema.
--
-- Everything structured lives here; the disk holds artefacts only. Units are
-- rows and not a file, because the unit sheet and the exclusions gate filter
-- them by state and show the text, and re-reading and re-parsing the EPUB for
-- that would make both screens too slow to exist.

-- Application settings, one row per key.
CREATE TABLE setting (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- An LLM endpoint. The key is encrypted by the main process (safeStorage) and
-- never leaves it: the renderer sees "set" or "missing", never the bytes.
CREATE TABLE provider (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  route             TEXT NOT NULL,           -- which @ai-sdk/* package serves it
  base_url          TEXT,
  api_key_encrypted BLOB,
  headers           TEXT,                    -- JSON
  options           TEXT                     -- JSON: per-provider defaults
);

-- Prices are per million tokens; without them the estimate shows tokens only,
-- because an invented price is worse than no price.
CREATE TABLE provider_model (
  id             TEXT PRIMARY KEY,
  provider_id    TEXT NOT NULL REFERENCES provider (id) ON DELETE CASCADE,
  model_id       TEXT NOT NULL,
  display_name   TEXT,
  context_window INTEGER,
  price_in       REAL,
  price_out      REAL,
  UNIQUE (provider_id, model_id)
);

-- A glossary of the application, shared by every project that chooses it.
-- version is part of the cache key, so bumping it invalidates what used it.
CREATE TABLE glossary (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT,
  source_language TEXT,
  target_language TEXT,
  version         INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE glossary_term (
  id          TEXT PRIMARY KEY,
  glossary_id TEXT NOT NULL REFERENCES glossary (id) ON DELETE CASCADE,
  source      TEXT NOT NULL,
  target      TEXT,
  rule        TEXT NOT NULL CHECK (rule IN ('dnt', 'must')),
  note        TEXT,
  UNIQUE (glossary_id, source)
);

-- One book.
--
-- machine_snapshot is the truth about where the project stands; state is
-- denormalised from it so the library can filter without rehydrating an actor,
-- and is rewritten on every accepted transition.
--
-- source_sha256 is the hash of the copy in the workspace. If that file changes,
-- the unit ranges no longer describe it, and the project asks to be re-analysed
-- instead of quietly composing the wrong book.
--
-- provider_id and model_id are deliberately not foreign keys: a project keeps
-- naming the model that translated it even after the provider is removed.
CREATE TABLE project (
  id               TEXT PRIMARY KEY,
  filename         TEXT NOT NULL,
  title            TEXT NOT NULL,
  author           TEXT,
  workspace_path   TEXT NOT NULL,
  source_sha256    TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  description      TEXT,
  source_language  TEXT,
  target_language  TEXT NOT NULL,
  provider_id      TEXT,
  model_id         TEXT,
  state            TEXT NOT NULL CHECK (state IN (
                     'new', 'needs-language', 'ready', 'running',
                     'waiting-terms', 'waiting-code', 'composing',
                     'paused', 'done', 'incomplete', 'failed')),
  machine_snapshot TEXT,                     -- JSON, the persisted XState snapshot
  layout           TEXT NOT NULL DEFAULT 'reflowable'
                     CHECK (layout IN ('reflowable', 'pre-paginated', 'mixed')),
  -- Declared at creation, before anything is spent, and kept: media overlays
  -- are dropped from the translated book and the warning outlives day one.
  has_overlays     INTEGER NOT NULL DEFAULT 0 CHECK (has_overlays IN (0, 1))
);

-- One XHTML document of the spine. layout carries the itemref override, which
-- is why a book can be 'mixed' while each document is one thing or the other.
CREATE TABLE project_document (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES project (id) ON DELETE CASCADE,
  zip_path     TEXT NOT NULL,
  spine_order  INTEGER NOT NULL,
  encoding     TEXT,
  read_outcome TEXT,                         -- a code, never a sentence
  layout       TEXT NOT NULL DEFAULT 'reflowable'
                 CHECK (layout IN ('reflowable', 'pre-paginated', 'mixed')),
  UNIQUE (project_id, zip_path)
);

-- One translatable range of one document.
--
-- state is what the rules deduced and stays that way; forced_state and
-- forced_by record what a human decided at the exclusions gate, so the two are
-- never confused and a decision can be taken back.
CREATE TABLE unit (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES project (id) ON DELETE CASCADE,
  document_id   TEXT NOT NULL REFERENCES project_document (id) ON DELETE CASCADE,
  ordinal       INTEGER NOT NULL,
  unit_id       TEXT NOT NULL,               -- `${doc}#${ordinal}`, stable across runs
  kind          TEXT NOT NULL DEFAULT 'block'
                  CHECK (kind IN ('block', 'text', 'attribute')),
  range_start   INTEGER NOT NULL,
  range_end     INTEGER NOT NULL,
  state         TEXT NOT NULL CHECK (state IN (
                  'translate', 'maybe-code', 'code',
                  'never-translated', 'translate-no', 'uncomposable')),
  source_text   TEXT NOT NULL,
  placeholders  TEXT,                        -- JSON
  reason        TEXT,                        -- a code: 'css-code-surface', 'unreliable-range'
  owner_unit_id TEXT,                        -- attribute units: the block they belong to
  forced_state  TEXT CHECK (forced_state IS NULL OR forced_state IN (
                  'translate', 'maybe-code', 'code',
                  'never-translated', 'translate-no', 'uncomposable')),
  forced_by     TEXT,
  UNIQUE (project_id, unit_id)
);

-- The cache, and the reason it is a cache instead of a ledger that grows: one
-- row per unit and cache key. The key carries the prompt version, the model
-- identity and the ordered identity of the active glossaries, so changing a
-- term invalidates only the units that contain it.
CREATE TABLE translation (
  id         TEXT PRIMARY KEY,
  unit_id    TEXT NOT NULL REFERENCES unit (id) ON DELETE CASCADE,
  text       TEXT NOT NULL,
  cache_key  TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  outcome    TEXT NOT NULL CHECK (outcome IN ('translated', 'fell-back', 'identical')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (unit_id, cache_key)
);

-- A term of this project. A rejected term is kept rejected rather than deleted,
-- so the next extraction does not propose it again.
CREATE TABLE term (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES project (id) ON DELETE CASCADE,
  source         TEXT NOT NULL,
  target         TEXT,
  rule           TEXT NOT NULL CHECK (rule IN ('dnt', 'must')),
  origin         TEXT,                       -- 'extracted', 'manual', …
  approval_state TEXT NOT NULL DEFAULT 'pending'
                   CHECK (approval_state IN ('pending', 'approved', 'rejected')),
  note           TEXT,
  UNIQUE (project_id, source)
);

-- Which glossaries this project uses, and whether the model or the user said so.
CREATE TABLE project_glossary (
  project_id  TEXT NOT NULL REFERENCES project (id) ON DELETE CASCADE,
  glossary_id TEXT NOT NULL REFERENCES glossary (id) ON DELETE CASCADE,
  chosen_by   TEXT,                          -- 'model' | 'user'
  PRIMARY KEY (project_id, glossary_id)
);

-- One pass over the book: what it cost, and when it started and stopped.
CREATE TABLE run (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project (id) ON DELETE CASCADE,
  phase      TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at   TEXT,
  tokens_in  INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost       REAL
);

-- Every degradation, as a structured code and never as a sentence: the phrase
-- is composed by the interface from its catalogue, in the reader's language.
CREATE TABLE run_event (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES run (id) ON DELETE CASCADE,
  at           TEXT NOT NULL,
  code         TEXT NOT NULL,
  severity     TEXT NOT NULL,
  payload_json TEXT
);

-- The two queries the library and the engine run constantly: how far along a
-- project is, and whether this unit is already translated under this key.
CREATE INDEX unit_project_state ON unit (project_id, state);
CREATE INDEX translation_cache_key ON translation (cache_key);

-- Composition walks a document's units in order.
CREATE INDEX unit_document_ordinal ON unit (document_id, ordinal);
