import { Router } from "express";
import { bearerToken, login, logout, readSession, signup } from "../services/auth.js";
import { publicPlans } from "../lib/plans.js";

export const authRouter = Router();

const attempts = new Map();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_TRIES = 8;

function clientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();
  return forwarded || req.ip || req.socket?.remoteAddress || "unknown";
}

function blocked(ip) {
  const now = Date.now();
  const row = attempts.get(ip);
  if (!row) return false;
  if (now - row.start > WINDOW_MS) {
    attempts.delete(ip);
    return false;
  }
  return row.count >= MAX_TRIES;
}

function noteFailure(ip) {
  const now = Date.now();
  const row = attempts.get(ip);
  if (!row || now - row.start > WINDOW_MS) {
    attempts.set(ip, { count: 1, start: now });
    return;
  }
  row.count += 1;
}

authRouter.get("/plans", (_req, res) => {
  res.json({ ok: true, plans: publicPlans() });
});

authRouter.post("/auth/signup", async (req, res, next) => {
  try {
    const ip = clientIp(req);
    if (blocked(ip)) {
      const error = new Error("Too many tries. Wait a few minutes.");
      error.status = 429;
      throw error;
    }
    const body = req.body || {};
    const result = await signup({
      email: body.email,
      password: body.password,
      name: body.name,
      company: body.company,
      phone: body.phone,
      jobTitle: body.jobTitle,
      userAgent: req.headers["user-agent"],
      ip,
    });
    attempts.delete(ip);
    res.status(201).json({ ok: true, ...result });
  } catch (error) {
    if (error.status === 409) noteFailure(clientIp(req));
    next(error);
  }
});

authRouter.post("/auth/login", async (req, res, next) => {
  try {
    const ip = clientIp(req);
    if (blocked(ip)) {
      const error = new Error("Too many sign-in tries. Wait a few minutes.");
      error.status = 429;
      throw error;
    }
    const body = req.body || {};
    const result = await login({
      email: body.email,
      password: body.password,
      userAgent: req.headers["user-agent"],
      ip,
      audience: body.audience === "admin" ? "admin" : "desk",
    });
    attempts.delete(ip);
    res.json({ ok: true, ...result });
  } catch (error) {
    if (error.status === 401) noteFailure(clientIp(req));
    next(error);
  }
});

authRouter.post("/auth/logout", async (req, res, next) => {
  try {
    await logout(bearerToken(req));
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

authRouter.get("/auth/me", async (req, res, next) => {
  try {
    const session = await readSession(bearerToken(req));
    res.json({ ok: true, user: session.user });
  } catch (error) {
    next(error);
  }
});
