-- Display mask only. The provider key itself stays in encrypted_secret.

ALTER TABLE provider_credentials
  ADD COLUMN last_four text;

ALTER TABLE provider_credentials
  ADD CONSTRAINT provider_credentials_last_four_length
  CHECK (last_four IS NULL OR length(last_four) = 4);
