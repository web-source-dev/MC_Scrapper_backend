import { createHmac } from "node:crypto";
import { config } from "../config.js";
import { decryptSecret, encryptSecret } from "./secretCrypto.js";

function env(name, fallback = "") {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  let value = String(raw).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim();
  }
  return value;
}

export function googleOAuthMissingKeys() {
  const missing = [];
  if (!env("GOOGLE_CLIENT_ID", config.googleClientId)) missing.push("GOOGLE_CLIENT_ID");
  if (!env("GOOGLE_CLIENT_SECRET", config.googleClientSecret)) missing.push("GOOGLE_CLIENT_SECRET");
  return missing;
}

export function isGoogleOAuthConfigured() {
  return googleOAuthMissingKeys().length === 0;
}

export function getOAuthRedirectUri() {
  return env("GOOGLE_OAUTH_REDIRECT_URI", config.googleOAuthRedirectUri);
}

export function signOAuthState(userId, meta = {}) {
  const payload = Buffer.from(
    JSON.stringify({
      userId: String(userId),
      exp: Date.now() + 15 * 60 * 1000,
      returnOrigin: meta.returnOrigin ? String(meta.returnOrigin).replace(/\/$/, "") : "",
    }),
    "utf8",
  ).toString("base64url");
  const sig = createHmac("sha256", config.emailSecret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyOAuthState(state) {
  const [payload, sig] = String(state || "").split(".");
  if (!payload || !sig) throw new Error("Invalid OAuth state");
  const expected = createHmac("sha256", config.emailSecret).update(payload).digest("base64url");
  if (expected.length !== sig.length) throw new Error("Invalid OAuth state");
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length) throw new Error("Invalid OAuth state");
  let ok = 0;
  for (let i = 0; i < a.length; i += 1) ok |= a[i] ^ b[i];
  if (ok) throw new Error("Invalid OAuth state");
  const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  if (!data?.userId || Number(data.exp) < Date.now()) throw new Error("OAuth state expired");
  return data;
}

export function buildGoogleAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: env("GOOGLE_CLIENT_ID", config.googleClientId),
    redirect_uri: getOAuthRedirectUri(),
    response_type: "code",
    scope: [
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
    ].join(" "),
    access_type: "offline",
    prompt: "consent",
    state: String(state || ""),
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeGoogleCode(code) {
  const body = new URLSearchParams({
    code,
    client_id: env("GOOGLE_CLIENT_ID", config.googleClientId),
    client_secret: env("GOOGLE_CLIENT_SECRET", config.googleClientSecret),
    redirect_uri: getOAuthRedirectUri(),
    grant_type: "authorization_code",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || "OAuth token exchange failed");
  }
  return data;
}

export async function fetchGoogleProfile(accessToken) {
  const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.email) throw new Error("Failed to load Google profile");
  return data;
}

async function refreshGoogleAccessToken(account) {
  const refreshToken = decryptSecret(account.refreshTokenEnc);
  if (!refreshToken) throw new Error("Missing Google refresh token — reconnect Gmail");
  const body = new URLSearchParams({
    client_id: env("GOOGLE_CLIENT_ID", config.googleClientId),
    client_secret: env("GOOGLE_CLIENT_SECRET", config.googleClientSecret),
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || "Failed to refresh Google token");
  }
  account.accessTokenEnc = encryptSecret(data.access_token);
  account.accessTokenExpiresAt = new Date(Date.now() + (Number(data.expires_in) || 3600) * 1000);
  if (data.refresh_token) account.refreshTokenEnc = encryptSecret(data.refresh_token);
  return data.access_token;
}

export async function getOAuthAccessToken(account) {
  const expires = account.accessTokenExpiresAt ? new Date(account.accessTokenExpiresAt).getTime() : 0;
  const access = decryptSecret(account.accessTokenEnc);
  if (access && expires > Date.now() + 60_000) return access;
  return refreshGoogleAccessToken(account);
}

function toBase64Url(str) {
  return Buffer.from(str, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function buildRfc822Message({ from, to, subject, body }) {
  const isHtml = /<[a-z][\s\S]*>/i.test(body);
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${String(subject).replace(/\r?\n/g, " ")}`,
    "MIME-Version: 1.0",
    isHtml ? 'Content-Type: text/html; charset="UTF-8"' : 'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    body,
  ].join("\r\n");
}

export async function sendViaGmailApi(account, { to, subject, body }) {
  const accessToken = await getOAuthAccessToken(account);
  const fromName = String(account.displayName || account.email).replace(/"/g, "");
  const from = `"${fromName}" <${account.email}>`;
  const raw = toBase64Url(buildRfc822Message({ from, to, subject, body }));
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error?.message || `Gmail API send failed (${res.status})`);
  }
  return {
    messageId: data.id || data.messageId || null,
    accepted: [to],
    via: "gmail_api",
  };
}

export function applyTemplate(text, vars = {}) {
  return String(text || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (full, key) => {
    if (!Object.prototype.hasOwnProperty.call(vars, key)) return full;
    const value = vars[key];
    return value == null ? "" : String(value);
  });
}
