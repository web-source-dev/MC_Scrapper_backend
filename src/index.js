import express from "express";
import cors from "cors";
import { pingMongo } from "./lib/mongo.js";
import { config } from "./config.js";
import { authRouter } from "./routes/auth.js";
import { adminRouter } from "./routes/admin.js";
import { carriersRouter } from "./routes/carriers.js";
import { emailRouter } from "./routes/email.js";
import { oauthCallback } from "./services/email.js";
import { migrateUserDefaults, requireAdmin, requireAuth, seedAdminUser, seedAuthUser } from "./services/auth.js";

const app = express();

app.use(
  cors({
    origin(origin, callback) {
      const allowed = new Set([config.frontendOrigin, config.adminOrigin]);
      if (!origin || /localhost|127\.0\.0\.1/.test(origin) || allowed.has(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-client-now"],
  }),
);
app.use(express.json({ limit: "2mb" }));

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
  res.status(404).json({ ok: false, error: `No route for ${req.method} ${req.path}` });
});

app.use((error, _req, res, _next) => {
  const status = error.status || 500;
  res.status(status).json({
    ok: false,
    error: error.message || "Unexpected server error",
    code: error.code || undefined,
  });
});

app.listen(config.port, async () => {
  await migrateUserDefaults().catch(() => null);
  const seed = await seedAuthUser().catch((error) => ({ seeded: false, reason: error.message }));
  const admin = await seedAdminUser().catch((error) => ({ seeded: false, reason: error.message }));
  console.log(`MC Scrapper API listening on http://localhost:${config.port}`);
  if (seed.seeded) console.log(`Seeded dispatcher login for ${seed.email}`);
  if (admin.seeded) console.log(`Seeded admin login for ${admin.email}`);
});
