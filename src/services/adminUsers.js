import { ObjectId } from "mongodb";
import bcrypt from "bcryptjs";
import { getDb } from "../lib/mongo.js";
import { isPlanId, planPublic, PLANS } from "../lib/plans.js";
import { todayTotals, usageByUserIds, usageSnapshot } from "./usage.js";

const BCRYPT_ROUNDS = 12;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function httpError(message, status = 400, code = null) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

async function users() {
  return (await getDb()).collection("users");
}

async function sessions() {
  return (await getDb()).collection("sessions");
}

function parseId(id) {
  if (!ObjectId.isValid(String(id || ""))) {
    throw httpError("Unknown user");
  }
  return new ObjectId(String(id));
}

function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

function normalizeName(name) {
  return String(name || "").trim().slice(0, 80) || "Dispatcher";
}

function normalizeRole(role) {
  return role === "admin" ? "admin" : "dispatcher";
}

function normalizePlan(plan) {
  const id = String(plan || "standard");
  if (!isPlanId(id)) throw httpError("Choose a valid plan");
  return id;
}

function normalizeCustomLimit(plan, value) {
  if (plan !== "custom") return null;
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 1_000_000) {
    throw httpError("Custom daily limit must be between 1 and 1,000,000 MCs");
  }
  return parsed;
}

function normalizePassword(password) {
  const pass = String(password || "");
  if (pass.length < 8) throw httpError("Password must be at least 8 characters");
  return pass;
}

async function revokeSessions(userId) {
  await (await sessions()).updateMany({ userId }, { $set: { revoked: true } });
  await (await users()).updateOne({ _id: userId }, { $unset: { sessionId: "" } });
}

async function otherAdminCount(exceptId) {
  return (await users()).countDocuments({
    role: "admin",
    banned: { $ne: true },
    _id: { $ne: exceptId },
  });
}

function asCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function asIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function shapeUser(user, usedToday = 0) {
  const plan = planPublic(user);
  const dailyLimit = asCount(plan.dailyLimit);
  const used = asCount(usedToday);
  const remaining = Math.max(0, dailyLimit - used);
  return {
    id: String(user._id),
    email: user.email,
    name: user.name || "Dispatcher",
    role: user.role === "admin" ? "admin" : "dispatcher",
    plan: plan.plan,
    planName: plan.planName,
    dailyLimit,
    customDailyLimit: plan.plan === "custom" ? dailyLimit : user.customDailyLimit || null,
    usedToday: used,
    remaining,
    banned: Boolean(user.banned),
    bannedAt: asIso(user.bannedAt),
    bannedReason: user.bannedReason || null,
    createdAt: asIso(user.createdAt),
    lastLoginAt: asIso(user.lastLoginAt),
  };
}

export function listPlans() {
  return PLANS;
}

export async function listUsers() {
  const collection = await users();
  const docs = await collection.find({}).sort({ createdAt: -1 }).toArray();
  const usedMap = await usageByUserIds(docs.map((doc) => doc._id));
  return docs.map((doc) => shapeUser(doc, usedMap.get(String(doc._id)) || 0));
}

export async function adminStats() {
  const collection = await users();
  const [total, banned, admins, usage] = await Promise.all([
    collection.countDocuments({}),
    collection.countDocuments({ banned: true }),
    collection.countDocuments({ role: "admin", banned: { $ne: true } }),
    todayTotals(),
  ]);
  return {
    users: total,
    banned,
    admins,
    dispatchers: total - admins,
    ...usage,
    plans: PLANS,
  };
}

export async function createUser(body) {
  const email = normalizeEmail(body.email);
  const name = normalizeName(body.name);
  const password = normalizePassword(body.password);
  const role = normalizeRole(body.role);
  const plan = normalizePlan(body.plan);
  const customDailyLimit = normalizeCustomLimit(plan, body.customDailyLimit);

  if (!EMAIL_RE.test(email)) throw httpError("Enter a valid email");

  const collection = await users();
  const existing = await collection.findOne({ email });
  if (existing) throw httpError("That email is already in use", 409, "EMAIL_TAKEN");

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const doc = {
    email,
    name,
    passwordHash,
    role,
    plan,
    customDailyLimit,
    banned: false,
    sessionId: null,
    createdAt: new Date(),
  };
  const result = await collection.insertOne(doc);
  return shapeUser({ ...doc, _id: result.insertedId }, 0);
}

export async function updateUser(id, body, actorId) {
  const _id = parseId(id);
  const collection = await users();
  const user = await collection.findOne({ _id });
  if (!user) throw httpError("Unknown user", 404);

  const patch = {};
  if (body.name != null) patch.name = normalizeName(body.name);
  if (body.plan != null) {
    patch.plan = normalizePlan(body.plan);
    patch.customDailyLimit = normalizeCustomLimit(patch.plan, body.customDailyLimit ?? user.customDailyLimit);
  } else if (body.customDailyLimit != null && (body.plan || user.plan) === "custom") {
    patch.customDailyLimit = normalizeCustomLimit("custom", body.customDailyLimit);
  }
  if (body.role != null) {
    const role = normalizeRole(body.role);
    if (user.role === "admin" && role !== "admin") {
      if (String(user._id) === String(actorId)) {
        throw httpError("You cannot remove your own admin access");
      }
      if ((await otherAdminCount(user._id)) < 1) {
        throw httpError("Keep at least one admin account");
      }
    }
    patch.role = role;
  }

  if (!Object.keys(patch).length) throw httpError("Nothing to update");

  await collection.updateOne({ _id }, { $set: patch });
  const next = await collection.findOne({ _id });
  const snap = await usageSnapshot(next);
  return shapeUser(next, snap.usedToday);
}

export async function setBanned(id, banned, reason, actorId) {
  const _id = parseId(id);
  if (String(_id) === String(actorId)) {
    throw httpError("You cannot ban your own account");
  }

  const collection = await users();
  const user = await collection.findOne({ _id });
  if (!user) throw httpError("Unknown user", 404);

  if (banned && user.role === "admin" && (await otherAdminCount(user._id)) < 1) {
    throw httpError("Keep at least one admin account");
  }

  if (banned) {
    await collection.updateOne(
      { _id },
      {
        $set: {
          banned: true,
          bannedAt: new Date(),
          bannedReason: String(reason || "").trim().slice(0, 200) || null,
        },
      },
    );
    await revokeSessions(_id);
  } else {
    await collection.updateOne(
      { _id },
      { $set: { banned: false }, $unset: { bannedAt: "", bannedReason: "" } },
    );
  }

  const next = await collection.findOne({ _id });
  const snap = await usageSnapshot(next);
  return shapeUser(next, snap.usedToday);
}

export async function setPassword(id, password) {
  const _id = parseId(id);
  const collection = await users();
  const user = await collection.findOne({ _id });
  if (!user) throw httpError("Unknown user", 404);
  const passwordHash = await bcrypt.hash(normalizePassword(password), BCRYPT_ROUNDS);
  await collection.updateOne({ _id }, { $set: { passwordHash } });
  await revokeSessions(_id);
  const next = await collection.findOne({ _id });
  const snap = await usageSnapshot(next);
  return shapeUser(next, snap.usedToday);
}
