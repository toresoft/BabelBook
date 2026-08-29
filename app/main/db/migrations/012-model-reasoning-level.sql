-- Reasoning stops being a switch and becomes a strength.
--
-- A model that reasons does not only reason or not: DeepSeek accepts a
-- thinking effort of low, high or max, and OpenAI a reasoning effort of its
-- own. The boolean could say neither, so a book was translated with the
-- thinking off — the only alternative the application could express — and the
-- model, freed of it, answered one unit in three in another language.
--
-- Null still means "not chosen", which the runtime resolves to off: that
-- distinction is the user's and is not this migration's to collapse. `1`
-- becomes `high`, because a switch that was on asked for the provider's own
-- default and `high` is the nearest named strength; `0` becomes `off`.
CREATE TABLE provider_model_new (
  id              TEXT PRIMARY KEY,
  provider_id     TEXT NOT NULL REFERENCES provider (id) ON DELETE CASCADE,
  model_id        TEXT NOT NULL,
  display_name    TEXT,
  context_window  INTEGER,
  price_in        REAL,
  price_out       REAL,
  capabilities    TEXT,
  reasoning_level TEXT CHECK (reasoning_level IN ('off', 'low', 'high', 'max')),
  UNIQUE (provider_id, model_id)
);
INSERT INTO provider_model_new (id, provider_id, model_id, display_name,
                                context_window, price_in, price_out, capabilities,
                                reasoning_level)
  SELECT id, provider_id, model_id, display_name,
         context_window, price_in, price_out, capabilities,
         CASE reasoning_enabled WHEN 1 THEN 'high' WHEN 0 THEN 'off' ELSE NULL END
    FROM provider_model;
DROP TABLE provider_model;
ALTER TABLE provider_model_new RENAME TO provider_model;
