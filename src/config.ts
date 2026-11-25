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

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value || value !== value.trim()) throw new ConfigError(key, "Configure " + key);
  return value;
}

export function readDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const value = required(env, "DATABASE_URL");
  const url = URL.parse(value);
  if (!url || !["postgresql:", "postgres:"].includes(url.protocol) ||
      !url.hostname || !url.username || url.pathname.length <= 1 ||
      /[\x00-\x20\x7f\\#]/.test(value)) {
    throw new ConfigError("DATABASE_URL", "Configure a PostgreSQL URL with a database and user");
  }
  return value;
}

export function readReplayKey(env: NodeJS.ProcessEnv): Buffer {
  const value = required(env, "OAUTH_REPLAY_KEY");
  const key = Buffer.from(value, "base64url");
  if (key.length !== 32 || key.toString("base64url") !== value) {
    throw new ConfigError("OAUTH_REPLAY_KEY", "Configure a 32-byte base64url key");
  }
  return key;
}

function parseUrl(value: string, key: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(key, "Invalid " + key);
  }
  if (/[\x00-\x20\x7f\\#]/.test(value) || url.username || url.password) {
    throw new ConfigError(key, "Invalid " + key);
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

export function readConfig(
  env: NodeJS.ProcessEnv,
  { allowPrivateHttp = false }: { allowPrivateHttp?: boolean } = {},
): RitaConfig & { host: string; port: number } {
  const apiBaseUrl = required(env, "RITA_API_BASE_URL");
  const api = parseUrl(apiBaseUrl, "RITA_API_BASE_URL");
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(api.hostname);
  const allowsHttp = loopback || (allowPrivateHttp && isPrivateIPv4(api.hostname));
  if (!/^https?:\/\//i.test(apiBaseUrl) || apiBaseUrl.includes("?") ||
      (api.protocol !== "https:" && !(api.protocol === "http:" && allowsHttp))) {
    const allowedHttp = allowPrivateHttp ? "loopback or private IPv4 HTTP" : "loopback HTTP";
    throw new ConfigError("RITA_API_BASE_URL", `RITA_API_BASE_URL must use HTTPS or ${allowedHttp} and have no query`);
  }

  const redirectUri = required(env, "RITA_REDIRECT_URI");
  const redirect = parseUrl(redirectUri, "RITA_REDIRECT_URI");
  const blockedSchemes = [
    "http:", "file:", "data:", "javascript:", "vbscript:", "blob:", "about:",
    "intent:", "content:", "ftp:", "ws:", "wss:", "mailto:", "tel:", "sms:",
  ];
  if (redirect.protocol === "https:" ? !/^https:\/\//i.test(redirectUri) :
      !/^[a-z][a-z0-9+.-]*:\//i.test(redirectUri) || blockedSchemes.includes(redirect.protocol)) {
    throw new ConfigError("RITA_REDIRECT_URI", "RITA_REDIRECT_URI must be an HTTPS or native callback");
  }
  if (!redirect.hostname && !redirect.pathname.startsWith("/")) {
    throw new ConfigError("RITA_REDIRECT_URI", "RITA_REDIRECT_URI must have a host or path");
  }

  const host = env.HOST ?? "127.0.0.1";
  const portValue = env.PORT ?? "3005";
  const port = Number(portValue);
  if (host !== "localhost" && !isIP(host)) throw new ConfigError("HOST", "Invalid HOST");
  if (!/^[0-9]+$/.test(portValue) || port < 1 || port > 65535) throw new ConfigError("PORT", "Invalid PORT");

  return {
    host, port, apiBaseUrl: api.origin + api.pathname.replace(/\/+$/, ""),
    clientId: required(env, "RITA_CLIENT_ID"),
    clientSecret: required(env, "RITA_CLIENT_SECRET"),
    redirectUri,
  };
}
