-- M2 auth tables. Raw tokens are never stored (SEC-CHECK B2, E2).
-- These tables are not Phase 1 project entities. Down drops only this set.

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sessions_token_hash_length CHECK (length(token_hash) = 64),
  CONSTRAINT sessions_expires CHECK (expires_at > created_at)
);

CREATE INDEX sessions_user_id ON sessions (user_id);

CREATE TABLE magic_link_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT magic_link_tokens_email_shape CHECK (
    email = lower(email) AND email LIKE '%_@_%._%'
  ),
  CONSTRAINT magic_link_tokens_hash_length CHECK (length(token_hash) = 64),
  CONSTRAINT magic_link_tokens_expires CHECK (expires_at > created_at)
);

CREATE INDEX magic_link_tokens_email ON magic_link_tokens (email);

CREATE TABLE email_change_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  new_email text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_change_tokens_email_shape CHECK (
    new_email = lower(new_email) AND new_email LIKE '%_@_%._%'
  ),
  CONSTRAINT email_change_tokens_hash_length CHECK (length(token_hash) = 64),
  CONSTRAINT email_change_tokens_expires CHECK (expires_at > created_at)
);

CREATE TABLE oauth_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state_hash text NOT NULL UNIQUE,
  code_verifier text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT oauth_states_hash_length CHECK (length(state_hash) = 64),
  CONSTRAINT oauth_states_verifier_length CHECK (
    length(code_verifier) BETWEEN 43 AND 128
  ),
  CONSTRAINT oauth_states_expires CHECK (expires_at > created_at)
);

COMMENT ON TABLE sessions IS 'Server session. Cookie stores the raw token; this table stores its hash.';
COMMENT ON TABLE magic_link_tokens IS 'Single-use magic-link token hash.';
COMMENT ON TABLE email_change_tokens IS 'Single-use proof of control of a new email address.';
COMMENT ON TABLE oauth_states IS 'Single-use Google OAuth state and PKCE verifier.';
