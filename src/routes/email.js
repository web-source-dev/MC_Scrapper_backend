import { Router } from "express";
import {
  createTemplate,
  deleteTemplate,
  disconnectAccount,
  getEmailStatus,
  getOAuthUrl,
  listSent,
  sendEmail,
  sendBulk,
  setDefaultAccount,
  updateTemplate,
} from "../services/email.js";

export const emailRouter = Router();

emailRouter.get("/status", async (req, res, next) => {
  try {
    await getEmailStatus(req, res);
  } catch (error) {
    next(error);
  }
});

emailRouter.get("/oauth/url", async (req, res, next) => {
  try {
    await getOAuthUrl(req, res);
  } catch (error) {
    next(error);
  }
});

emailRouter.post("/disconnect", async (req, res, next) => {
  try {
    await disconnectAccount(req, res);
  } catch (error) {
    next(error);
  }
});

emailRouter.post("/accounts/default", async (req, res, next) => {
  try {
    await setDefaultAccount(req, res);
  } catch (error) {
    next(error);
  }
});

emailRouter.post("/templates", async (req, res, next) => {
  try {
    await createTemplate(req, res);
  } catch (error) {
    next(error);
  }
});

emailRouter.put("/templates/:id", async (req, res, next) => {
  try {
    await updateTemplate(req, res);
  } catch (error) {
    next(error);
  }
});

emailRouter.delete("/templates/:id", async (req, res, next) => {
  try {
    await deleteTemplate(req, res);
  } catch (error) {
    next(error);
  }
});

emailRouter.post("/send", async (req, res, next) => {
  try {
    await sendEmail(req, res);
  } catch (error) {
    next(error);
  }
});

emailRouter.post("/send-bulk", async (req, res, next) => {
  try {
    await sendBulk(req, res);
  } catch (error) {
    next(error);
  }
});

emailRouter.get("/sent", async (req, res, next) => {
  try {
    await listSent(req, res);
  } catch (error) {
    next(error);
  }
});
