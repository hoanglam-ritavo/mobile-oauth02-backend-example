import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type RequestListener } from "node:http";
import { test, type TestContext } from "node:test";
import express from "express";
import { createApp } from "../src/app.ts";
import { readConfig } from "../src/config.ts";
import { AuthError } from "../src/errors.ts";
import { MobileAuth } from "../src/mobile-auth.ts";
import { createRitaClient, type RitaClient } from "../src/rita.ts";

const config = readConfig({
  RITA_API_BASE_URL: "https://id.example.invalid/api/",
  RITA_CLIENT_ID: "example client",
  RITA_CLIENT_SECRET: "fictional+secret:with delimiter",
  RITA_REDIRECT_URI: "rita-id-app://redirect",
});
const verifier = "a".repeat(43);
const challenge = createHash("sha256").update(verifier).digest("base64url");
const profile = { id: "29dc350d-1a0c-4085-919d-6d234af8dd73", name: "Nhân viên", email: "employee@example.invalid" };
const startTime = Date.parse("2030-01-01T00:00:00Z");

function fixture(rita: RitaClient = { identify: async () => profile }) {
  let time = startTime;
  const auth = new MobileAuth(config, rita, () => time);
  return {
    auth,
    advance: (milliseconds: number) => { time += milliseconds; },
    start: (code = "example-code") => {
      const { attemptId, state } = auth.start(challenge);
      return { attemptId, state, code, codeVerifier: verifier };
    },
  };
}

test("proof and expiry checks precede any request to Rita", async () => {
  let calls = 0;
  const { auth, start, advance } = fixture({ identify: async () => { calls++; return profile; } });
  const attempt = start();
  assert.throws(() => auth.complete({ ...attempt, state: "wrong" }), /LOGIN_PROOF_MISMATCH/);
  assert.throws(() => auth.complete({ ...attempt, codeVerifier: "b".repeat(43) }), /LOGIN_PROOF_MISMATCH/);
  advance(10 * 60_000);
  assert.throws(() => auth.complete(attempt), /LOGIN_RESTART_REQUIRED/);
  assert.equal(calls, 0);
});

test("concurrent and repeated completion return one token pair", async () => {
  let calls = 0;
  const { promise, resolve } = Promise.withResolvers<typeof profile>();
  const { auth, start, advance } = fixture({ identify: () => { calls++; return promise; } });
  const attempt = start();
  const first = auth.complete(attempt);
  const second = auth.complete(attempt);
  assert.throws(() => auth.complete({ ...attempt, code: "different-code" }), /LOGIN_ATTEMPT_CONFLICT/);
  resolve(profile);
  const result = await first;
  assert.deepEqual(await second, result);
  assert.deepEqual(await auth.complete(attempt), result);
  assert.equal(calls, 1);
  advance(60_000);
  auth.prune();
  assert.throws(() => auth.complete(attempt), /LOGIN_RESTART_REQUIRED/);
  assert.deepEqual(auth.me(result.accessToken), result.user);
});

test("a late Rita response cannot create a session for an expired attempt", async () => {
  const { promise, resolve } = Promise.withResolvers<typeof profile>();
  const { auth, start, advance } = fixture({ identify: () => promise });
  const pending = auth.complete(start());
  advance(10 * 60_000);
  resolve(profile);
  await assert.rejects(pending, /LOGIN_RESTART_REQUIRED/);
});

test("ambiguous upstream failure closes the attempt without repeating the exchange", async () => {
  let calls = 0;
  const { auth, start } = fixture({ identify: () => { calls++; throw new Error("fictional transport error"); } });
  const attempt = start();
  await assert.rejects(auth.complete(attempt), /RITA_LOGIN_RESTART_REQUIRED/);
  assert.throws(() => auth.complete(attempt), /RITA_LOGIN_RESTART_REQUIRED/);
  assert.equal(calls, 1);
});

test("new email syncs by Rita UUID and is visible to established sessions", async () => {
  let upstream = { ...profile };
  const { auth, start } = fixture({ identify: async () => upstream });
  const first = await auth.complete(start());
  upstream = { ...profile, name: "Tên cập nhật", email: "updated@example.invalid" };
  const second = await auth.complete(start("next-code"));
  assert.equal(first.user.id, second.user.id);
  assert.notEqual(second.user.id, profile.id);
  assert.deepEqual(auth.me(first.accessToken), second.user);
  upstream = { ...upstream, id: "5c845a02-1075-4b4e-84de-560792b7b0e6" };
  assert.notEqual((await auth.complete(start("different-uuid"))).user.id, second.user.id);
});

test("refresh rotates both tokens, ends login replay and preserves the absolute deadline", async () => {
  const { auth, start, advance } = fixture();
  const attempt = start();
  const first = await auth.complete(attempt);
  advance(30_000);
  const second = auth.refresh(first.refreshToken);
  assert.notEqual(second.accessToken, first.accessToken);
  assert.notEqual(second.refreshToken, first.refreshToken);
  assert.equal(second.refreshExpiresAt, first.refreshExpiresAt);
  assert.throws(() => auth.refresh(first.refreshToken), /INVALID_SESSION/);
  assert.throws(() => auth.me(first.accessToken), /INVALID_SESSION/);
  assert.throws(() => auth.complete(attempt), /LOGIN_RESTART_REQUIRED/);
  advance(15 * 60_000);
  assert.throws(() => auth.me(second.accessToken), /INVALID_SESSION/);
  const third = auth.refresh(second.refreshToken);
  advance(24 * 60 * 60_000);
  auth.prune();
  assert.throws(() => auth.refresh(third.refreshToken), /INVALID_SESSION/);
});

test("logout and restart invalidate credentials", async () => {
  const { auth, start } = fixture();
  const attempt = start();
  const session = await auth.complete(attempt);
  assert.throws(() => fixture().auth.me(session.accessToken), /INVALID_SESSION/);
  auth.logout(session.refreshToken);
  auth.logout(session.refreshToken);
  assert.throws(() => auth.me(session.accessToken), /INVALID_SESSION/);
  assert.throws(() => auth.refresh(session.refreshToken), /INVALID_SESSION/);
  assert.throws(() => auth.complete(attempt), /LOGIN_RESTART_REQUIRED/);
});

test("Rita sends confidential credentials only on token exchange and maps UserInfo", async () => {
  const requests: Array<[string, RequestInit]> = [];
  const fakeFetch: typeof fetch = async (url, options = {}) => {
    requests.push([String(url), options]);
    if (requests.length === 1) {
      return Response.json({ token_type: "Bearer", access_token: "fictional-access", refresh_token: "fictional-refresh" });
    }
    return Response.json({
      _id: profile.id, name: profile.name, email: profile.email, groups: "EMPLOYEE",
      active: true, position: null, phone_number: "fictional-phone",
    });
  };
  assert.deepEqual(await createRitaClient(config, fakeFetch).identify("example-code", verifier), profile);
  const [url, options] = requests[0]!;
  assert.equal(url, "https://id.example.invalid/api/auth/oauth/token");
  assert.equal(options.method, "POST");
  assert.equal(options.redirect, "error");
  const basic = new Headers(options.headers).get("authorization")!;
  assert.equal(Buffer.from(basic.slice(6), "base64").toString(), "example+client:fictional%2Bsecret%3Awith+delimiter");
  assert.deepEqual(JSON.parse(String(options.body)), {
    grant_type: "authorization_code", code: "example-code", code_verifier: verifier, redirect_uri: config.redirectUri,
  });
  assert.equal(requests[1]?.[0], "https://id.example.invalid/api/auth/oauth/userinfo");
  assert.deepEqual(new Headers(requests[1]?.[1].headers).get("authorization"), "Bearer fictional-access");
});

test("Rita rejections, invalid profiles and transport errors are controlled", async () => {
  const rejected = createRitaClient(config, async () => Response.json({ error: "invalid_grant" }, { status: 400 }));
  await assert.rejects(rejected.identify("expired", verifier), (error: AuthError) =>
    error.status === 401 && error.code === "RITA_LOGIN_RESTART_REQUIRED");
  const unavailable = createRitaClient(config, async () => { throw new TypeError("fictional network failure"); });
  await assert.rejects(unavailable.identify("code", verifier), /RITA_LOGIN_RESTART_REQUIRED/);

  for (const [patch, code] of [
    [{ active: false }, "RITA_ACCOUNT_INELIGIBLE"],
    [{ groups: "DEVELOPER" }, "RITA_ACCOUNT_INELIGIBLE"],
    [{ _id: null }, "RITA_BAD_RESPONSE"],
    [{ active: "true" }, "RITA_BAD_RESPONSE"],
  ] as const) {
    const rita = createRitaClient(config, async (url) => String(url).endsWith("/token")
      ? Response.json({ token_type: "Bearer", access_token: "fictional-access" })
      : Response.json(Object.assign({ _id: profile.id, name: profile.name, email: profile.email, active: true, groups: "EMPLOYEE" }, patch)));
    await assert.rejects(rita.identify("code", verifier), { message: code });
  }
});

async function serve(context: TestContext, handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return "http://127.0.0.1:" + address.port;
}

test("C and Rita HTTP contracts complete once and manage the private session", async (context) => {
  const tokenRequests: Array<{ authorization?: string; body: unknown }> = [];
  const userInfoHeaders: Array<string | undefined> = [];
  const rita = express();
  rita.use(express.json());
  rita.post("/api/auth/oauth/token", (req, res) => {
    tokenRequests.push({ authorization: req.get("authorization"), body: req.body });
    res.json({ token_type: "Bearer", access_token: "fictional-access", refresh_token: "fictional-refresh" });
  });
  rita.get("/api/auth/oauth/userinfo", (req, res) => {
    userInfoHeaders.push(req.get("authorization"));
    res.json({ _id: profile.id, name: profile.name, email: profile.email, groups: "EMPLOYEE", active: true });
  });
  const ritaOrigin = await serve(context, rita);
  const { auth } = fixture(createRitaClient({ ...config, apiBaseUrl: ritaOrigin + "/api" }));
  const cOrigin = await serve(context, createApp(auth, () => {}));
  const request = (path: string, options?: RequestInit) => fetch(cOrigin + "/api/mobile" + path, options);
  const post = (path: string, body: unknown) => request(path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  assert.equal((await request("/me")).status, 401);
  assert.equal((await post("/auth/session", { accessToken: "upstream" })).status, 400);
  assert.equal((await post("/auth/attempts", { codeChallenge: "invalid" })).status, 400);

  const start = await post("/auth/attempts", { codeChallenge: challenge });
  assert.equal(start.status, 201);
  assert.equal(start.headers.get("cache-control"), "no-store");
  const { attemptId, state, expiresAt, clientId, redirectUri, scope } = await start.json();
  assert.equal(clientId, config.clientId);
  assert.equal(redirectUri, config.redirectUri);
  assert.equal(scope, "openid profile email");
  assert.equal(Date.parse(expiresAt), startTime + 10 * 60_000);

  const completion = { attemptId, state, code: "example-code", codeVerifier: verifier };
  const [finish, duplicate] = await Promise.all([
    post("/auth/session", completion),
    post("/auth/session", completion),
  ]);
  assert.equal(finish.status, 200);
  assert.equal(duplicate.status, 200);
  const response = await finish.json();
  assert.deepEqual(await duplicate.json(), response);
  assert.deepEqual(tokenRequests, [{
    authorization: "Basic " + Buffer.from("example+client:fictional%2Bsecret%3Awith+delimiter").toString("base64"),
    body: {
      grant_type: "authorization_code", code: "example-code",
      code_verifier: verifier, redirect_uri: config.redirectUri,
    },
  }]);
  assert.deepEqual(userInfoHeaders, ["Bearer fictional-access"]);
  assert.notEqual(response.user.id, profile.id);
  assert.equal(response.user.email, profile.email);
  assert.deepEqual(Object.keys(response).sort(), ["accessExpiresAt", "accessToken", "refreshExpiresAt", "refreshToken", "user"]);
  assert.deepEqual(Object.keys(response.user).sort(), ["email", "id", "name"]);
  const bearer = (accessToken: string) => ({ headers: { Authorization: "Bearer " + accessToken } });
  assert.deepEqual(await (await request("/me", bearer(response.accessToken))).json(), { user: response.user });

  const refreshed = await post("/auth/refresh", { refreshToken: response.refreshToken });
  assert.equal(refreshed.status, 200);
  const session = await refreshed.json();
  assert.equal((await request("/me", bearer(response.accessToken))).status, 401);
  assert.equal((await post("/auth/logout", { refreshToken: session.refreshToken })).status, 204);
  assert.equal((await post("/auth/logout", { refreshToken: session.refreshToken })).status, 204);
  assert.equal((await request("/me", bearer(session.accessToken))).status, 401);
});
