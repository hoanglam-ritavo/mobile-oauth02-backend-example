import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { RitaConfig } from "./config.ts";
import { AuthError } from "./errors.ts";
import type { AttemptLog, RequestLog } from "./logger.ts";
import type { RitaClient } from "./rita.ts";

const minute = 60_000;
const attemptLifetime = 10 * minute;
const accessLifetime = 15 * minute;
const sessionLifetime = 24 * 60 * minute;
const storeLimit = 1_000;
const exchangeLimit = 20;

export interface User {
  id: string;
  name: string;
  email: string;
}

interface SessionResponse {
  accessToken: string;
  accessExpiresAt: string;
  refreshToken: string;
  refreshExpiresAt: string;
  user: User;
}

interface Session {
  user: User;
  attemptId: string;
  accessHash: string;
  accessExpiresAt: number;
  refreshHash: string;
  expiresAt: number;
}

type AttemptStatus =
  | { kind: "open" }
  | { kind: "processing"; codeHash: string; result: Promise<SessionResponse> }
  | { kind: "completed"; codeHash: string; result: SessionResponse; replayUntil: number }
  | { kind: "failed"; codeHash: string; error: AuthError };

interface Attempt {
  state: string;
  challenge: string;
  expiresAt: number;
  status: AttemptStatus;
}

interface Completion {
  attemptId: string;
  state: string;
  code: string;
  codeVerifier: string;
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function matches(left: string, right: string): boolean {
  return left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function iso(time: number): string {
  return new Date(time).toISOString();
}

function restart(): AuthError {
  return new AuthError(401, "LOGIN_RESTART_REQUIRED");
}

function capacity(): AuthError {
  return new AuthError(503, "CAPACITY_EXCEEDED");
}

export class MobileAuth {
  private readonly config: Pick<RitaConfig, "clientId" | "redirectUri">;
  private readonly rita: RitaClient;
  private readonly now: () => number;
  private readonly attempts = new Map<string, Attempt>();
  private readonly users = new Map<string, User>();
  private readonly byAccess = new Map<string, Session>();
  private readonly byRefresh = new Map<string, Session>();
  private exchanges = 0;

  constructor(
    config: Pick<RitaConfig, "clientId" | "redirectUri">,
    rita: RitaClient,
    now: () => number = Date.now,
  ) {
    this.config = config;
    this.rita = rita;
    this.now = now;
  }

  start(challenge: string) {
    this.prune();
    if (this.attempts.size >= storeLimit) throw capacity();
    const attemptId = randomUUID();
    const state = randomToken();
    const expiresAt = this.now() + attemptLifetime;
    this.attempts.set(attemptId, { state, challenge, expiresAt, status: { kind: "open" } });
    return {
      attemptId, state, expiresAt: iso(expiresAt), clientId: this.config.clientId,
      redirectUri: this.config.redirectUri, scope: "openid profile email",
    };
  }

  complete(input: Completion, log?: RequestLog): Promise<SessionResponse> {
    const attempt = this.attempts.get(input.attemptId);
    if (!attempt) throw restart();

    const status = attempt.status;
    const deadline = status.kind === "completed" ? status.replayUntil : attempt.expiresAt;
    if (this.now() >= deadline) {
      if (status.kind !== "processing") this.attempts.delete(input.attemptId);
      throw restart();
    }
    if (!matches(attempt.state, input.state) || !matches(attempt.challenge, digest(input.codeVerifier))) {
      throw new AuthError(400, "LOGIN_PROOF_MISMATCH");
    }

    let attemptLog: AttemptLog | undefined;
    if (log) {
      log.attemptId = input.attemptId;
      attemptLog = { logger: log.logger, requestId: log.requestId, attemptId: input.attemptId };
    }

    const codeHash = digest(input.code);
    if (status.kind !== "open") {
      if (!matches(status.codeHash, codeHash)) throw new AuthError(409, "LOGIN_ATTEMPT_CONFLICT");
      if (attemptLog) {
        const outcome = status.kind === "processing" ? "joined" : status.kind === "completed" ? "replayed" : "cached_failure";
        attemptLog.logger("debug", {
          event: "auth.attempt_reused", requestId: attemptLog.requestId, attemptId: input.attemptId, outcome,
        });
      }
      if (status.kind === "failed") throw status.error;
      return Promise.resolve(status.result);
    }

    this.prune();
    if (this.exchanges >= exchangeLimit || this.byRefresh.size + this.exchanges >= storeLimit) {
      throw capacity();
    }
    this.exchanges++;
    const result = Promise.resolve().then(() => this.exchange(attempt, input, codeHash, attemptLog));
    attempt.status = { kind: "processing", codeHash, result };
    return result;
  }

  private async exchange(attempt: Attempt, input: Completion, codeHash: string, log?: AttemptLog) {
    try {
      const identity = await this.rita.identify(input.code, input.codeVerifier, log);
      if (this.now() >= attempt.expiresAt) throw restart();

      let user = this.users.get(identity.id);
      const userAction = user ? "updated" : "created";
      if (!user) {
        if (this.users.size >= storeLimit) throw new AuthError(503, "USER_CAPACITY_EXCEEDED");
        user = { id: randomUUID(), name: identity.name, email: identity.email };
        this.users.set(identity.id, user);
      } else {
        user.name = identity.name;
        user.email = identity.email;
      }

      const now = this.now();
      const session: Session = {
        user, attemptId: input.attemptId, expiresAt: now + sessionLifetime,
        accessHash: "", accessExpiresAt: 0, refreshHash: "",
      };
      const result = this.issue(session, now);
      attempt.status = { kind: "completed", codeHash, result, replayUntil: now + minute };
      log?.logger("info", {
        event: "auth.session_issued", requestId: log.requestId, attemptId: log.attemptId, userAction,
      });
      return result;
    } catch (error) {
      const failure = error instanceof AuthError ? error : new AuthError(503, "RITA_LOGIN_RESTART_REQUIRED");
      attempt.status = { kind: "failed", codeHash, error: failure };
      throw failure;
    } finally {
      this.exchanges--;
    }
  }

  private issue(session: Session, now: number): SessionResponse {
    const accessToken = randomToken();
    const refreshToken = randomToken();
    session.accessHash = digest(accessToken);
    session.refreshHash = digest(refreshToken);
    session.accessExpiresAt = Math.min(now + accessLifetime, session.expiresAt);
    this.byAccess.set(session.accessHash, session);
    this.byRefresh.set(session.refreshHash, session);
    return {
      accessToken,
      accessExpiresAt: iso(session.accessExpiresAt),
      refreshToken,
      refreshExpiresAt: iso(session.expiresAt),
      user: { ...session.user },
    };
  }

  refresh(token: string): SessionResponse {
    const session = this.byRefresh.get(digest(token));
    if (!session) throw new AuthError(401, "INVALID_SESSION");
    const now = this.now();
    this.revoke(session);
    if (now >= session.expiresAt) throw new AuthError(401, "INVALID_SESSION");
    return this.issue(session, now);
  }

  me(token: string): User {
    const session = this.byAccess.get(digest(token));
    if (!session || this.now() >= session.accessExpiresAt) throw new AuthError(401, "INVALID_SESSION");
    return { ...session.user };
  }

  logout(token: string): void {
    const session = this.byRefresh.get(digest(token));
    if (session) this.revoke(session);
  }

  private revoke(session: Session): void {
    this.byAccess.delete(session.accessHash);
    this.byRefresh.delete(session.refreshHash);
    this.attempts.delete(session.attemptId);
  }

  prune(): void {
    const now = this.now();
    for (const [id, attempt] of this.attempts) {
      const status = attempt.status;
      const expiry = status.kind === "completed" ? status.replayUntil : attempt.expiresAt;
      if (status.kind !== "processing" && now >= expiry) this.attempts.delete(id);
    }
    for (const session of this.byRefresh.values()) {
      if (now >= session.expiresAt) this.revoke(session);
      else if (now >= session.accessExpiresAt) this.byAccess.delete(session.accessHash);
    }
  }
}
