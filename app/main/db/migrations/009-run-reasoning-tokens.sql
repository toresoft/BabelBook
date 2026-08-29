-- What a run spent thinking rather than answering. Part of tokens_out, never
-- on top of it: a provider bills it as output. Kept apart because it is the
-- one number that explains an answer that came back empty and was paid in
-- full — a reasoning model with no output budget of its own spends all of it
-- before the format begins.
ALTER TABLE run ADD COLUMN reasoning_tokens INTEGER NOT NULL DEFAULT 0;
