-- The element a unit was cut at, and its first class.
--
-- The code index shows them to the model beside the text, because "pre.code"
-- and "p.TX" are the strongest signal about what a block is, and the strongest
-- one this application was throwing away. Null on rows written before this
-- migration: the index then judges on the text alone, as it did.
ALTER TABLE unit ADD COLUMN element TEXT;
ALTER TABLE unit ADD COLUMN class_name TEXT;
