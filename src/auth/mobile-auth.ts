import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import type { RitaConfig } from "../config.ts";
import { AuthError } from "../errors.ts";
import type { RitaClient } from "../integrations/rita.ts";
import type { AttemptLog, RequestLog } from "../logger.ts";
import { openReplay, sealReplay } from "./replay.ts";
import type { Attempt, AuthStore, Session, SessionResponse, User } from "./store.ts";

const minute = 60_000;
const attemptLifetime = 10 * minute;
const accessLifetime = 15 * minute;
const sessionLifetime = 24 * 60 * minute;
const storeLimit = 1_000;
const exchangeLimit = 20;
const claimLifetime = 15_000;
const joinWait = 8_000;

interface Completion {
  attemptId: string;
  state: string;
  code: string;
  codeVerifier: string;
}

type Admission =
  | { kind: "claimed"; leaseUntil: number }
  | { kind: "processing" }
  | { kind: "completed"; replay: string }
  | { kind: "failed"; status: number; error: string };

const restart = () => new AuthError(401, "LOGIN_RESTART_REQUIRED");
const ambiguous = () => new AuthError(503, "RITA_LOGIN_RESTART_REQUIRED");
const invalidSession = () => new AuthError(401, "INVALID_SESSION");

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function matches(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function issue(
  session: Pick<Session, "id" | "userId" | "attemptId" | "expiresAt">,
  user: User,
  now: number,
): { session: Session; result: SessionResponse } {
  const accessToken = randomToken();
  const refreshToken = randomToken();
  const accessExpiresAt = Math.min(now + accessLifetime, session.expiresAt);
  return {
    session: { ...session, accessHash: digest(accessToken), refreshHash: digest(refreshToken), accessExpiresAt },
    result: {
      accessToken, refreshToken, user,
      accessExpiresAt: new Date(accessExpiresAt).toISOString(),
      refreshExpiresAt: new Date(session.expiresAt).toISOString(),
    },
  };
}

export class MobileAuth {
  private readonly config: Pick<RitaConfig, "clientId" | "redirectUri">;
  private readonly rita: RitaClient;
  private readonly store: AuthStore;
  private readonly replayKey: Buffer;
  private readonly now: () => number;
  private readonly completions = new Set<Promise<SessionResponse>>();

  constructor(
    config: Pick<RitaConfig, "clientId" | "redirectUri">,
    rita: RitaClient,
    store: AuthStore,
    replayKey: Buffer,
    now: () => number = Date.now,
  ) {
    this.config = config;
    this.rita = rita;
    this.store = store;
    this.replayKey = replayKey;
    this.now = now;
  }

  async start(challenge: string) {
    const attempt = await this.store.transaction(async transaction => {
      const now = this.now();
      await transaction.prune(now);
      if ((await transaction.usage(now)).attempts >= storeLimit) throw new AuthError(503, "CAPACITY_EXCEEDED");
      const record: Attempt = {
        id: randomUUID(), state: randomToken(), challenge, expiresAt: now + attemptLifetime, status: { kind: "open" },
      };
      await transaction.saveAttempt(record);
      return record;
    });
    return {
      attemptId: attempt.id, state: attempt.state, expiresAt: new Date(attempt.expiresAt).toISOString(),
      clientId: this.config.clientId, redirectUri: this.config.redirectUri, scope: "openid profile email",
    };
  }

  complete(input: Completion, log?: RequestLog): Promise<SessionResponse> {
    const completion = this.completeAttempt(input, log);
    this.completions.add(completion);
    const remove = () => { this.completions.delete(completion); };
    void completion.then(remove, remove);
    return completion;
  }

  async drain(): Promise<void> {
    await Promise.allSettled(this.completions);
  }

  private async completeAttempt(input: Completion, log?: RequestLog): Promise<SessionResponse> {
    const proof = digest(input.codeVerifier);
    const codeHash = digest(input.code);
    const deadline = performance.now() + joinWait;
    let joined = false;
    for (;;) {
      const admission = await this.admit(input, proof, codeHash, log);
      const attemptLog = log && { logger: log.logger, requestId: log.requestId, attemptId: input.attemptId };
      switch (admission.kind) {
        case "claimed":
          return this.exchange(input, codeHash, admission.leaseUntil, attemptLog);
        case "completed":
          if (!joined) this.logReuse(attemptLog, "replayed");
          return openReplay(this.replayKey, input.attemptId, admission.replay);
        case "failed":
          if (!joined) this.logReuse(attemptLog, "cached_failure");
          throw new AuthError(admission.status, admission.error);
        case "processing": {
          if (!joined) this.logReuse(attemptLog, "joined");
          joined = true;
          const remaining = deadline - performance.now();
          if (remaining <= 0) throw new AuthError(503, "CAPACITY_EXCEEDED", 1);
          await delay(Math.min(100, remaining));
        }
      }
    }
  }

  private logReuse(log: AttemptLog | undefined, outcome: "joined" | "replayed" | "cached_failure") {
    log?.logger("debug", { event: "auth.attempt_reused", requestId: log.requestId, attemptId: log.attemptId, outcome });
  }

  private admit(input: Completion, proof: string, codeHash: string, log?: RequestLog): Promise<Admission> {
    return this.store.transaction(async transaction => {
      const now = this.now();
      const attempt = await transaction.attempt(input.attemptId);
      if (!attempt) throw restart();
      const { status } = attempt;
      if (now >= (status.kind === "completed" ? status.replayUntil : attempt.expiresAt)) throw restart();
      if (!matches(attempt.state, input.state) || !matches(attempt.challenge, proof)) {
        throw new AuthError(400, "LOGIN_PROOF_MISMATCH");
      }
      if (log) log.attemptId = input.attemptId;

      if (status.kind !== "open") {
        if (!matches(status.codeHash, codeHash)) throw new AuthError(409, "LOGIN_ATTEMPT_CONFLICT");
        if (status.kind === "processing" && now >= status.leaseUntil) throw ambiguous();
        return status;
      }

      const { processing, sessions } = await transaction.usage(now);
      if (processing >= exchangeLimit || sessions + processing >= storeLimit) {
        throw new AuthError(503, "CAPACITY_EXCEEDED");
      }
      const leaseUntil = Math.min(attempt.expiresAt, now + claimLifetime);
      attempt.status = { kind: "processing", codeHash, leaseUntil };
      await transaction.saveAttempt(attempt);
      return { kind: "claimed", leaseUntil };
    });
  }

  private async exchange(input: Completion, codeHash: string, leaseUntil: number, log?: AttemptLog) {
    try {
      const identity = await this.rita.identify(input.code, input.codeVerifier, log);
      const { result, userAction } = await this.store.transaction(async transaction => {
        const now = this.now();
        const attempt = await transaction.attempt(input.attemptId);
        if (!attempt || now >= attempt.expiresAt) throw restart();
        if (attempt.status.kind !== "processing" || attempt.status.codeHash !== codeHash ||
            now >= leaseUntil) throw ambiguous();

        const existing = await transaction.userByRitaId(identity.id);
        if (!existing && (await transaction.usage(now)).users >= storeLimit) {
          throw new AuthError(503, "USER_CAPACITY_EXCEEDED");
        }
        const user = await transaction.upsertUser(identity.id, {
          id: existing?.id ?? randomUUID(), name: identity.name, email: identity.email,
        });
        const { session, result } = issue({
          id: randomUUID(), userId: user.id, attemptId: attempt.id, expiresAt: now + sessionLifetime,
        }, user, now);
        await transaction.saveSession(session);
        attempt.status = { kind: "completed", codeHash, replayUntil: now + minute,
          replay: sealReplay(this.replayKey, attempt.id, result) };
        await transaction.saveAttempt(attempt);
        return { result, userAction: existing ? "updated" as const : "created" as const };
      });
      log?.logger("info", { event: "auth.session_issued", requestId: log.requestId, attemptId: log.attemptId, userAction });
      return result;
    } catch (error) {
      const failure = error instanceof AuthError ? error : ambiguous();
      await this.store.transaction(async transaction => {
        const attempt = await transaction.attempt(input.attemptId);
        if (attempt?.status.kind === "processing" && attempt.status.codeHash === codeHash) {
          attempt.status = { kind: "failed", codeHash, status: failure.status, error: failure.code };
          await transaction.saveAttempt(attempt);
        }
      });
      throw failure;
    }
  }

  refresh(token: string): Promise<SessionResponse> {
    return this.store.transaction(async transaction => {
      const now = this.now();
      const current = await transaction.sessionByRefresh(digest(token));
      if (!current || now >= current.expiresAt) throw invalidSession();
      const user = await transaction.user(current.userId);
      if (!user) throw invalidSession();
      const { session, result } = issue(current, user, now);
      await transaction.saveSession(session);
      await transaction.deleteAttempt(current.attemptId);
      return result;
    });
  }

  async me(token: string): Promise<User> {
    const user = await this.store.userByAccess(digest(token), this.now());
    if (!user) throw invalidSession();
    return user;
  }

  logout(token: string): Promise<void> {
    return this.store.transaction(async transaction => {
      const current = await transaction.sessionByRefresh(digest(token));
      if (!current) return;
      await transaction.deleteSession(current.id);
      await transaction.deleteAttempt(current.attemptId);
    });
  }

  prune(): Promise<void> {
    return this.store.transaction(transaction => transaction.prune(this.now()));
  }
}
