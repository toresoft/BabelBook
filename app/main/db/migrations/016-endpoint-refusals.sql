-- What the catalogue claims and what the endpoint grants stop sharing a column.
--
-- `capabilities` belongs to the catalogue: `refreshCatalogMetadata` replaces it
-- wholesale, which is right, because the catalogue is where those facts come
-- from. A refusal is the opposite kind of fact — nobody but this machine ever
-- learns it, and only by paying for a call that came back 400. Written into
-- the catalogue's own column it lasted until the next refresh, which is to say
-- until the next start of the application.
--
-- It also moved the cache key. The key names the work, and its format
-- ingredient was read from the same column, so learning that an endpoint
-- refuses a schema silently renamed every project on that model: a book paused
-- at 2310 units of 2389 came back with none of them under the key its next run
-- would look in, and was translated again from the first line.
--
-- So the refusal gets a column of its own. `NULL` is nothing refused; the
-- object holds the capability names an endpoint has turned down, so that the
-- one message the engine may send about this — a denial, never a claim — has
-- somewhere to land that the catalogue will not overwrite.
ALTER TABLE provider_model ADD COLUMN refused TEXT;

-- The refusals already written into the catalogue's column, moved rather than
-- lost. A false here can only have come from a refusal: the catalogue writes
-- this column from its own entry, and an entry that claimed nothing leaves the
-- key absent instead of false.
UPDATE provider_model
   SET refused = '{"structuredOutput":true}'
 WHERE capabilities IS NOT NULL
   AND json_valid(capabilities)
   AND json_extract(capabilities, '$.structuredOutput') = 0;
