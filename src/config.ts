import { isIP } from "node:net";

export interface RitaConfig {
  apiBaseUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value || value !== value.trim()) throw new Error("Configure " + key);
  return value;
}

function parseUrl(value: string, key: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid " + key);
  }
  if (/[\x00-\x20\x7f\\#]/.test(value) || url.username || url.password) {
    throw new Error("Invalid " + key);
  }
  return url;
}

export function readConfig(env: NodeJS.ProcessEnv): RitaConfig & { host: string; port: number } {
  const apiBaseUrl = required(env, "RITA_API_BASE_URL");
  const api = parseUrl(apiBaseUrl, "RITA_API_BASE_URL");
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(api.hostname);
  if (!/^https?:\/\//i.test(apiBaseUrl) || apiBaseUrl.includes("?") ||
      (api.protocol !== "https:" && !(api.protocol === "http:" && loopback))) {
    throw new Error("RITA_API_BASE_URL must use HTTPS or loopback HTTP and have no query");
  }

  const redirectUri = required(env, "RITA_REDIRECT_URI");
  const redirect = parseUrl(redirectUri, "RITA_REDIRECT_URI");
  const blockedSchemes = [
    "http:", "file:", "data:", "javascript:", "vbscript:", "blob:", "about:",
    "intent:", "content:", "ftp:", "ws:", "wss:", "mailto:", "tel:", "sms:",
  ];
  if (redirect.protocol === "https:" ? !/^https:\/\//i.test(redirectUri) :
      !/^[a-z][a-z0-9+.-]*:\//i.test(redirectUri) || blockedSchemes.includes(redirect.protocol)) {
    throw new Error("RITA_REDIRECT_URI must be an HTTPS or native callback");
  }
  if (!redirect.hostname && !redirect.pathname.startsWith("/")) {
    throw new Error("RITA_REDIRECT_URI must have a host or path");
  }

  const host = env.HOST ?? "127.0.0.1";
  const portValue = env.PORT ?? "3005";
  const port = Number(portValue);
  if (host !== "localhost" && !isIP(host)) throw new Error("Invalid HOST");
  if (!/^[0-9]+$/.test(portValue) || port < 1 || port > 65535) throw new Error("Invalid PORT");

  return {
    host, port, apiBaseUrl: api.origin + api.pathname.replace(/\/+$/, ""),
    clientId: required(env, "RITA_CLIENT_ID"),
    clientSecret: required(env, "RITA_CLIENT_SECRET"),
    redirectUri,
  };
}
