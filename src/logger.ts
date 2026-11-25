import { performance } from "node:perf_hooks";
import type { ConfigIssue } from "./config.ts";

type Level = "debug" | "info" | "warn" | "error";
export type LogLevel = "debug" | "info";
export type CallbackKind =
  | "partner_demo"
  | "rita_authorize_entry"
  | "expo_go_callback"
  | "expo_go_authorize_entry"
  | "other";
export type RitaOutcome =
  | "success"
  | "timeout"
  | "transport_error"
  | "invalid_grant"
  | "http_rejected"
  | "invalid_response"
  | "ineligible_account";

type AttemptFields = { requestId: string; attemptId: string };
export type LogEvent =
  | { event: "startup.listening"; host: string; port: number; ritaOrigin: string; callbackKind: CallbackKind }
  | { event: "startup.callback_warning"; callbackKind: "rita_authorize_entry" | "expo_go_authorize_entry" }
  | { event: "startup.failed"; code: string; setting?: string; issues?: ConfigIssue[]; hint?: string; host?: string; port?: number }
  | { event: "database.failed"; operation: "idle_connection" | "prune" | "close" }
  | {
      event: "http.request";
      requestId: string;
      attemptId?: string;
      method: string;
      route: string;
      outcome: "completed" | "closed_early";
      status?: number;
      durationMs: number;
      errorCode?: string;
    }
  | (AttemptFields & { event: "auth.attempt_reused"; outcome: "joined" | "replayed" | "cached_failure" })
  | (AttemptFields & { event: "auth.session_issued"; userAction: "created" | "updated" })
  | (AttemptFields & {
      event: "rita.request";
      operation: "token" | "userinfo";
      outcome: RitaOutcome;
      upstreamStatus?: number;
      durationMs: number;
      errorCode?: string;
    });

export type Logger = (level: Level, event: LogEvent) => void;
type LogSink = (level: Level, line: string) => void;

export interface RequestLog {
  logger: Logger;
  requestId: string;
  attemptId?: string;
}

export interface AttemptLog {
  logger: Logger;
  requestId: string;
  attemptId: string;
}

export function createLogger(
  logLevel: LogLevel = "info",
  sink: LogSink = (level, line) => console[level](line),
): Logger {
  return (level, event) => {
    if (level === "debug" && logLevel !== "debug") return;
    try {
      sink(level, JSON.stringify({ timestamp: new Date().toISOString(), level, ...event }));
    } catch {
      // A failed log sink must not affect request processing or token issuance.
    }
  };
}

export function durationMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

export function callbackKind(uri: string): CallbackKind {
  if (uri === "rita-partner-demo://redirect") return "partner_demo";
  const url = new URL(uri);
  if (url.protocol === "rita-id:" && url.host === "oauth" && url.pathname === "/authorize") {
    return "rita_authorize_entry";
  }
  if (url.protocol === "exp:" && url.hostname) {
    if (url.pathname === "/--/redirect") return "expo_go_callback";
    if (url.pathname === "/--/oauth/authorize") return "expo_go_authorize_entry";
  }
  return "other";
}
