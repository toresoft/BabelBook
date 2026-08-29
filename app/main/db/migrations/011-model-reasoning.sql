-- Whether this model should reason, for this application's purposes.
--
-- Null means "whatever the route does by default", which is what routeDefaults
-- did for DeepSeek alone. Translation gains nothing from reasoning and loses
-- the output budget to it, so the application's own default is off — but the
-- column stays nullable, because "not chosen" and "chosen off" are different
-- facts and only one of them is the user's.
ALTER TABLE provider_model ADD COLUMN reasoning_enabled INTEGER;

-- DeepSeek providers created before this preference stored the application's
-- forced-off default as if it belonged to the endpoint. Null now owns that
-- default, so remove only that historical value and keep every sibling option.
UPDATE provider
   SET options = CASE
     WHEN json_extract(json_remove(options, '$.deepseek.thinking'), '$.deepseek') = '{}'
       THEN json_remove(json_remove(options, '$.deepseek.thinking'), '$.deepseek')
     ELSE json_remove(options, '$.deepseek.thinking')
   END
 WHERE route = 'deepseek'
   AND options IS NOT NULL
   AND json_valid(options)
   AND json_type(options, '$.deepseek.thinking') = 'object'
   AND json_extract(options, '$.deepseek.thinking.type') = 'disabled';
