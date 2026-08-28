import "dotenv/config";

const maxRange = Number.parseInt(process.env.MAX_MC_RANGE || "10000", 10);

function parseList(raw) {
  return String(raw || "")
    .split(",")
    .map((item) => item.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

const frontendOrigin = (process.env.FRONTEND_ORIGIN || "http://localhost:3000").trim().replace(/\/$/, "");
const adminOrigin = (process.env.ADMIN_ORIGIN || "http://localhost:3001").trim().replace(/\/$/, "");

export const config = {
  port: Number.parseInt(process.env.PORT || "4000", 10),
  frontendOrigin,
  socrataDomain: (process.env.SOCRATA_DOMAIN || "https://data.transportation.gov").replace(/\/$/, ""),
  datasetId: process.env.SOCRATA_DATASET_ID || "az4n-8mr2",
  appToken: process.env.SOCRATA_APP_TOKEN || "",
  maxMcRange: Number.isFinite(maxRange) ? maxRange : 10000,
  pageSize: Number.parseInt(process.env.PAGE_SIZE || "1000", 10),
  maxResults: Number.parseInt(process.env.MAX_RESULTS || "10000", 10),
  fmcsaWebKey: process.env.FMCSA_WEBKEY || "",
  fmcsaProxy: (process.env.FMCSA_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "").trim(),
  openRouterApiKey: process.env.OPENROUTER_API_KEY || "",
  openRouterModel: process.env.OPENROUTER_MODEL || "nvidia/nemotron-3-ultra-550b-a55b:free",
  mongoUri: (process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/carrier_verifier").trim(),
  authEmail: (process.env.AUTH_EMAIL || "").trim().toLowerCase(),
  authPassword: process.env.AUTH_PASSWORD || "",
  authName: (process.env.AUTH_NAME || "Dispatcher").trim(),
  adminOrigin,
  authAdminEmail: (process.env.AUTH_ADMIN_EMAIL || "").trim().toLowerCase(),
  authAdminPassword: process.env.AUTH_ADMIN_PASSWORD || "",
  authAdminName: (process.env.AUTH_ADMIN_NAME || "Admin").trim(),
  usageTimezone: process.env.USAGE_TIMEZONE || "America/Chicago",
  emailSecret: process.env.EMAIL_SECRET || process.env.AUTH_PASSWORD || "carrier-verifier-email",
  googleClientId: (process.env.GOOGLE_CLIENT_ID || "").trim(),
  googleClientSecret: (process.env.GOOGLE_CLIENT_SECRET || "").trim(),
  googleOAuthRedirectUri:
    (process.env.GOOGLE_OAUTH_REDIRECT_URI || "").trim() ||
    `http://localhost:${Number.parseInt(process.env.PORT || "4000", 10)}/api/email/oauth/callback`,
  corsOrigins: [
    ...new Set([
      frontendOrigin,
      adminOrigin,
      "http://localhost:3000",
      "http://localhost:3001",
      "https://mcscrapperfrontend.vercel.app",
      "https://mcscrapperadmin.vercel.app",
      ...parseList(process.env.CORS_ORIGINS),
    ]),
  ],
};

export function isAllowedCorsOrigin(origin) {
  if (!origin) return true;
  const normalized = String(origin).trim().replace(/\/$/, "");
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(normalized)) return true;
  return config.corsOrigins.includes(normalized);
}
