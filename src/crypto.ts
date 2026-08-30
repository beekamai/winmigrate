/*
  Envelope encryption for the secrets profile: scrypt-derived key, AES-256-GCM.
  Layout: magic(4) | salt(16) | iv(12) | tag(16) | ciphertext
*/

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const MAGIC = Buffer.from("WMG1", "ascii");
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  // N=2^15 keeps derivation near ~100ms while staying well above brute-force comfort.
  return scryptSync(passphrase, salt, KEY_LEN, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

export function encrypt(plain: Buffer, passphrase: string): Buffer {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), body]);
}

export function decrypt(blob: Buffer, passphrase: string): Buffer {
  if (!blob.subarray(0, 4).equals(MAGIC)) throw new Error("Not a winmigrate encrypted blob");
  let off = 4;
  const salt = blob.subarray(off, (off += SALT_LEN));
  const iv = blob.subarray(off, (off += IV_LEN));
  const tag = blob.subarray(off, (off += TAG_LEN));
  const body = blob.subarray(off);
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(passphrase, salt), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new Error("Decryption failed — wrong passphrase or corrupted blob");
  }
}
