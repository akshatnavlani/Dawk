import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const VERSION = 1;

export function deriveKey(passphrase: string): Buffer {
  return createHash("sha256").update(passphrase).digest();
}

export function encryptSecret(
  plaintext: string,
  passphrase: string,
): { ciphertext: Buffer; nonce: Buffer; version: number } {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(passphrase), nonce);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return { ciphertext: encrypted, nonce, version: VERSION };
}

export function decryptSecret(
  ciphertext: Buffer,
  nonce: Buffer,
  passphrase: string,
): string {
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const data = ciphertext.subarray(0, ciphertext.length - 16);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    deriveKey(passphrase),
    nonce,
  );
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(data), decipher.final()]);
  return plain.toString("utf8");
}
