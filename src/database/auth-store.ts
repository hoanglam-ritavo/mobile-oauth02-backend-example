import type { Pool, PoolClient } from "pg";
import type { Attempt, AttemptStatus, AuthStore, AuthTransaction, Session, User } from "../auth/store.ts";
import { inTransaction } from "./pool.ts";

interface AttemptRow {
  id: string;
  state: string;
  challenge: string;
  expires_at: Date;
  kind: AttemptStatus["kind"];
  code_hash: string | null;
  lease_until: Date | null;
  replay_until: Date | null;
  replay: string | null;
  error_status: number | null;
  error_code: string | null;
}

interface SessionRow {
  id: string;
  user_id: string;
  attempt_id: string;
  access_hash: string;
  access_expires_at: Date;
  refresh_hash: string;
  expires_at: Date;
}

function attemptStatus(row: AttemptRow): AttemptStatus {
  // The table constraint requires the fields belonging to each status.
  switch (row.kind) {
    case "open":
      return { kind: "open" };
    case "processing":
      return { kind: "processing", codeHash: row.code_hash!, leaseUntil: row.lease_until!.getTime() };
    case "completed":
      return { kind: "completed", codeHash: row.code_hash!, replayUntil: row.replay_until!.getTime(), replay: row.replay! };
    case "failed":
      return { kind: "failed", codeHash: row.code_hash!, status: row.error_status!, error: row.error_code! };
  }
}

function pgTransaction(client: PoolClient): AuthTransaction {
  return {
    async usage(now) {
      const result = await client.query<Awaited<ReturnType<AuthTransaction["usage"]>>>(`
        SELECT
          (SELECT count(*)::int FROM mobile_oauth_attempts WHERE
            CASE WHEN kind = 'completed' THEN replay_until > $1 ELSE expires_at > $1 END) AS attempts,
          (SELECT count(*)::int FROM mobile_oauth_attempts WHERE kind = 'processing' AND lease_until > $1) AS processing,
          (SELECT count(*)::int FROM mobile_sessions WHERE expires_at > $1) AS sessions,
          (SELECT count(*)::int FROM mobile_users) AS users
      `, [new Date(now)]);
      return result.rows[0]!;
    },
    async attempt(id) {
      const result = await client.query<AttemptRow>("SELECT * FROM mobile_oauth_attempts WHERE id = $1", [id]);
      const row = result.rows[0];
      if (!row) return null;
      return { id: row.id, state: row.state, challenge: row.challenge,
        expiresAt: row.expires_at.getTime(), status: attemptStatus(row) };
    },
    async saveAttempt(attempt) {
      const { status } = attempt;
      await client.query(`
        INSERT INTO mobile_oauth_attempts
          (id, state, challenge, expires_at, kind, code_hash, lease_until, replay_until, replay, error_status, error_code)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (id) DO UPDATE SET kind = EXCLUDED.kind, code_hash = EXCLUDED.code_hash,
          lease_until = EXCLUDED.lease_until, replay_until = EXCLUDED.replay_until, replay = EXCLUDED.replay,
          error_status = EXCLUDED.error_status, error_code = EXCLUDED.error_code
      `, [
        attempt.id, attempt.state, attempt.challenge, new Date(attempt.expiresAt), status.kind,
        status.kind === "open" ? null : status.codeHash,
        status.kind === "processing" ? new Date(status.leaseUntil) : null,
        status.kind === "completed" ? new Date(status.replayUntil) : null,
        status.kind === "completed" ? status.replay : null,
        status.kind === "failed" ? status.status : null,
        status.kind === "failed" ? status.error : null,
      ]);
    },
    async deleteAttempt(id) {
      await client.query("DELETE FROM mobile_oauth_attempts WHERE id = $1", [id]);
    },
    async user(id) {
      const result = await client.query<User>("SELECT id, name, email FROM mobile_users WHERE id = $1", [id]);
      return result.rows[0] ?? null;
    },
    async userByRitaId(ritaId) {
      const result = await client.query<User>("SELECT id, name, email FROM mobile_users WHERE rita_id = $1", [ritaId]);
      return result.rows[0] ?? null;
    },
    async upsertUser(ritaId, user) {
      const result = await client.query<User>(`
        INSERT INTO mobile_users (id, rita_id, name, email) VALUES ($1, $2, $3, $4)
        ON CONFLICT (rita_id) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email
        RETURNING id, name, email
      `, [user.id, ritaId, user.name, user.email]);
      return result.rows[0]!;
    },
    async sessionByRefresh(hash) {
      const result = await client.query<SessionRow>("SELECT * FROM mobile_sessions WHERE refresh_hash = $1", [hash]);
      const row = result.rows[0];
      if (!row) return null;
      return { id: row.id, userId: row.user_id, attemptId: row.attempt_id,
        accessHash: row.access_hash, accessExpiresAt: row.access_expires_at.getTime(),
        refreshHash: row.refresh_hash, expiresAt: row.expires_at.getTime() };
    },
    async saveSession(session) {
      await client.query(`
        INSERT INTO mobile_sessions (id, user_id, attempt_id, access_hash, access_expires_at, refresh_hash, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (id) DO UPDATE SET access_hash = EXCLUDED.access_hash,
          refresh_hash = EXCLUDED.refresh_hash, access_expires_at = EXCLUDED.access_expires_at
      `, [session.id, session.userId, session.attemptId, session.accessHash, new Date(session.accessExpiresAt),
        session.refreshHash, new Date(session.expiresAt)]);
    },
    async deleteSession(id) {
      await client.query("DELETE FROM mobile_sessions WHERE id = $1", [id]);
    },
    async prune(now) {
      const cutoff = new Date(now);
      await client.query(`DELETE FROM mobile_oauth_attempts
        WHERE (kind = 'completed' AND replay_until <= $1) OR (kind <> 'completed' AND expires_at <= $1)`, [cutoff]);
      await client.query(`UPDATE mobile_oauth_attempts SET
        kind = 'failed', lease_until = NULL, error_status = 503, error_code = 'RITA_LOGIN_RESTART_REQUIRED'
        WHERE kind = 'processing' AND lease_until <= $1`, [cutoff]);
      await client.query("DELETE FROM mobile_sessions WHERE expires_at <= $1", [cutoff]);
    },
  };
}

export function createAuthStore(pool: Pool): AuthStore {
  return {
    transaction(work) {
      return inTransaction(pool, async client => {
        // Keep quota checks and auth mutations serialized per schema. Rita calls run outside this lock.
        await client.query("SELECT pg_advisory_xact_lock(hashtext(current_schema()), hashtext('mobile-auth'))");
        return work(pgTransaction(client));
      });
    },
    async userByAccess(hash, now) {
      const result = await pool.query<User>(`
        SELECT u.id, u.name, u.email
        FROM mobile_sessions s JOIN mobile_users u ON u.id = s.user_id
        WHERE s.access_hash = $1 AND s.access_expires_at > $2 AND s.expires_at > $2
      `, [hash, new Date(now)]);
      return result.rows[0] ?? null;
    },
  };
}
