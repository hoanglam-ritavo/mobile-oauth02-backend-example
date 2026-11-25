import { isIP } from "node:net";

export interface RitaConfig {
  apiBaseUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export class ConfigError extends Error {
  readonly setting: string;

  constructor(setting: string, message: string) {
    super(message);
    this.setting = setting;
  }
}

export interface ConfigIssue {
  setting: string;
  hint: string;
}

export class StartupConfigError extends Error {
  readonly issues: [ConfigIssue, ...ConfigIssue[]];

  constructor(issues: [ConfigIssue, ...ConfigIssue[]]) {
    super("Invalid startup configuration");
    this.issues = issues;
  }
}

function required(env: NodeJS.ProcessEnv, key: string, hint: string): string {
  const value = env[key];
  if (!value || value !== value.trim()) throw new ConfigError(key, hint);
  return value;
}

export function readDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const hint = "Set a PostgreSQL URL with a user and database dedicated to C";
  const value = required(env, "DATABASE_URL", hint);
  const url = URL.parse(value);
  if (!url || !["postgresql:", "postgres:"].includes(url.protocol) ||
      !url.hostname || !url.username || url.pathname.length <= 1 ||
      /[\x00-\x20\x7f\\#]/.test(value)) {
    throw new ConfigError("DATABASE_URL", hint);
  }
  return value;
}

export function readReplayKey(env: NodeJS.ProcessEnv): Buffer {
  const hint = "Set a persistent 32-byte key encoded as base64url without padding";
  const value = required(env, "OAUTH_REPLAY_KEY", hint);
  const key = Buffer.from(value, "base64url");
  if (key.length !== 32 || key.toString("base64url") !== value) {
    throw new ConfigError("OAUTH_REPLAY_KEY", hint);
  }
  return key;
}

function parseUrl(value: string, key: string, hint: string): URL {
  const url = URL.parse(value);
  if (!url || /[\x00-\x20\x7f\\#]/.test(value) || url.username || url.password) {
    throw new ConfigError(key, hint);
  }
  return url;
}

function isPrivateIPv4(hostname: string): boolean {
  if (isIP(hostname) !== 4) return false;
  const octets = hostname.split(".");
  const first = Number(octets[0]);
  const second = Number(octets[1]);
  return first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168);
}

function readApiBaseUrl(env: NodeJS.ProcessEnv, allowPrivateHttp: boolean): string {
  const allowedHttp = allowPrivateHttp ? "loopback or private IPv4 HTTP" : "loopback HTTP";
  const hint = `Set an HTTPS or ${allowedHttp} Rita API URL without credentials, a query, or a fragment`;
  const apiBaseUrl = required(env, "RITA_API_BASE_URL", hint);
  const api = parseUrl(apiBaseUrl, "RITA_API_BASE_URL", hint);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(api.hostname);
  const allowsHttp = loopback || (allowPrivateHttp && isPrivateIPv4(api.hostname));
  if (!/^https?:\/\//i.test(apiBaseUrl) || apiBaseUrl.includes("?") ||
      (api.protocol !== "https:" && !(api.protocol === "http:" && allowsHttp))) {
    throw new ConfigError("RITA_API_BASE_URL", hint);
  }
  return api.origin + api.pathname.replace(/\/+$/, "");
}

function readRedirectUri(env: NodeJS.ProcessEnv): string {
  const hint = "Set the registered HTTPS or native callback URL with a host or path, without credentials or a fragment";
  const redirectUri = required(env, "RITA_REDIRECT_URI", hint);
  const redirect = parseUrl(redirectUri, "RITA_REDIRECT_URI", hint);
  const blockedSchemes = [
    "http:", "file:", "data:", "javascript:", "vbscript:", "blob:", "about:",
    "intent:", "content:", "ftp:", "ws:", "wss:", "mailto:", "tel:", "sms:",
  ];
  if (redirect.protocol === "https:" ? !/^https:\/\//i.test(redirectUri) :
      !/^[a-z][a-z0-9+.-]*:\//i.test(redirectUri) || blockedSchemes.includes(redirect.protocol)) {
    throw new ConfigError("RITA_REDIRECT_URI", hint);
  }
  if (!redirect.hostname && !redirect.pathname.startsWith("/")) {
    throw new ConfigError("RITA_REDIRECT_URI", hint);
  }
  return redirectUri;
}

function readHost(env: NodeJS.ProcessEnv): string {
  const host = env.HOST ?? "127.0.0.1";
  if (host !== "localhost" && !isIP(host)) throw new ConfigError("HOST", "Set localhost or a literal IP address");
  return host;
}

function readPort(env: NodeJS.ProcessEnv): number {
  const portValue = env.PORT ?? "3005";
  const port = Number(portValue);
  if (!/^[0-9]+$/.test(portValue) || port < 1 || port > 65535) {
    throw new ConfigError("PORT", "Set an integer from 1 to 65535");
  }
  return port;
}

function readLogLevel(env: NodeJS.ProcessEnv) {
  const level = env.LOG_LEVEL ?? "info";
  if (level !== "info" && level !== "debug") throw new ConfigError("LOG_LEVEL", "Set info or debug");
  return level;
}

function readDatabaseSynchronize(env: NodeJS.ProcessEnv, synchronizeByDefault: boolean): boolean {
  const value = env.DATABASE_SYNCHRONIZE;
  if (value === undefined) return synchronizeByDefault;
  if (value !== "true" && value !== "false") {
    throw new ConfigError("DATABASE_SYNCHRONIZE", "Set true or false, or omit this setting to use the command default");
  }
  return value === "true";
}

function ritaSettings(env: NodeJS.ProcessEnv, allowPrivateHttp: boolean) {
  return {
    apiBaseUrl: () => readApiBaseUrl(env, allowPrivateHttp),
    redirectUri: () => readRedirectUri(env),
    host: () => readHost(env),
    port: () => readPort(env),
    clientId: () => required(env, "RITA_CLIENT_ID", "Set the registered confidential client ID without surrounding whitespace"),
    clientSecret: () => required(env, "RITA_CLIENT_SECRET", "Set the confidential client secret without surrounding whitespace"),
  };
}

function readSettings<T>(readers: { [K in keyof T]: () => T[K] }, collectErrors = false): T {
  const values = {} as T;
  const issues: ConfigIssue[] = [];
  for (const name in readers) {
    try {
      values[name] = readers[name]();
    } catch (error) {
      if (!collectErrors || !(error instanceof ConfigError)) throw error;
      issues.push({ setting: error.setting, hint: error.message });
    }
  }
  const [first, ...rest] = issues;
  if (first) throw new StartupConfigError([first, ...rest]);
  return values;
}

export function readConfig(
  env: NodeJS.ProcessEnv,
  { allowPrivateHttp = false }: { allowPrivateHttp?: boolean } = {},
): RitaConfig & { host: string; port: number } {
  return readSettings(ritaSettings(env, allowPrivateHttp));
}

export function readStartupConfig(
  env: NodeJS.ProcessEnv,
  { allowPrivateHttp = false, synchronizeByDefault = false }: {
    allowPrivateHttp?: boolean;
    synchronizeByDefault?: boolean;
  } = {},
) {
  return readSettings({
    logLevel: () => readLogLevel(env),
    ...ritaSettings(env, allowPrivateHttp),
    replayKey: () => readReplayKey(env),
    databaseUrl: () => readDatabaseUrl(env),
    synchronize: () => readDatabaseSynchronize(env, synchronizeByDefault),
  }, true);
}
