import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { test, type TestContext } from "node:test";
import type { Pool } from "pg";
import { MobileAuth } from "../src/auth/mobile-auth.ts";
import type { SessionResponse } from "../src/auth/store.ts";
import { createAuthStore } from "../src/database/auth-store.ts";
import { createPool } from "../src/database/pool.ts";
import { assertSchema, migrateSchema } from "../src/database/schema.ts";
import { createApp } from "../src/http/app.ts";
import type { RitaClient } from "../src/integrations/rita.ts";

const databaseUrl = process.env.C_TEST_DATABASE_URL;
const replayKey = Buffer.alloc(32, 9);
const config = { clientId: "fixture-partner", redirectUri: "rita-partner-demo://redirect" };
const profile = { id: "29dc350d-1a0c-4085-919d-6d234af8dd73", name: "Nhân viên", email: "initial@example.invalid" };
const verifier = "a".repeat(43);
const challenge = createHash("sha256").update(verifier).digest("base64url");

function testPostgres(name: string, work: (context: TestContext, url: string) => Promise<void>) {
  test(name, { skip: !databaseUrl && "Set C_TEST_DATABASE_URL to a disposable PostgreSQL database", timeout: 25_000 },
    async context => { if (databaseUrl) await work(context, databaseUrl); });
}

async function database(context: TestContext, url: string) {
  const schema = "partner_test_" + randomUUID().replaceAll("-", "");
  const admin = createPool(url);
  const pools = new Set<Pool>();
  context.after(async () => {
    try {
      await Promise.all([...pools].map(pool => pool.end()));
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await admin.end();
    }
  });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  return {
    open() {
      const pool = createPool(url, "-c search_path=" + schema);
      pools.add(pool);
      return pool;
    },
    async close(pool: Pool) {
      if (pools.delete(pool)) await pool.end();
    },
  };
}

function authService(pool: Pool, rita: RitaClient, now = Date.now, key = replayKey) {
  return new MobileAuth(config, rita, createAuthStore(pool), key, now);
}

async function listen(context: TestContext, auth: MobileAuth) {
  const server = createServer(createApp(auth, () => {}));
  const stop = () => new Promise<void>(resolve => { server.close(() => resolve()); });
  context.after(stop);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const request = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${address.port}/api/mobile${path}`, init);
  return {
    stop,
    post: (path: string, body: unknown) => request(path, {
      method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" },
    }),
    me: (token: string) => request("/me", { headers: { Authorization: "Bearer " + token } }),
  };
}

async function response<T>(reply: Response, status: number): Promise<T> {
  const body: unknown = await reply.json();
  assert.equal(reply.status, status, JSON.stringify(body));
  return body as T;
}

function completion(attempt: { attemptId: string; state: string }, code = "fictional-code") {
  return { attemptId: attempt.attemptId, state: attempt.state, code, codeVerifier: verifier };
}

testPostgres("schema migration is repeatable and HTTP retries, refresh and identity survive C restart", async (context, url) => {
  const db = await database(context, url);
  const first = db.open();
  await assert.rejects(assertSchema(first));
  await migrateSchema(first);
  await migrateSchema(first);
  await assertSchema(first);
  let profileAtRita = profile;
  let exchanges = 0;
  const rita: RitaClient = { identify: async () => { exchanges++; return profileAtRita; } };

  const initial = await listen(context, authService(first, rita));
  const attempt = await response<{ attemptId: string; state: string }>(
    await initial.post("/auth/attempts", { codeChallenge: challenge }), 201);
  await initial.stop();
  await db.close(first);

  const middle = db.open();
  const afterAttempt = await listen(context, authService(middle, rita));
  const input = completion(attempt);
  const issued = await response<SessionResponse>(await afterAttempt.post("/auth/session", input), 200);
  await afterAttempt.stop();
  await db.close(middle);

  const last = db.open();
  const afterIssuance = await listen(context, authService(last, rita));
  assert.deepEqual(await response(await afterIssuance.me(issued.accessToken), 200), { user: issued.user });
  assert.deepEqual(await response(await afterIssuance.post("/auth/session", input), 200), issued);
  assert.equal(exchanges, 1);
  const stored = await last.query<{ replay: string; access_hash: string; refresh_hash: string }>(`
    SELECT a.replay, s.access_hash, s.refresh_hash FROM mobile_oauth_attempts a JOIN mobile_sessions s ON s.attempt_id = a.id
  `);
  const row = stored.rows[0]!;
  assert.match(row.replay, /^v1\./);
  assert.equal(row.replay.includes(issued.refreshToken) || row.replay.includes(issued.accessToken), false);
  assert.equal(row.access_hash, createHash("sha256").update(issued.accessToken).digest("base64url"));
  assert.equal(row.refresh_hash, createHash("sha256").update(issued.refreshToken).digest("base64url"));
  const differentKey = authService(last, rita, Date.now, Buffer.alloc(32, 5));
  await assert.rejects(differentKey.complete(input), /RITA_LOGIN_RESTART_REQUIRED/);

  const refreshed = await response<SessionResponse>(
    await afterIssuance.post("/auth/refresh", { refreshToken: issued.refreshToken }), 200);
  assert.notEqual(refreshed.refreshToken, issued.refreshToken);
  assert.equal(refreshed.refreshExpiresAt, issued.refreshExpiresAt);
  assert.equal((await afterIssuance.me(issued.accessToken)).status, 401);
  assert.equal((await afterIssuance.post("/auth/session", input)).status, 401);
  profileAtRita = { ...profile, name: "Tên mới", email: "updated@example.invalid" };
  const next = await response<{ attemptId: string; state: string }>(
    await afterIssuance.post("/auth/attempts", { codeChallenge: challenge }), 201);
  const signedIn = await response<SessionResponse>(
    await afterIssuance.post("/auth/session", completion(next, "next-code")), 200);
  assert.equal(signedIn.user.id, issued.user.id);
  assert.notEqual(signedIn.user.id, profile.id);
  assert.deepEqual(await response(await afterIssuance.me(refreshed.accessToken), 200), { user: signedIn.user });
  for (let i = 0; i < 2; i++) {
    assert.equal((await afterIssuance.post("/auth/logout", { refreshToken: refreshed.refreshToken })).status, 204);
  }
  assert.equal((await afterIssuance.me(refreshed.accessToken)).status, 401);
  assert.equal(exchanges, 2);
});

testPostgres("parallel DB clients share one completion and only one refresh can rotate", async (context, url) => {
  const db = await database(context, url);
  const first = db.open();
  const second = db.open();
  await migrateSchema(first);
  const { promise: started, resolve: markStarted } = Promise.withResolvers<void>();
  const { promise: identification, resolve } = Promise.withResolvers<typeof profile>();
  let calls = 0;
  const rita: RitaClient = { identify: () => { calls++; markStarted(); return identification; } };
  const a = authService(first, rita);
  const b = authService(second, rita);
  const input = completion(await a.start(challenge));
  const claim = a.complete(input);
  await started;
  const joined = b.complete(input);
  try {
    await assert.rejects(b.complete({ ...input, state: "wrong" }), /LOGIN_PROOF_MISMATCH/);
    await assert.rejects(b.complete({ ...input, code: "other-code" }), /LOGIN_ATTEMPT_CONFLICT/);
  } finally {
    resolve(profile);
  }
  const [left, right] = await Promise.all([claim, joined]);
  assert.deepEqual(left, right);
  assert.equal(calls, 1);
  assert.equal((await first.query("SELECT id FROM mobile_sessions")).rowCount, 1);
  const rotations = await Promise.allSettled([a.refresh(left.refreshToken), b.refresh(left.refreshToken)]);
  assert.equal(rotations.filter(result => result.status === "fulfilled").length, 1);
  const rejected = rotations.find(result => result.status === "rejected");
  assert.match(String(rejected?.reason), /INVALID_SESSION/);
  await assert.rejects(a.me(left.accessToken), /INVALID_SESSION/);
  await assert.rejects(b.complete(input), /LOGIN_RESTART_REQUIRED/);
});

testPostgres("a duplicate still waiting gets Retry-After and can replay after the claim completes", async (context, url) => {
  const db = await database(context, url);
  const pool = db.open();
  await migrateSchema(pool);
  const { promise: started, resolve: markStarted } = Promise.withResolvers<void>();
  const { promise: identification, resolve } = Promise.withResolvers<typeof profile>();
  let calls = 0;
  const auth = authService(pool, { identify: () => { calls++; markStarted(); return identification; } });
  const app = await listen(context, auth);
  const attempt = await response<{ attemptId: string; state: string }>(
    await app.post("/auth/attempts", { codeChallenge: challenge }), 201);
  const input = completion(attempt);
  const initial = app.post("/auth/session", input);
  await started;
  try {
    const duplicate = await app.post("/auth/session", input);
    assert.equal(duplicate.headers.get("retry-after"), "1");
    assert.equal((await response<{ error: string }>(duplicate, 503)).error, "CAPACITY_EXCEEDED");
  } finally {
    resolve(profile);
  }
  const issued = await response<SessionResponse>(await initial, 200);
  assert.deepEqual(await response(await app.post("/auth/session", input), 200), issued);
  assert.equal(calls, 1);
});

testPostgres("a failed commit rolls back user and session and prevents a second Rita exchange", async (context, url) => {
  const db = await database(context, url);
  const pool = db.open();
  await migrateSchema(pool);
  await pool.query(`
    CREATE FUNCTION fail_completion() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.kind = 'completed' THEN RAISE EXCEPTION 'fictional completion failure'; END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER fail_completion BEFORE UPDATE ON mobile_oauth_attempts
      FOR EACH ROW EXECUTE FUNCTION fail_completion();
  `);
  let calls = 0;
  const auth = authService(pool, { identify: async () => { calls++; return profile; } });
  const input = completion(await auth.start(challenge));
  await assert.rejects(auth.complete(input), /RITA_LOGIN_RESTART_REQUIRED/);
  assert.equal((await pool.query("SELECT id FROM mobile_users")).rowCount, 0);
  assert.equal((await pool.query("SELECT id FROM mobile_sessions")).rowCount, 0);
  await assert.rejects(auth.complete(input), /RITA_LOGIN_RESTART_REQUIRED/);
  assert.equal(calls, 1);
});

testPostgres("expired claims require restart and the old attempt cannot issue a session", async (context, url) => {
  const db = await database(context, url);
  const first = db.open();
  const second = db.open();
  await migrateSchema(first);
  let time = Date.parse("2030-01-01T00:00:00Z");
  const { promise: started, resolve: markStarted } = Promise.withResolvers<void>();
  const { promise: identification, resolve } = Promise.withResolvers<typeof profile>();
  const original = authService(first, { identify: () => { markStarted(); return identification; } }, () => time);
  const input = completion(await original.start(challenge));
  const pending = original.complete(input);
  const rejected = assert.rejects(pending, /RITA_LOGIN_RESTART_REQUIRED/);
  await started;
  const restarted = authService(second, { identify: async () => { assert.fail("A claimed code must not be exchanged again"); } }, () => time);
  try {
    time += 15_000;
    await restarted.prune();
    await assert.rejects(restarted.complete(input), /RITA_LOGIN_RESTART_REQUIRED/);
  } finally {
    resolve(profile);
  }
  await rejected;
  assert.equal((await second.query("SELECT id FROM mobile_sessions")).rowCount, 0);
});

testPostgres("cleanup expires replay and sessions independently of user mappings", async (context, url) => {
  const db = await database(context, url);
  const pool = db.open();
  await migrateSchema(pool);
  let time = Date.parse("2030-01-01T00:00:00Z");
  const auth = authService(pool, { identify: async () => profile }, () => time);
  const input = completion(await auth.start(challenge));
  const issued = await auth.complete(input);
  const unused = completion(await auth.start(challenge));
  time += 60_000;
  await auth.prune();
  await assert.rejects(auth.complete(input), /LOGIN_RESTART_REQUIRED/);
  assert.deepEqual(await auth.me(issued.accessToken), issued.user);
  time += 9 * 60_000;
  await auth.prune();
  await assert.rejects(auth.complete(unused), /LOGIN_RESTART_REQUIRED/);
  time += 24 * 60 * 60_000;
  await auth.prune();
  await assert.rejects(auth.refresh(issued.refreshToken), /INVALID_SESSION/);
  assert.equal((await pool.query("SELECT id FROM mobile_sessions")).rowCount, 0);
  assert.equal((await pool.query("SELECT id FROM mobile_oauth_attempts")).rowCount, 0);
  assert.equal((await pool.query("SELECT id FROM mobile_users")).rowCount, 1);
});
