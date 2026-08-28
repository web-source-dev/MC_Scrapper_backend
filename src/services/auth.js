import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import { getDb } from "../lib/mongo.js";
import { config } from "../config.js";
import { deskUsage, assertClientClock } from "./usage.js";

const TOKEN_BYTES = 32;
const BCRYPT_ROUNDS = 12;

function httpError(message, status = 400, code = null) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
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
    role: user.role === "admin" ? "admin" : "dispatcher",
    plan: usage.plan,
    planName: usage.planName,
    dailyLimit: usage.dailyLimit,
    usedToday: usage.usedToday,
    remaining: usage.remaining,
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

export async function login({ email, password, userAgent, ip, audience }) {
  const normalized = String(email || "")
    .trim()
    .toLowerCase();
  const pass = String(password || "");
  if (!normalized || !pass) {
    throw httpError("Enter your email and password");
  }

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
  await collection.updateOne({ _id: user._id }, { $set: { sessionId: session.id, lastLoginAt: new Date() } });

  return {
    token,
    user: await publicUser(user),
  };
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
