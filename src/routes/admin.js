import { Router } from "express";
import {
  adminStats,
  createUser,
  listPlans,
  listUsers,
  setBanned,
  setPassword,
  updateUser,
} from "../services/adminUsers.js";

export const adminRouter = Router();

adminRouter.get("/plans", (_req, res) => {
  res.json({ ok: true, plans: listPlans() });
});

adminRouter.get("/stats", async (_req, res, next) => {
  try {
    const stats = await adminStats();
    res.json({ ok: true, stats });
  } catch (error) {
    next(error);
  }
});

adminRouter.get("/users", async (_req, res, next) => {
  try {
    const users = await listUsers();
    res.json({ ok: true, users });
  } catch (error) {
    next(error);
  }
});

adminRouter.post("/users", async (req, res, next) => {
  try {
    const user = await createUser(req.body || {});
    res.status(201).json({ ok: true, user });
  } catch (error) {
    next(error);
  }
});

adminRouter.patch("/users/:id", async (req, res, next) => {
  try {
    const user = await updateUser(req.params.id, req.body || {}, req.user?.id);
    res.json({ ok: true, user });
  } catch (error) {
    next(error);
  }
});

adminRouter.post("/users/:id/ban", async (req, res, next) => {
  try {
    const user = await setBanned(req.params.id, true, req.body?.reason, req.user?.id);
    res.json({ ok: true, user });
  } catch (error) {
    next(error);
  }
});

adminRouter.post("/users/:id/unban", async (req, res, next) => {
  try {
    const user = await setBanned(req.params.id, false, null, req.user?.id);
    res.json({ ok: true, user });
  } catch (error) {
    next(error);
  }
});

adminRouter.post("/users/:id/password", async (req, res, next) => {
  try {
    const user = await setPassword(req.params.id, req.body?.password);
    res.json({ ok: true, user });
  } catch (error) {
    next(error);
  }
});
