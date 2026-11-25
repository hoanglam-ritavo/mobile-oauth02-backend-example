import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { AuthError } from "../errors.ts";
import type { SessionResponse } from "./store.ts";

function context(attemptId: string): Buffer {
  return Buffer.from("rita-mobile-replay:v1:" + attemptId);
}

export function sealReplay(key: Buffer, attemptId: string, result: SessionResponse): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(context(attemptId));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(result), "utf8"), cipher.final()]);
  return ["v1", nonce.toString("base64url"), cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url")].join(".");
}

export function openReplay(key: Buffer, attemptId: string, replay: string): SessionResponse {
  try {
    const [version, nonce, tag, encrypted, extra] = replay.split(".");
    if (version !== "v1" || !nonce || !tag || !encrypted || extra !== undefined) {
      throw new Error("Invalid replay envelope");
    }
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64url"), { authTagLength: 16 });
    decipher.setAAD(context(attemptId));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    const clear = Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]);
    return JSON.parse(clear.toString("utf8")) as SessionResponse;
  } catch {
    throw new AuthError(503, "RITA_LOGIN_RESTART_REQUIRED");
  }
}
