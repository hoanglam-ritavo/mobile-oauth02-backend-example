import type { Attempt, AuthStore, AuthTransaction, Session, User } from "../../src/auth/store.ts";

interface State {
  attempts: Map<string, Attempt>;
  users: Map<string, User>;
  sessions: Map<string, Session>;
}

const attemptDeadline = (attempt: Attempt) =>
  attempt.status.kind === "completed" ? attempt.status.replayUntil : attempt.expiresAt;

function memoryTransaction(state: State): AuthTransaction {
  return {
    async usage(now) {
      return {
        attempts: [...state.attempts.values()].filter(attempt => attemptDeadline(attempt) > now).length,
        processing: [...state.attempts.values()].filter(attempt =>
          attempt.status.kind === "processing" && attempt.status.leaseUntil > now).length,
        sessions: [...state.sessions.values()].filter(session => session.expiresAt > now).length,
        users: state.users.size,
      };
    },
    async attempt(id) { return state.attempts.get(id) ?? null; },
    async saveAttempt(attempt) { state.attempts.set(attempt.id, attempt); },
    async deleteAttempt(id) { state.attempts.delete(id); },
    async user(id) { return [...state.users.values()].find(user => user.id === id) ?? null; },
    async userByRitaId(ritaId) { return state.users.get(ritaId) ?? null; },
    async upsertUser(ritaId, user) {
      const saved = { ...user, id: state.users.get(ritaId)?.id ?? user.id };
      state.users.set(ritaId, saved);
      return saved;
    },
    async sessionByRefresh(hash) {
      return [...state.sessions.values()].find(session => session.refreshHash === hash) ?? null;
    },
    async saveSession(session) { state.sessions.set(session.id, session); },
    async deleteSession(id) { state.sessions.delete(id); },
    async prune(now) {
      for (const [id, attempt] of state.attempts) {
        if (attemptDeadline(attempt) <= now) state.attempts.delete(id);
      }
      for (const [id, session] of state.sessions) {
        if (session.expiresAt <= now) state.sessions.delete(id);
      }
    },
  };
}

export function createMemoryStore(): AuthStore {
  let state: State = { attempts: new Map(), users: new Map(), sessions: new Map() };
  let tail = Promise.resolve();
  return {
    transaction(work) {
      const result = tail.then(async () => {
        const next = structuredClone(state);
        const value = await work(memoryTransaction(next));
        state = next;
        return value;
      });
      tail = result.then(() => {}, () => {});
      return result;
    },
    async userByAccess(hash, now) {
      const session = [...state.sessions.values()].find(session =>
        session.accessHash === hash && Math.min(session.expiresAt, session.accessExpiresAt) > now);
      return session ? [...state.users.values()].find(user => user.id === session.userId) ?? null : null;
    },
  };
}
