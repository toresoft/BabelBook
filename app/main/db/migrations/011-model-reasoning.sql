-- Whether this model should reason, for this application's purposes.
--
-- Null means "whatever the route does by default", which is what routeDefaults
-- did for DeepSeek alone. Translation gains nothing from reasoning and loses
-- the output budget to it, so the application's own default is off — but the
-- column stays nullable, because "not chosen" and "chosen off" are different
-- facts and only one of them is the user's.
ALTER TABLE provider_model ADD COLUMN reasoning_enabled INTEGER;
