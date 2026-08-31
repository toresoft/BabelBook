-- What a run walks past without asking belongs to the book, not to the
-- application.
--
-- Both gates now open by default: a translation that stops twice per book is
-- the exception someone asks for, not the rule everyone meets. The choice is
-- offered where the book is created and where it is edited, in plain sight,
-- which is what the old default in `channels.ts` was defending — it defended
-- it by making the choice for everybody, and by burying it in the settings.
ALTER TABLE project ADD COLUMN auto_accept_terms INTEGER NOT NULL DEFAULT 1
  CHECK (auto_accept_terms IN (0, 1));
ALTER TABLE project ADD COLUMN auto_accept_exclusions INTEGER NOT NULL DEFAULT 1
  CHECK (auto_accept_exclusions IN (0, 1));

-- The books already on the shelf keep the behaviour they had yesterday. The
-- CASE is unconditional on purpose: an absent row is how `readSettings` spelled
-- false, so absent must land as 0 here. The DEFAULT 1 above is for the projects
-- that do not exist yet, and only for them.
UPDATE project SET
  auto_accept_terms      = CASE WHEN (SELECT value FROM setting WHERE key = 'autoAcceptTerms')      = 'true' THEN 1 ELSE 0 END,
  auto_accept_exclusions = CASE WHEN (SELECT value FROM setting WHERE key = 'autoAcceptExclusions') = 'true' THEN 1 ELSE 0 END;

DELETE FROM setting WHERE key IN ('autoAcceptTerms', 'autoAcceptExclusions');

-- `provider_id` stays nullable, and that is deliberate.
--
-- From here on a project cannot be created or updated without a provider — the
-- guard lives in `app/main/projects/provider.ts`, at the IPC boundary. It could
-- not live in this file: a database out there may already hold projects with no
-- provider, and the only way to make the column NOT NULL would be to pick a
-- model on their owner's behalf. A column that reads as optional and is not is
-- worth this comment.
