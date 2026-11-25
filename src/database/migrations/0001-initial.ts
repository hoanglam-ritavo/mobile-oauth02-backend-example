export const initialSchema = `
  CREATE TABLE mobile_users (
    id uuid PRIMARY KEY,
    rita_id uuid NOT NULL UNIQUE,
    name text NOT NULL,
    email text NOT NULL
  );

  CREATE TABLE mobile_oauth_attempts (
    id uuid PRIMARY KEY,
    state text NOT NULL,
    challenge text NOT NULL,
    expires_at timestamptz NOT NULL,
    kind text NOT NULL,
    code_hash text,
    lease_until timestamptz,
    replay_until timestamptz,
    replay text,
    error_status integer,
    error_code text,
    CHECK (
      (kind = 'open' AND code_hash IS NULL AND lease_until IS NULL
        AND replay_until IS NULL AND replay IS NULL AND error_status IS NULL AND error_code IS NULL)
      OR (kind = 'processing' AND code_hash IS NOT NULL AND lease_until IS NOT NULL
        AND replay_until IS NULL AND replay IS NULL AND error_status IS NULL AND error_code IS NULL)
      OR (kind = 'completed' AND code_hash IS NOT NULL AND lease_until IS NULL
        AND replay_until IS NOT NULL AND replay IS NOT NULL AND error_status IS NULL AND error_code IS NULL)
      OR (kind = 'failed' AND code_hash IS NOT NULL AND lease_until IS NULL
        AND replay_until IS NULL AND replay IS NULL AND error_status IS NOT NULL AND error_code IS NOT NULL)
    )
  );
  CREATE INDEX mobile_oauth_attempts_expires_idx ON mobile_oauth_attempts (expires_at);
  CREATE INDEX mobile_oauth_attempts_replay_idx ON mobile_oauth_attempts (replay_until) WHERE kind = 'completed';

  CREATE TABLE mobile_sessions (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES mobile_users (id),
    attempt_id uuid NOT NULL UNIQUE,
    access_hash text NOT NULL UNIQUE,
    access_expires_at timestamptz NOT NULL,
    refresh_hash text NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    CHECK (access_expires_at <= expires_at)
  );
  CREATE INDEX mobile_sessions_expires_idx ON mobile_sessions (expires_at);
`;
