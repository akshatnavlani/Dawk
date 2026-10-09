ALTER TABLE provider_credentials
  DROP CONSTRAINT IF EXISTS provider_credentials_last_four_length;

ALTER TABLE provider_credentials
  DROP COLUMN IF EXISTS last_four;
