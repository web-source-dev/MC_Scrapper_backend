import { config, isAllowedCorsOrigin } from "../config.js";

const ALLOW_METHODS = "GET, POST, PATCH, PUT, DELETE, OPTIONS";
const ALLOW_HEADERS = "Content-Type, Authorization, x-client-now";

function normalizeOrigin(origin) {
  return String(origin || "")
    .trim()
    .replace(/\/$/, "");
}

export function resolveAllowedOrigin(origin) {
  if (!origin) return null;
  const normalized = normalizeOrigin(origin);
  if (!isAllowedCorsOrigin(normalized)) return null;
  return normalized;
}

export function applyCorsHeaders(req, res) {
  const allowed = resolveAllowedOrigin(req.headers.origin);
  if (!allowed) return false;
  res.setHeader("Access-Control-Allow-Origin", allowed);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", ALLOW_METHODS);
  res.setHeader("Access-Control-Allow-Headers", ALLOW_HEADERS);
  res.setHeader("Access-Control-Max-Age", "86400");
  return true;
}

export function corsMiddleware(req, res, next) {
  const origin = req.headers.origin;
  if (origin && !resolveAllowedOrigin(origin)) {
    console.warn(`[cors] blocked origin: ${origin}`);
  } else {
    applyCorsHeaders(req, res);
  }
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
}

export function corsStartupLine() {
  const extras = config.corsOrigins.filter(
    (item) => !/localhost|127\.0\.0\.1|mcscraper\.site/i.test(item),
  );
  const extra = extras.length ? ` + ${extras.join(", ")}` : "";
  return `CORS: https://*.mcscraper.site, localhost${extra}`;
}
