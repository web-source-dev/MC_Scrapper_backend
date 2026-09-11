import express from "express";
import { pingMongo } from "./lib/mongo.js";
import { corsMiddleware, applyCorsHeaders, corsStartupLine } from "./lib/cors.js";
import { config } from "./config.js";
import { authRouter } from "./routes/auth.js";
import { adminRouter } from "./routes/admin.js";
import { carriersRouter } from "./routes/carriers.js";
import { emailRouter } from "./routes/email.js";
import { oauthCallback } from "./services/email.js";
import { migrateUserDefaults, requireAdmin, requireAuth, seedAdminUser, seedAuthUser } from "./services/auth.js";
import { mailStartupLine, verifyMailer } from "./lib/mailer.js";

const app = express();

app.use(corsMiddleware);
app.use(express.json({ limit: "2mb" }));

/** Lightweight wake ping — no DB; used by frontend/admin on page load to warm free-tier hosts */
app.get("/api/ping", (_req, res) => {
  res.json({ ok: true, service: "mc-scrapper-backend", ts: Date.now() });
});

app.get("/api/health", async (_req, res) => {
  const mongo = await pingMongo();
  res.json({
    ok: true,
    service: "mc-scrapper-backend",
    dataset: config.datasetId,
    soda: {
      query: `${config.socrataDomain}/api/v3/views/${config.datasetId}/query.json`,
      resource: `${config.socrataDomain}/resource/${config.datasetId}.json`,
    },
    qcProxy: Boolean(config.fmcsaProxy),
    mongo,
  });
});

app.use("/api", authRouter);
app.get("/api/email/oauth/callback", async (req, res, next) => {
  try {
    await oauthCallback(req, res);
  } catch (error) {
    next(error);
  }
});
app.use("/api/email", requireAuth, emailRouter);
app.use("/api/admin", requireAuth, requireAdmin, adminRouter);
app.use("/api", requireAuth, carriersRouter);

app.use((req, res) => {
  applyCorsHeaders(req, res);
  res.status(404).json({ ok: false, error: `No route for ${req.method} ${req.path}` });
});

app.use((error, req, res, _next) => {
  applyCorsHeaders(req, res);
  const status = error.status || 500;
  if (status >= 500) {
    console.error(`[api] ${status} ${error.code || "ERROR"}: ${error.message}`);
    if (error.stack) console.error(error.stack);
  }
  const clientMessage =
    status >= 500
      ? "Something went wrong on our side. Try again in a moment."
      : error.message || "Unexpected server error";
  res.status(status).json({
    ok: false,
    error: clientMessage,
    code: error.code || undefined,
    field: error.field || undefined,
    errors: error.errors || undefined,
    resendIn: error.resendIn || undefined,
  });
});

app.listen(config.port, async () => {
  console.log(corsStartupLine());
  await migrateUserDefaults().catch(() => null);
  const seed = await seedAuthUser().catch((error) => ({ seeded: false, reason: error.message }));
  const admin = await seedAdminUser().catch((error) => ({ seeded: false, reason: error.message }));
  console.log(`MC Scrapper API listening on http://localhost:${config.port}`);
  console.log(mailStartupLine());
  await verifyMailer();
  if (seed.seeded) console.log(`Seeded dispatcher login for ${seed.email}`);
  if (admin.seeded) console.log(`Seeded admin login for ${admin.email}`);
});
