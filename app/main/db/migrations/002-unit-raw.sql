-- The bytes of a unit's range, as the source wrote them.
--
-- `source_text` is decoded and has its inline markup masked; `raw` is neither.
-- Composition reinserts `raw` verbatim wherever a unit has no translation, and
-- that is precisely what makes a null translation come back byte for byte.
-- Reconstructing it from `source_text` is impossible: re-escaping turns
-- `&#38;` into `&amp;` — identical to a reader, different to the gate.
ALTER TABLE unit ADD COLUMN raw_text TEXT;
