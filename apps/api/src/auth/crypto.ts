import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function codeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function sealSession(secret: string): {
  cookieValue: string;
  tokenHash: string;
} {
  const token = newToken();
  const mac = createHmac("sha256", secret).update(token).digest("hex");
  return { cookieValue: `${token}.${mac}`, tokenHash: sha256(token) };
}

export function openSession(
  secret: string,
  cookieValue: string,
): string | null {
  const dot = cookieValue.lastIndexOf(".");
  if (dot <= 0) {
    return null;
  }
  const token = cookieValue.slice(0, dot);
  const mac = cookieValue.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(token).digest("hex");
  const actualBuffer = Buffer.from(mac);
  const expectedBuffer = Buffer.from(expected);
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    return null;
  }
  return sha256(token);
}
