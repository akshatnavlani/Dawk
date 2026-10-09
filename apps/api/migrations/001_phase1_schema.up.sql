-- Phase 1 entities from SOURCE_OF_TRUTH.md §11.
-- Conceptual names stay conceptual in the SoT. This file is the DDL.
-- Provider secrets are ciphertext only (SEC-CHECK A1, IMP-Q-002).
-- Invite tokens are stored as hashes, never as raw tokens (SEC-CHECK B3, E2).
-- Session, magic-link, and change-email tables are M2, not this migration.
-- Project delete retention (SEC-CHECK F3) is still undecided. Child rows cascade
-- so a project delete cannot leave orphans. That is structure, not a product promise.

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  password_hash text,
  google_sub text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_shape CHECK (
    email = lower(email) AND email LIKE '%_@_%._%'
  )
);

CREATE UNIQUE INDEX users_google_sub_unique
  ON users (google_sub)
  WHERE google_sub IS NOT NULL;

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  owner_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  spend_cap numeric(14, 6),
  spend_used numeric(14, 6) NOT NULL DEFAULT 0,
  llm_paused boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT projects_name_present CHECK (length(btrim(name)) > 0),
  CONSTRAINT projects_spend_cap_nonnegative CHECK (
    spend_cap IS NULL OR spend_cap >= 0
  ),
  CONSTRAINT projects_spend_used_nonnegative CHECK (spend_used >= 0)
);

CREATE TABLE memberships (
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  role text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id),
  CONSTRAINT memberships_role CHECK (role IN ('owner', 'member'))
);

CREATE UNIQUE INDEX memberships_one_owner
  ON memberships (project_id)
  WHERE role = 'owner';

CREATE INDEX memberships_user_id ON memberships (user_id);

CREATE TABLE invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  email text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  status text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invites_email_shape CHECK (
    email = lower(email) AND email LIKE '%_@_%._%'
  ),
  CONSTRAINT invites_status CHECK (
    status IN ('pending', 'accepted', 'declined', 'revoked', 'expired')
  ),
  CONSTRAINT invites_token_hash_length CHECK (length(token_hash) >= 32)
);

CREATE UNIQUE INDEX invites_one_pending_email
  ON invites (project_id, email)
  WHERE status = 'pending';

CREATE TABLE project_briefs (
  project_id uuid PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
  content jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_briefs_content_object CHECK (jsonb_typeof(content) = 'object')
);

CREATE TABLE provider_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  provider text NOT NULL,
  encrypted_secret bytea NOT NULL,
  secret_nonce bytea NOT NULL,
  encryption_key_version integer NOT NULL DEFAULT 1,
  label text NOT NULL,
  status text NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  fallback_order integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_credentials_provider_shape CHECK (
    provider ~ '^[a-z][a-z0-9_]{1,31}$'
  ),
  CONSTRAINT provider_credentials_secret_present CHECK (
    octet_length(encrypted_secret) > 0 AND octet_length(secret_nonce) > 0
  ),
  CONSTRAINT provider_credentials_key_version CHECK (encryption_key_version >= 1),
  CONSTRAINT provider_credentials_label_present CHECK (length(btrim(label)) > 0),
  CONSTRAINT provider_credentials_status CHECK (
    status IN ('active', 'exhausted', 'disabled')
  ),
  CONSTRAINT provider_credentials_fallback_order CHECK (fallback_order >= 0),
  UNIQUE (project_id, fallback_order),
  UNIQUE (id, project_id)
);

CREATE UNIQUE INDEX provider_credentials_one_primary
  ON provider_credentials (project_id)
  WHERE is_primary;

CREATE TABLE skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL,
  name text NOT NULL,
  system_prompt_pack text NOT NULL,
  version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT skills_slug_shape CHECK (slug ~ '^[a-z][a-z0-9_]{1,63}$'),
  CONSTRAINT skills_name_present CHECK (length(btrim(name)) > 0),
  CONSTRAINT skills_version CHECK (version >= 1),
  UNIQUE (slug, version)
);

CREATE TABLE agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  kind text NOT NULL,
  name text NOT NULL,
  skill_id uuid REFERENCES skills (id) ON DELETE RESTRICT,
  status text NOT NULL,
  credential_id uuid,
  model_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agents_kind CHECK (kind IN ('orchestrator', 'specialist')),
  CONSTRAINT agents_name_present CHECK (length(btrim(name)) > 0),
  CONSTRAINT agents_status CHECK (
    status IN ('idle', 'working', 'awaiting_approval')
  ),
  CONSTRAINT agents_model_present CHECK (
    model_id IS NULL OR length(btrim(model_id)) > 0
  ),
  UNIQUE (id, project_id),
  FOREIGN KEY (credential_id, project_id)
    REFERENCES provider_credentials (id, project_id)
);

CREATE UNIQUE INDEX agents_one_orchestrator
  ON agents (project_id)
  WHERE kind = 'orchestrator';

CREATE TABLE channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id),
  UNIQUE (id, agent_id),
  UNIQUE (id, project_id),
  FOREIGN KEY (agent_id, project_id)
    REFERENCES agents (id, project_id)
    ON DELETE CASCADE
);

CREATE TABLE agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  kind text NOT NULL,
  status text NOT NULL,
  credential_id_used uuid,
  model_used text,
  token_in integer NOT NULL DEFAULT 0,
  token_out integer NOT NULL DEFAULT 0,
  cost_est numeric(14, 6) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_runs_kind CHECK (kind IN ('main', 'qa')),
  CONSTRAINT agent_runs_status CHECK (
    status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')
  ),
  CONSTRAINT agent_runs_tokens CHECK (token_in >= 0 AND token_out >= 0),
  CONSTRAINT agent_runs_cost CHECK (cost_est >= 0),
  FOREIGN KEY (channel_id, agent_id)
    REFERENCES channels (id, agent_id)
    ON DELETE CASCADE,
  FOREIGN KEY (channel_id, project_id)
    REFERENCES channels (id, project_id)
    ON DELETE CASCADE,
  FOREIGN KEY (credential_id_used, project_id)
    REFERENCES provider_credentials (id, project_id)
);

CREATE INDEX agent_runs_channel_created ON agent_runs (channel_id, created_at);

CREATE TABLE agent_run_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES agent_runs (id) ON DELETE CASCADE,
  step_index integer NOT NULL,
  iteration integer NOT NULL,
  type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_run_steps_index CHECK (step_index >= 1),
  CONSTRAINT agent_run_steps_iteration CHECK (iteration >= 1),
  CONSTRAINT agent_run_steps_type CHECK (type IN ('llm', 'trace', 'tool')),
  CONSTRAINT agent_run_steps_payload_object CHECK (jsonb_typeof(payload) = 'object'),
  UNIQUE (run_id, step_index)
);

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id uuid NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  author_kind text NOT NULL,
  author_user_id uuid REFERENCES users (id) ON DELETE RESTRICT,
  body text NOT NULL,
  run_id uuid REFERENCES agent_runs (id) ON DELETE SET NULL,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT messages_author_shape CHECK (
    (
      author_kind = 'user'
      AND author_user_id IS NOT NULL
    )
    OR (
      author_kind IN ('agent', 'system')
      AND author_user_id IS NULL
    )
  ),
  CONSTRAINT messages_idempotency_present CHECK (
    idempotency_key IS NULL OR length(idempotency_key) > 0
  ),
  UNIQUE (id, channel_id)
);

CREATE INDEX messages_channel_created ON messages (channel_id, created_at);

CREATE UNIQUE INDEX messages_idempotency
  ON messages (channel_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  status text NOT NULL,
  body jsonb NOT NULL,
  resolved_by_user_id uuid REFERENCES users (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plans_status CHECK (
    status IN ('draft', 'awaiting', 'approved', 'rejected')
  ),
  CONSTRAINT plans_body_object CHECK (jsonb_typeof(body) = 'object'),
  CONSTRAINT plans_resolution_shape CHECK (
    (
      status IN ('approved', 'rejected')
      AND resolved_by_user_id IS NOT NULL
    )
    OR (
      status IN ('draft', 'awaiting')
      AND resolved_by_user_id IS NULL
    )
  )
);

CREATE TABLE decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  status text NOT NULL,
  proposal text NOT NULL,
  proposed_by_user_id uuid REFERENCES users (id) ON DELETE RESTRICT,
  proposed_by_agent_id uuid REFERENCES agents (id) ON DELETE RESTRICT,
  accepted_by_user_id uuid REFERENCES users (id) ON DELETE RESTRICT,
  origin_channel_id uuid REFERENCES channels (id) ON DELETE SET NULL,
  impact_agent_ids uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT decisions_status CHECK (
    status IN ('pending', 'accepted', 'rejected')
  ),
  CONSTRAINT decisions_proposal_present CHECK (length(btrim(proposal)) > 0),
  CONSTRAINT decisions_one_proposer CHECK (
    (
      proposed_by_user_id IS NOT NULL
      AND proposed_by_agent_id IS NULL
    )
    OR (
      proposed_by_user_id IS NULL
      AND proposed_by_agent_id IS NOT NULL
    )
  ),
  CONSTRAINT decisions_accept_shape CHECK (
    (
      status = 'accepted'
      AND accepted_by_user_id IS NOT NULL
    )
    OR (
      status <> 'accepted'
      AND accepted_by_user_id IS NULL
    )
  )
);

CREATE FUNCTION decisions_same_project() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.origin_channel_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM channels
      WHERE id = NEW.origin_channel_id
        AND project_id = NEW.project_id
    ) THEN
      RAISE EXCEPTION 'decision origin channel must belong to the same project'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(NEW.impact_agent_ids) AS impact_agent_id
    WHERE NOT EXISTS (
      SELECT 1
      FROM agents
      WHERE id = impact_agent_id
        AND project_id = NEW.project_id
    )
  ) THEN
    RAISE EXCEPTION 'impact agents must belong to the decision project'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER decisions_same_project
  BEFORE INSERT OR UPDATE ON decisions
  FOR EACH ROW
  EXECUTE FUNCTION decisions_same_project();

CREATE TABLE decision_supports (
  decision_id uuid NOT NULL REFERENCES decisions (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (decision_id, user_id)
);

CREATE TABLE conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id uuid NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  options jsonb NOT NULL,
  status text NOT NULL,
  resolved_by_user_id uuid REFERENCES users (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CONSTRAINT conflicts_options_array CHECK (jsonb_typeof(options) = 'array'),
  CONSTRAINT conflicts_status CHECK (status IN ('open', 'resolved')),
  CONSTRAINT conflicts_resolution_shape CHECK (
    (
      status = 'resolved'
      AND resolved_by_user_id IS NOT NULL
      AND resolved_at IS NOT NULL
    )
    OR (
      status = 'open'
      AND resolved_by_user_id IS NULL
      AND resolved_at IS NULL
    )
  )
);

CREATE UNIQUE INDEX conflicts_one_open
  ON conflicts (channel_id)
  WHERE status = 'open';

CREATE TABLE instruction_queue_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id uuid NOT NULL,
  message_id uuid NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT instruction_queue_items_status CHECK (
    status IN ('pending', 'completed', 'cancelled')
  ),
  UNIQUE (message_id),
  FOREIGN KEY (message_id, channel_id)
    REFERENCES messages (id, channel_id)
    ON DELETE CASCADE
);

CREATE INDEX instruction_queue_items_channel_status
  ON instruction_queue_items (channel_id, status);

CREATE TABLE agent_summaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  agent_id uuid,
  summary text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_summaries_summary_present CHECK (length(btrim(summary)) > 0),
  FOREIGN KEY (agent_id, project_id)
    REFERENCES agents (id, project_id)
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX agent_summaries_one_per_agent
  ON agent_summaries (agent_id)
  WHERE agent_id IS NOT NULL;

CREATE UNIQUE INDEX agent_summaries_one_project_level
  ON agent_summaries (project_id)
  WHERE agent_id IS NULL;

COMMENT ON TABLE users IS 'SoT User';
COMMENT ON TABLE projects IS 'SoT Project';
COMMENT ON TABLE memberships IS 'SoT Membership';
COMMENT ON TABLE invites IS 'SoT Invite';
COMMENT ON TABLE provider_credentials IS 'SoT ProviderCredential';
COMMENT ON TABLE skills IS 'SoT Skill';
COMMENT ON TABLE agents IS 'SoT Agent';
COMMENT ON TABLE channels IS 'SoT Channel';
COMMENT ON TABLE messages IS 'SoT Message';
COMMENT ON TABLE agent_runs IS 'SoT AgentRun';
COMMENT ON TABLE agent_run_steps IS 'SoT AgentRunStep';
COMMENT ON TABLE plans IS 'SoT Plan';
COMMENT ON TABLE decisions IS 'SoT Decision';
COMMENT ON TABLE decision_supports IS 'Member support for a Decision (ADR-023). Non-binding.';
COMMENT ON TABLE project_briefs IS 'SoT ProjectBrief';
COMMENT ON TABLE conflicts IS 'SoT Conflict';
COMMENT ON TABLE instruction_queue_items IS 'SoT InstructionQueueItem';
COMMENT ON TABLE agent_summaries IS 'SoT AgentSummary';
COMMENT ON COLUMN provider_credentials.encrypted_secret IS 'Envelope ciphertext. Never store the provider API key in plaintext.';
COMMENT ON COLUMN invites.token_hash IS 'Hash of the invite token. Never store the raw token.';
