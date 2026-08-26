-- The catalogue binding: which entry a provider was built from, and when its
-- metadata was copied. That date is the one a saved price carries — the answer
-- to "which catalogue believed these numbers?", so an estimate made yesterday
-- stays explainable after the catalogue changes its mind.
ALTER TABLE provider ADD COLUMN catalog_id TEXT;
ALTER TABLE provider ADD COLUMN catalog_at TEXT;

-- What the catalogue says a model can do, as JSON; null when it says nothing,
-- because absent capabilities, like absent prices, are never invented.
ALTER TABLE provider_model ADD COLUMN capabilities TEXT;
