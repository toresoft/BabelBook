-- The cover's file name, so the library does not stat the disk once per row.
--
-- Only the base name: the workspace path is already on the row, and storing
-- an absolute path twice means two things to keep in step when a library is
-- moved or restored from a backup.
ALTER TABLE project ADD COLUMN cover_file TEXT;

-- The contract the project's translations are made under.
--
-- The key is derived from prompt version, model and glossary identity, and it
-- decides which stored translations still count. Without it on the row, the
-- library would show progress made under a configuration that no longer
-- applies — a book promised and not there.
ALTER TABLE project ADD COLUMN cache_key TEXT;
