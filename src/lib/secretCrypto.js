import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { config } from "../config.js";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;

function key() {
  return createHash("sha256").update(String(config.emailSecret)).digest();
}

export function encryptSecret(plain) {
  if (plain == null || plain === "") return "";
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

export function decryptSecret(payload) {
  if (!payload) return "";
  const parts = String(payload).split(":");
  if (parts.length !== 3) return "";
  const [ivHex, tagHex, dataHex] = parts;
  const decipher = createDecipheriv(ALGO, key(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString("utf8");
}
