import { EntitySchema } from "typeorm";

const users = new EntitySchema({
  name: "mobile_users",
  columns: {
    id: { type: "uuid", primary: true, primaryKeyConstraintName: "mobile_users_pkey" },
    rita_id: { type: "uuid" },
    name: { type: "text" },
    email: { type: "text" },
  },
  uniques: [{ name: "mobile_users_rita_id_key", columns: ["rita_id"] }],
});

const attempts = new EntitySchema({
  name: "mobile_oauth_attempts",
  columns: {
    id: { type: "uuid", primary: true, primaryKeyConstraintName: "mobile_oauth_attempts_pkey" },
    state: { type: "text" },
    challenge: { type: "text" },
    expires_at: { type: "timestamptz" },
    kind: { type: "text" },
    code_hash: { type: "text", nullable: true },
    lease_until: { type: "timestamptz", nullable: true },
    replay_until: { type: "timestamptz", nullable: true },
    replay: { type: "text", nullable: true },
    error_status: { type: "integer", nullable: true },
    error_code: { type: "text", nullable: true },
  },
  checks: [{
    name: "mobile_oauth_attempts_check",
    expression: `
      (kind = 'open' AND code_hash IS NULL AND lease_until IS NULL
        AND replay_until IS NULL AND replay IS NULL AND error_status IS NULL AND error_code IS NULL)
      OR (kind = 'processing' AND code_hash IS NOT NULL AND lease_until IS NOT NULL
        AND replay_until IS NULL AND replay IS NULL AND error_status IS NULL AND error_code IS NULL)
      OR (kind = 'completed' AND code_hash IS NOT NULL AND lease_until IS NULL
        AND replay_until IS NOT NULL AND replay IS NOT NULL AND error_status IS NULL AND error_code IS NULL)
      OR (kind = 'failed' AND code_hash IS NOT NULL AND lease_until IS NULL
        AND replay_until IS NULL AND replay IS NULL AND error_status IS NOT NULL AND error_code IS NOT NULL)
    `,
  }],
  indices: [
    { name: "mobile_oauth_attempts_expires_idx", columns: ["expires_at"] },
    { name: "mobile_oauth_attempts_replay_idx", columns: ["replay_until"], where: "kind = 'completed'" },
  ],
});

const sessions = new EntitySchema({
  name: "mobile_sessions",
  columns: {
    id: { type: "uuid", primary: true, primaryKeyConstraintName: "mobile_sessions_pkey" },
    user_id: { type: "uuid" },
    attempt_id: { type: "uuid" },
    access_hash: { type: "text" },
    access_expires_at: { type: "timestamptz" },
    refresh_hash: { type: "text" },
    expires_at: { type: "timestamptz" },
  },
  foreignKeys: [{
    name: "mobile_sessions_user_id_fkey",
    target: users.options.name,
    columnNames: ["user_id"],
    referencedColumnNames: ["id"],
    onDelete: "NO ACTION",
    onUpdate: "NO ACTION",
  }],
  uniques: [
    { name: "mobile_sessions_attempt_id_key", columns: ["attempt_id"] },
    { name: "mobile_sessions_access_hash_key", columns: ["access_hash"] },
    { name: "mobile_sessions_refresh_hash_key", columns: ["refresh_hash"] },
  ],
  checks: [{ name: "mobile_sessions_check", expression: "access_expires_at <= expires_at" }],
  indices: [{ name: "mobile_sessions_expires_idx", columns: ["expires_at"] }],
});

export const entities = [users, attempts, sessions];
