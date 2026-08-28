import { getDb } from "../lib/mongo.js";
import { dailyLimitFor, planPublic } from "../lib/plans.js";
import { config } from "../config.js";

function httpError(message, status = 400, code = null) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

export function todayKey(at = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: config.usageTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

export function clockPayload() {
  const now = new Date();
  return {
    serverNow: now.getTime(),
    serverDate: todayKey(now),
    timezone: config.usageTimezone,
  };
}

export function assertClientClock(clientNow) {
  const parsed = Number(clientNow);
  const server = clockPayload();
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw httpError(
      `You can't use this tool until you correct the day and date. Today is ${server.serverDate}.`,
      403,
      "CLOCK_SKEW",
    );
  }
  const clientDate = todayKey(new Date(parsed));
  if (clientDate === server.serverDate) return server;
  const past = clientDate < server.serverDate;
  throw httpError(
    past
      ? `Your computer date is in the past. You can't use this tool until you correct the day and date. Today is ${server.serverDate}.`
      : `Your computer date is wrong. You can't use this tool until you correct the day and date. Today is ${server.serverDate}.`,
    403,
    "CLOCK_SKEW",
  );
}

async function usageCol() {
  return (await getDb()).collection("usage");
}

export function countMatchedMcs(carriers) {
  if (!Array.isArray(carriers)) return 0;
  return carriers.length;
}

export async function usageSnapshot(user) {
  const date = todayKey();
  const limit = dailyLimitFor(user);
  const row = await (await usageCol()).findOne({ userId: user._id, date });
  const used = Math.max(0, Number(row?.used) || 0);
  const remaining = Math.max(0, limit - used);
  return {
    ...planPublic(user),
    date,
    usedToday: used,
    remaining,
  };
}

export async function usageHistory(userId, days = 14) {
  const col = await usageCol();
  const start = todayKey(new Date(Date.now() - (days - 1) * 86400000));
  const rows = await col
    .find({ userId, date: { $gte: start } })
    .project({ date: 1, used: 1, _id: 0 })
    .toArray();
  const byDate = new Map(rows.map((row) => [row.date, Math.max(0, Number(row.used) || 0)]));
  const daysOut = [];
  for (let i = 0; i < days; i += 1) {
    const date = todayKey(new Date(Date.now() - i * 86400000));
    daysOut.push({ date, used: byDate.get(date) || 0 });
  }
  return daysOut;
}

export async function lifetimeUsed(userId) {
  const rows = await (await usageCol())
    .aggregate([{ $match: { userId } }, { $group: { _id: null, used: { $sum: "$used" } } }])
    .toArray();
  return Math.max(0, Number(rows[0]?.used) || 0);
}

export async function deskUsage(user) {
  const snap = await usageSnapshot(user);
  const [history, totalUsed] = await Promise.all([usageHistory(user._id, 14), lifetimeUsed(user._id)]);
  return {
    ...snap,
    ...clockPayload(),
    history,
    totalUsed,
  };
}

export async function usageByUserIds(userIds, date = todayKey()) {
  if (!userIds.length) return new Map();
  const rows = await (await usageCol())
    .find({ date, userId: { $in: userIds } })
    .toArray();
  return new Map(rows.map((row) => [String(row.userId), Math.max(0, Number(row.used) || 0)]));
}

export async function assertCanSearch(user) {
  const snap = await usageSnapshot(user);
  if (snap.dailyLimit <= 0) {
    throw httpError("This account has no daily MC search allowance.", 403, "QUOTA_EXCEEDED");
  }
  if (snap.remaining <= 0) {
    throw httpError(
      `Daily MC limit reached (${snap.usedToday.toLocaleString()} / ${snap.dailyLimit.toLocaleString()} on ${snap.planName}). Try again tomorrow.`,
      429,
      "QUOTA_EXCEEDED",
    );
  }
  return snap;
}

export async function recordSearchUsage(user, charged) {
  const count = Math.max(0, Number(charged) || 0);
  const date = todayKey();
  if (count > 0) {
    await (
      await usageCol()
    ).updateOne(
      { userId: user._id, date },
      {
        $inc: { used: count },
        $set: { updatedAt: new Date() },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true },
    );
  }
  return deskUsage(user);
}

export async function todayTotals() {
  const date = todayKey();
  const rows = await (await usageCol()).find({ date }).toArray();
  const usedToday = rows.reduce((sum, row) => sum + Math.max(0, Number(row.used) || 0), 0);
  return { date, usedToday, activeUsers: rows.filter((row) => (row.used || 0) > 0).length };
}
