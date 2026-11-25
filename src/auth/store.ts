export interface User {
  id: string;
  name: string;
  email: string;
}

export interface SessionResponse {
  accessToken: string;
  accessExpiresAt: string;
  refreshToken: string;
  refreshExpiresAt: string;
  user: User;
}

export type AttemptStatus =
  | { kind: "open" }
  | { kind: "processing"; codeHash: string; leaseUntil: number }
  | { kind: "completed"; codeHash: string; replayUntil: number; replay: string }
  | { kind: "failed"; codeHash: string; status: number; error: string };

export interface Attempt {
  id: string;
  state: string;
  challenge: string;
  expiresAt: number;
  status: AttemptStatus;
}

export interface Session {
  id: string;
  userId: string;
  attemptId: string;
  accessHash: string;
  accessExpiresAt: number;
  refreshHash: string;
  expiresAt: number;
}

export interface AuthTransaction {
  usage(now: number): Promise<{ attempts: number; processing: number; sessions: number; users: number }>;
  attempt(id: string): Promise<Attempt | null>;
  saveAttempt(attempt: Attempt): Promise<void>;
  deleteAttempt(id: string): Promise<void>;
  user(id: string): Promise<User | null>;
  userByRitaId(ritaId: string): Promise<User | null>;
  upsertUser(ritaId: string, user: User): Promise<User>;
  sessionByRefresh(hash: string): Promise<Session | null>;
  saveSession(session: Session): Promise<void>;
  deleteSession(id: string): Promise<void>;
  prune(now: number): Promise<void>;
}

export interface AuthStore {
  transaction<T>(work: (transaction: AuthTransaction) => Promise<T>): Promise<T>;
  userByAccess(hash: string, now: number): Promise<User | null>;
}
