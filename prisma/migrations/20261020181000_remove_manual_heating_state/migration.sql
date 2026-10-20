UPDATE "HeatingState"
SET "source" = 'DEFAULT', "overrideUntil" = NULL
WHERE "source" = 'MANUAL';
