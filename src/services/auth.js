import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import { getDb } from "../lib/mongo.js";
import { config } from "../config.js";
import { deskUsage, assertClientClock } from "./usage.js";
import { normalizeEmail, validateLogin, validateSignup } from "../lib/credentials.js";
import { mailboxDomainError } from "../lib/mailboxDomain.js";
import { sendSignupOtp } from "../lib/mailer.js";

const TOKEN_BYTES = 32;
const BCRYPT_ROUNDS = 12;
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_RESEND_MS = 45 * 1000;
const OTP_MAX_SENDS = 6;
const OTP_MAX_ATTEMPTS = 8;

function httpError(message, status = 400, code = null, field = null) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  if (field) error.field = field;
  return error;
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

export async function publicUser(user) {
  const usage = await deskUsage(user);
  return {
    id: String(user._id),
    email: user.email,
    name: user.name || "Dispatcher",
    company: user.company || null,
    phone: user.phone || null,
    role: user.role === "admin" ? "admin" : "dispatcher",
    plan: usage.plan,
    planName: usage.planName,
    dailyLimit: usage.dailyLimit,
    monthlyLimit: usage.monthlyLimit,
    features: usage.features || [],
    usedToday: usage.usedToday,
    usedThisMonth: usage.usedThisMonth,
    remainingDaily: usage.remainingDaily,
    remainingMonthly: usage.remainingMonthly,
    remaining: usage.remaining,
    month: usage.month,
    date: usage.date,
    timezone: usage.timezone,
    serverNow: usage.serverNow,
    serverDate: usage.serverDate,
    history: usage.history,
    totalUsed: usage.totalUsed,
    banned: Boolean(user.banned),
  };
}

async function users() {
  return (await getDb()).collection("users");
}

async function sessions() {
  return (await getDb()).collection("sessions");
}

async function signupOtps() {
  return (await getDb()).collection("signup_otps");
}

function hashOtp(email, otp) {
  return createHash("sha256").update(`${config.emailSecret}:${email}:${otp}`).digest("hex");
}

function otpEqual(left, right) {
  const a = Buffer.from(String(left || ""), "utf8");
  const b = Buffer.from(String(right || ""), "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function publicOtpState(email, expiresAt, lastSentAt = new Date()) {
  const resendAt = new Date(lastSentAt.getTime() + OTP_RESEND_MS);
  return {
    email,
    expiresIn: Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / 1000)),
    resendIn: Math.max(0, Math.ceil((resendAt.getTime() - Date.now()) / 1000)),
  };
}

export async function migrateUserDefaults() {
  const collection = await users();
  await collection.updateMany({ plan: { $exists: false } }, { $set: { plan: "standard" } });
  await collection.updateMany({ role: { $exists: false } }, { $set: { role: "dispatcher" } });
  await collection.updateMany({ banned: { $exists: false } }, { $set: { banned: false } });
}

async function seedAccount({ email, password, name, role, plan }) {
  if (!email || !password) return { seeded: false, reason: "missing-env" };
  if (password.length < 8) return { seeded: false, reason: "weak-password" };

  const collection = await users();
  const existing = await collection.findOne({ email });
  if (existing) return { seeded: false, reason: "exists", email };

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  await collection.insertOne({
    email,
    name,
    passwordHash,
    role,
    plan,
    customDailyLimit: null,
    banned: false,
    emailVerified: true,
    createdAt: new Date(),
    sessionId: null,
  });
  return { seeded: true, email };
}

export async function seedAuthUser() {
  return seedAccount({
    email: config.authEmail,
    password: config.authPassword,
    name: config.authName,
    role: "dispatcher",
    plan: "standard",
  });
}

export async function seedAdminUser() {
  return seedAccount({
    email: config.authAdminEmail,
    password: config.authAdminPassword,
    name: config.authAdminName,
    role: "admin",
    plan: "premium",
  });
}

export async function startSignup({ email, password, name, company, phone, ip }) {
  const checked = validateSignup({ email, password, name, company, phone });
  if (!checked.ok) {
    const field = Object.keys(checked.errors)[0];
    const error = httpError(checked.errors[field], 400, "INVALID_INPUT", field);
    error.errors = checked.errors;
    throw error;
  }

  const { values } = checked;
  const domain = values.email.split("@")[1];
  const mailboxError = await mailboxDomainError(domain);
  if (mailboxError) {
    const error = httpError(mailboxError, 400, "INVALID_INPUT", "email");
    error.errors = { email: mailboxError };
    throw error;
  }

  const collection = await users();
  const existing = await collection.findOne({ email: values.email });
  if (existing) {
    throw httpError("That email is already in use", 409, "EMAIL_TAKEN", "email");
  }

  const pendingCol = await signupOtps();
  const pending = await pendingCol.findOne({ email: values.email });
  const now = new Date();
  if (pending?.lastSentAt && now - pending.lastSentAt < OTP_RESEND_MS) {
    const wait = Math.ceil((OTP_RESEND_MS - (now - pending.lastSentAt)) / 1000);
    const error = httpError(`Wait ${wait}s before requesting another code`, 429, "OTP_COOLDOWN");
    error.resendIn = wait;
    throw error;
  }
  if (pending && pending.sendCount >= OTP_MAX_SENDS) {
    const last = pending.lastSentAt ? new Date(pending.lastSentAt).getTime() : 0;
    if (Date.now() - last < 15 * 60 * 1000) {
      throw httpError("Too many codes sent to this email. Try again later.", 429, "OTP_LOCKED");
    }
    pending.sendCount = 0;
    await pendingCol.updateOne({ email: values.email }, { $set: { sendCount: 0 } });
  }

  const otp = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const expiresAt = new Date(now.getTime() + OTP_TTL_MS);
  const passwordHash = await bcrypt.hash(values.password, BCRYPT_ROUNDS);
  await pendingCol.updateOne(
    { email: values.email },
    {
      $set: {
        email: values.email,
        name: values.name,
        company: values.company,
        phone: values.phone,
        passwordHash,
        otpHash: hashOtp(values.email, otp),
        expiresAt,
        attempts: 0,
        ip: ip || null,
      },
      $setOnInsert: { createdAt: now, sendCount: 0 },
    },
    { upsert: true },
  );

  try {
    await sendSignupOtp({ to: values.email, code: otp, name: values.name });
  } catch (error) {
    console.error("[signup] verification email failed:", error.message);
    if (error.status) throw error;
    throw httpError("We couldn't send a verification email. Try again later.", 503, "MAIL_FAILED");
  }

  await pendingCol.updateOne(
    { email: values.email },
    { $set: { lastSentAt: now }, $inc: { sendCount: 1 } },
  );

  return { ok: true, needsVerification: true, ...publicOtpState(values.email, expiresAt, now) };
}

export async function resendSignupOtp({ email, ip }) {
  const normalized = normalizeEmail(email);
  if (!normalized) throw httpError("Enter your email", 400, "INVALID_INPUT", "email");

  const pendingCol = await signupOtps();
  const pending = await pendingCol.findOne({ email: normalized });
  if (!pending) {
    throw httpError("Start signup again to get a new code.", 400, "OTP_MISSING");
  }

  const now = new Date();
  if (pending.lastSentAt && now - pending.lastSentAt < OTP_RESEND_MS) {
    const wait = Math.ceil((OTP_RESEND_MS - (now - pending.lastSentAt)) / 1000);
    const error = httpError(`Wait ${wait}s before requesting another code`, 429, "OTP_COOLDOWN");
    error.resendIn = wait;
    throw error;
  }
  if ((pending.sendCount || 0) >= OTP_MAX_SENDS) {
    throw httpError("Too many codes sent to this email. Try again later.", 429, "OTP_LOCKED");
  }

  const otp = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const expiresAt = new Date(now.getTime() + OTP_TTL_MS);
  await pendingCol.updateOne(
    { email: normalized },
    {
      $set: {
        otpHash: hashOtp(normalized, otp),
        expiresAt,
        attempts: 0,
        ip: ip || pending.ip || null,
      },
    },
  );

  try {
    await sendSignupOtp({ to: normalized, code: otp, name: pending.name });
  } catch (error) {
    console.error("[signup] resend email failed:", error.message);
    if (error.status) throw error;
    throw httpError("We couldn't send a verification email. Try again later.", 503, "MAIL_FAILED");
  }

  await pendingCol.updateOne(
    { email: normalized },
    { $set: { lastSentAt: now }, $inc: { sendCount: 1 } },
  );

  return { ok: true, ...publicOtpState(normalized, expiresAt, now) };
}

export async function verifySignup({ email, otp, userAgent, ip }) {
  const normalized = normalizeEmail(email);
  const code = String(otp || "").replace(/\D/g, "");
  if (!normalized) throw httpError("Enter your email", 400, "INVALID_INPUT", "email");
  if (!/^\d{6}$/.test(code)) throw httpError("Enter the 6-digit code from your email", 400, "INVALID_INPUT", "otp");

  const pendingCol = await signupOtps();
  const pending = await pendingCol.findOne({ email: normalized });
  if (!pending) {
    throw httpError("That code is wrong or has expired", 400, "OTP_INVALID", "otp");
  }
  if (pending.expiresAt && pending.expiresAt.getTime() < Date.now()) {
    await pendingCol.deleteOne({ email: normalized });
    throw httpError("That code has expired. Request a new one.", 400, "OTP_EXPIRED", "otp");
  }
  if ((pending.attempts || 0) >= OTP_MAX_ATTEMPTS) {
    throw httpError("Too many tries. Request a new code.", 429, "OTP_LOCKED", "otp");
  }

  const expected = pending.otpHash;
  const actual = hashOtp(normalized, code);
  if (!otpEqual(expected, actual)) {
    await pendingCol.updateOne({ email: normalized }, { $inc: { attempts: 1 } });
    throw httpError("That code is wrong or has expired", 400, "OTP_INVALID", "otp");
  }

  const collection = await users();
  const existing = await collection.findOne({ email: normalized });
  if (existing) {
    await pendingCol.deleteOne({ email: normalized });
    throw httpError("That email is already in use", 409, "EMAIL_TAKEN", "email");
  }

  const doc = {
    email: pending.email,
    name: pending.name,
    company: pending.company,
    phone: pending.phone,
    passwordHash: pending.passwordHash,
    role: "dispatcher",
    plan: "free",
    customDailyLimit: null,
    customMonthlyLimit: null,
    banned: false,
    emailVerified: true,
    emailVerifiedAt: new Date(),
    sessionId: null,
    createdAt: new Date(),
  };
  const result = await collection.insertOne(doc);
  await pendingCol.deleteOne({ email: normalized });
  const user = { ...doc, _id: result.insertedId };
  return createSessionForUser(user, { userAgent, ip });
}

async function createSessionForUser(user, { userAgent, ip }) {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const session = {
    id: randomBytes(16).toString("hex"),
    userId: user._id,
    tokenHash: hashToken(token),
    userAgent: String(userAgent || "").slice(0, 300) || null,
    ip: ip || null,
    createdAt: new Date(),
    revoked: false,
  };

  const sessionCol = await sessions();
  await sessionCol.updateMany({ userId: user._id }, { $set: { revoked: true } });
  await sessionCol.insertOne(session);
  await (await users()).updateOne({ _id: user._id }, { $set: { sessionId: session.id, lastLoginAt: new Date() } });

  return {
    token,
    user: await publicUser(user),
  };
}

export async function login({ email, password, userAgent, ip, audience }) {
  const checked = validateLogin({ email, password });
  if (!checked.ok) {
    const field = Object.keys(checked.errors)[0];
    const error = httpError(checked.errors[field], 400, "INVALID_INPUT", field);
    error.errors = checked.errors;
    throw error;
  }
  const normalized = checked.values.email;
  const pass = checked.values.password;

  const collection = await users();
  const user = await collection.findOne({ email: normalized });
  const dummy = "$2a$12$7EqJtq98hPqEX7fNZaFWoOhi5BA1rO/.vY4h3f.3xqKqKqKqKqKqK";
  let ok = false;
  try {
    ok = await bcrypt.compare(pass, user?.passwordHash || dummy);
  } catch {
    ok = false;
  }
  if (!user || !ok) {
    throw httpError("Email or password is wrong", 401, "INVALID_LOGIN");
  }
  if (user.banned) {
    throw httpError("This account is banned. Contact an administrator.", 403, "ACCOUNT_BANNED");
  }
  if (audience === "admin" && user.role !== "admin") {
    throw httpError("This sign-in is for administrators only.", 403, "FORBIDDEN");
  }

  return createSessionForUser(user, { userAgent, ip });
}

export async function logout(token) {
  if (!token) return;
  const sessionCol = await sessions();
  const session = await sessionCol.findOne({ tokenHash: hashToken(token) });
  if (!session) return;
  await sessionCol.deleteMany({ userId: session.userId });
  const collection = await users();
  await collection.updateOne({ _id: session.userId, sessionId: session.id }, { $unset: { sessionId: "" } });
}

export async function readSession(token) {
  if (!token) {
    throw httpError("Sign in to continue", 401, "UNAUTHENTICATED");
  }

  const sessionCol = await sessions();
  const session = await sessionCol.findOne({ tokenHash: hashToken(token) });
  if (!session) {
    throw httpError("Session ended. Sign in again.", 401, "SESSION_ENDED");
  }

  if (session.revoked) {
    await sessionCol.deleteOne({ _id: session._id });
    throw httpError("Signed in on another device. This session was closed.", 401, "SESSION_REPLACED");
  }

  const collection = await users();
  const user = await collection.findOne({ _id: session.userId });
  if (!user) {
    await sessionCol.deleteOne({ _id: session._id });
    throw httpError("Session ended. Sign in again.", 401, "SESSION_ENDED");
  }

  const current = String(user.sessionId || "");
  const mine = String(session.id || "");
  if (!current || !mine || current.length !== mine.length || !timingSafeEqual(Buffer.from(current), Buffer.from(mine))) {
    await sessionCol.deleteOne({ _id: session._id });
    throw httpError("Signed in on another device. This session was closed.", 401, "SESSION_REPLACED");
  }

  if (user.banned) {
    await sessionCol.updateMany({ userId: user._id }, { $set: { revoked: true } });
    throw httpError("This account is banned. Contact an administrator.", 403, "ACCOUNT_BANNED");
  }

  return { user: await publicUser(user), sessionId: session.id, doc: user };
}

export function bearerToken(req) {
  const header = String(req.headers.authorization || "");
  const [type, token] = header.split(" ");
  if (type !== "Bearer" || !token) return null;
  return token;
}

export async function requireAuth(req, _res, next) {
  try {
    const token = bearerToken(req);
    const session = await readSession(token);
    req.user = session.user;
    req.authUser = session.doc;
    req.sessionId = session.sessionId;
    assertClientClock(req.headers["x-client-now"] ?? req.body?.clientNow);
    next();
  } catch (error) {
    next(error);
  }
}

export async function requireAdmin(req, _res, next) {
  try {
    if (req.user?.role !== "admin") {
      throw httpError("Admin access required", 403, "FORBIDDEN");
    }
    next();
  } catch (error) {
    next(error);
  }
}
